/**
 * Split Dictionary Entries into Sub-Entries
 *
 * Takes DictionaryEntry records and splits them into word-level
 * DictionarySubEntry records using parser-specific logic.
 *
 * Parser registry:
 *   - identityParser (Tier 1): 1:1 copy — al-wasit, tarifat, asas-al-balagha
 *   - parenHeadwordParser (Tier 2): split on (headword) patterns — mukhtar,
 *     taj-al-arus, misbah, al-sihah, mughrib
 *
 * All other slugs default to identityParser.
 *
 * Usage:
 *   bun run pipelines/import/dictionary/split-sub-entries.ts \
 *     --slug=mukhtar [--all] [--sample=20] [--dry-run]
 */

import "../../env";
import { prisma } from "../../../src/db";
import {
  normalizeArabic,
  normalizeArabicLight,
  hasTashkeel,
  extractArabicRoot,
  stripDefiniteArticle,
} from "../../../src/utils/arabic-text";

const BATCH_INSERT_SIZE = 500;
const ARABIC_RE = /[\u0600-\u06FF]/;

// ── Parser Registry ──

type ParserTier = "identity" | "paren";

const PARSER_REGISTRY: Record<string, ParserTier> = {
  // Tier 1: identity (1:1)
  "al-wasit": "identity",
  tarifat: "identity",
  "asas-al-balagha": "identity",
  // Tier 2: paren headword split
  mukhtar: "paren",
  "taj-al-arus": "paren",
  misbah: "paren",
  "al-sihah": "paren",
  mughrib: "paren",
};

interface SubEntryData {
  headword: string;
  headwordNormalized: string;
  headwordVocalized: string;
  root: string;
  rootNormalized: string;
  definitionPlain: string;
  definitionHtml: string;
  position: number;
  entryId: number;
  bookId: string | null;
  pageNumber: number | null;
}

interface DictEntry {
  id: number;
  headword: string;
  headwordNormalized: string;
  root: string;
  rootNormalized: string;
  definitionPlain: string;
  definitionHtml: string;
  bookId: string | null;
  startPage: number | null;
}

/**
 * Extract root from headword.
 */
function extractRoot(headword: string): { root: string; rootNormalized: string } {
  const normalized = normalizeArabic(headword);
  const stripped = stripDefiniteArticle(headword);

  const extracted = extractArabicRoot(stripped) || extractArabicRoot(normalized);
  if (extracted && extracted.length >= 3 && extracted.length <= 4 && ARABIC_RE.test(extracted)) {
    return { root: extracted, rootNormalized: extracted };
  }

  const normalizedStripped = normalizeArabic(stripped);
  if (normalizedStripped.length >= 3 && normalizedStripped.length <= 4 && ARABIC_RE.test(normalizedStripped)) {
    return { root: normalizedStripped, rootNormalized: normalizedStripped };
  }

  return { root: "", rootNormalized: "" };
}

/**
 * Identity parser: creates one sub-entry per entry (1:1 copy).
 */
function identityParser(entry: DictEntry): SubEntryData[] {
  return [
    {
      headword: entry.headword,
      headwordNormalized: entry.headwordNormalized,
      headwordVocalized: hasTashkeel(entry.headword) ? normalizeArabicLight(entry.headword) : "",
      root: entry.root,
      rootNormalized: entry.rootNormalized,
      definitionPlain: entry.definitionPlain,
      definitionHtml: entry.definitionHtml,
      position: 0,
      entryId: entry.id,
      bookId: entry.bookId,
      pageNumber: entry.startPage,
    },
  ];
}

/**
 * Paren headword parser: splits on (arabicWord) patterns in definition text.
 * Produces one sub-entry per parenthesized headword found.
 *
 * Pattern: looks for (headword) where headword is Arabic letters, possibly with
 * tashkeel, spaces (for multi-word), or ال prefix. The text following until the
 * next (headword) match becomes that sub-entry's definition.
 */
function parenHeadwordParser(entry: DictEntry): SubEntryData[] {
  const text = entry.definitionPlain;

  // Match parenthesized Arabic words: (كتب), (الكِتَاب), etc.
  const parenRe = /\(([\u0600-\u06FF\u064B-\u065F\u0670][\u0600-\u06FF\u064B-\u065F\u0670\s]{0,30})\)/g;

  const matches: Array<{ headword: string; index: number; fullMatchEnd: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = parenRe.exec(text)) !== null) {
    const hw = m[1].trim();
    // Validate: must contain at least 2 Arabic letters
    const arabicOnly = hw.replace(/[^\u0600-\u06FF]/g, "");
    if (arabicOnly.length >= 2) {
      matches.push({
        headword: hw,
        index: m.index,
        fullMatchEnd: m.index + m[0].length,
      });
    }
  }

  // If no matches or only 1, fall back to identity
  if (matches.length <= 1) {
    return identityParser(entry);
  }

  const subEntries: SubEntryData[] = [];

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const defStart = match.fullMatchEnd;
    const defEnd = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const def = text.slice(defStart, defEnd).trim();

    if (def.length < 3) continue;

    // Try to extract root from this sub-headword; fall back to parent's root
    const { root, rootNormalized } = extractRoot(match.headword);
    const headwordNormalized = normalizeArabic(match.headword);
    const headwordVocalized = hasTashkeel(match.headword)
      ? normalizeArabicLight(match.headword)
      : "";

    subEntries.push({
      headword: match.headword,
      headwordNormalized,
      headwordVocalized,
      root: root || entry.root,
      rootNormalized: rootNormalized || entry.rootNormalized,
      definitionPlain: def,
      definitionHtml: def,
      position: i,
      entryId: entry.id,
      bookId: entry.bookId,
      pageNumber: entry.startPage,
    });
  }

  // If parsing produced nothing, fall back to identity
  return subEntries.length > 0 ? subEntries : identityParser(entry);
}

function getParser(slug: string): (entry: DictEntry) => SubEntryData[] {
  const tier = PARSER_REGISTRY[slug] || "identity";
  return tier === "paren" ? parenHeadwordParser : identityParser;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let slug = "";
  let all = false;
  let sample = 0;
  let dryRun = false;

  for (const arg of args) {
    if (arg.startsWith("--slug=")) slug = arg.slice(7);
    else if (arg === "--all") all = true;
    else if (arg.startsWith("--sample=")) sample = parseInt(arg.slice(9), 10);
    else if (arg === "--dry-run") dryRun = true;
  }

  if (!slug && !all) {
    console.error("Usage: bun run split-sub-entries.ts --slug=<slug> [--all] [--sample=20] [--dry-run]");
    process.exit(1);
  }

  return { slug, all, sample, dryRun };
}

async function processSource(
  slug: string,
  dryRun: boolean,
  sample: number,
): Promise<{ slug: string; entries: number; subEntries: number; ratio: string }> {
  const source = await prisma.dictionarySource.findUnique({ where: { slug } });
  if (!source) {
    console.error(`Source "${slug}" not found`);
    return { slug, entries: 0, subEntries: 0, ratio: "N/A" };
  }

  const parser = getParser(slug);
  const tierName = PARSER_REGISTRY[slug] || "identity";
  console.log(`\nProcessing "${slug}" (source ${source.id}, parser: ${tierName})`);

  // Fetch entries
  const entries: DictEntry[] = await prisma.dictionaryEntry.findMany({
    where: { sourceId: source.id },
    select: {
      id: true,
      headword: true,
      headwordNormalized: true,
      root: true,
      rootNormalized: true,
      definitionPlain: true,
      definitionHtml: true,
      bookId: true,
      startPage: true,
    },
    orderBy: { id: "asc" },
  });

  if (entries.length === 0) {
    console.log(`  No entries found for "${slug}"`);
    return { slug, entries: 0, subEntries: 0, ratio: "N/A" };
  }

  console.log(`  Found ${entries.length} entries`);

  // Parse all entries
  const allSubEntries: SubEntryData[] = [];
  const entriesToProcess = sample > 0 ? entries.slice(0, sample) : entries;

  for (const entry of entriesToProcess) {
    const subs = parser(entry);
    allSubEntries.push(...subs);
  }

  const ratio = (allSubEntries.length / entriesToProcess.length).toFixed(1);
  console.log(`  Generated ${allSubEntries.length} sub-entries (${ratio}x expansion)`);

  if (sample > 0) {
    console.log(`\n  Sample sub-entries (from ${sample} entries):`);
    for (const se of allSubEntries.slice(0, 30)) {
      const defPreview =
        se.definitionPlain.length > 60
          ? se.definitionPlain.slice(0, 60) + "..."
          : se.definitionPlain;
      console.log(`    [${se.position}] ${se.headword} [${se.rootNormalized}]: ${defPreview}`);
    }
  }

  if (dryRun) {
    console.log(`  DRY RUN: would insert ${allSubEntries.length} sub-entries for "${slug}"`);
    return { slug, entries: entriesToProcess.length, subEntries: allSubEntries.length, ratio };
  }

  // Delete existing entry-linked sub-entries for this source
  // Preserve LLM-extracted ones (where entryId IS NULL)
  const deleted = await prisma.dictionarySubEntry.deleteMany({
    where: {
      sourceId: source.id,
      entryId: { not: null },
    },
  });
  console.log(`  Deleted ${deleted.count} existing entry-linked sub-entries`);

  // Batch insert
  let inserted = 0;
  for (let i = 0; i < allSubEntries.length; i += BATCH_INSERT_SIZE) {
    const batch = allSubEntries.slice(i, i + BATCH_INSERT_SIZE);
    await prisma.dictionarySubEntry.createMany({
      data: batch.map((se) => ({
        sourceId: source.id,
        entryId: se.entryId,
        headword: se.headword,
        headwordNormalized: se.headwordNormalized,
        headwordVocalized: se.headwordVocalized,
        root: se.root,
        rootNormalized: se.rootNormalized,
        definitionPlain: se.definitionPlain,
        definitionHtml: se.definitionHtml,
        position: se.position,
        bookId: se.bookId,
        pageNumber: se.pageNumber,
      })),
    });
    inserted += batch.length;
    if (inserted % 5000 === 0 || inserted === allSubEntries.length) {
      console.log(`    Inserted ${inserted}/${allSubEntries.length}`);
    }
  }

  console.log(`  Done. Inserted ${inserted} sub-entries for "${slug}".`);
  return { slug, entries: entriesToProcess.length, subEntries: inserted, ratio };
}

async function main() {
  const { slug, all, sample, dryRun } = parseArgs();

  if (dryRun) console.log("--- DRY RUN ---\n");

  const results: Array<{ slug: string; entries: number; subEntries: number; ratio: string }> = [];

  if (all) {
    // Process all sources that have entries
    const sources = await prisma.dictionarySource.findMany({
      orderBy: { slug: "asc" },
    });
    for (const source of sources) {
      const count = await prisma.dictionaryEntry.count({
        where: { sourceId: source.id },
      });
      if (count > 0) {
        const result = await processSource(source.slug, dryRun, sample);
        results.push(result);
      }
    }
  } else {
    const result = await processSource(slug, dryRun, sample);
    results.push(result);
  }

  // Summary
  console.log("\n═══ Summary ═══");
  let totalEntries = 0;
  let totalSubs = 0;
  for (const r of results) {
    console.log(`  ${r.slug}: ${r.entries} entries → ${r.subEntries} sub-entries (${r.ratio}x)`);
    totalEntries += r.entries;
    totalSubs += r.subEntries;
  }
  console.log(`  TOTAL: ${totalEntries} entries → ${totalSubs} sub-entries`);
}

main()
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
