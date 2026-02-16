/**
 * Import Dictionary Entries from Book Pages
 *
 * Parses book pages from the Page table using regex patterns to detect
 * entry headwords, then inserts into DictionaryEntry.
 *
 * Usage:
 *   bun run pipelines/import/dictionary/import-entries.ts \
 *     --book-id=23193 --slug=mukhtar --name-ar="مختار الصحاح" \
 *     --name-en="Mukhtar al-Sihah" --entry-pattern=spaced [--dry-run]
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

// Arabic letter range
const ARABIC_RE = /[\u0600-\u06FF]/;
const ARABIC_WORD_RE = /[\u0600-\u06FF\u064B-\u065F\u0670]+/;

// ── Entry pattern definitions ──

type EntryPattern =
  | "standard"
  | "spaced"
  | "parens"
  | "maqayis"
  | "brackets"
  | "wasit"
  | "spaced-standalone"
  | "html-title"
  | "colon";

interface PatternMatch {
  headword: string;
  /** Index within the line where the definition text starts */
  defStart: number;
}

/**
 * Try to match an entry headword pattern on a line.
 * Returns the extracted headword and start-of-definition index, or null.
 */
function matchPattern(line: string, pattern: EntryPattern): PatternMatch | null {
  switch (pattern) {
    // Arabic word + colon: "كتاب: ..."
    case "standard": {
      const m = line.match(/^([\u0600-\u06FF\u064B-\u065F\u0670]{2,}):\s/);
      if (m) return { headword: m[1], defStart: m[0].length };
      return null;
    }

    // Spaced root letters + colon: "ك ت ب: ..."
    case "spaced": {
      const m = line.match(/^(([\u0600-\u06FF]\s){2,}[\u0600-\u06FF]):\s/);
      if (m) {
        // Join the spaced letters: "ك ت ب" → "كتب"
        const headword = m[1].replace(/\s/g, "");
        return { headword, defStart: m[0].length };
      }
      return null;
    }

    // Parenthesized root + colon: "(كتب): ..."
    case "parens": {
      const m = line.match(/^\(([\u0600-\u06FF\u064B-\u065F\u0670\s]+)\):\s/);
      if (m) return { headword: m[1].trim(), defStart: m[0].length };
      return null;
    }

    // Maqayis: standalone 2-3 letter Arabic word on own line
    case "maqayis": {
      const trimmed = line.trim();
      // Must be ONLY a short Arabic root (2-3 letters, possibly with tashkeel)
      if (/^[\u0600-\u06FF\u064B-\u065F\u0670]{2,6}$/.test(trimmed)) {
        // Strip tashkeel to check actual letter count
        const stripped = trimmed.replace(/[\u064B-\u065F\u0670]/g, "");
        if (stripped.length >= 2 && stripped.length <= 3) {
          return { headword: trimmed, defStart: trimmed.length };
        }
      }
      return null;
    }

    // Square-bracketed headword: "[كتاب] ..."
    case "brackets": {
      const m = line.match(/^\[([\u0600-\u06FF\u064B-\u065F\u0670\s]+)\]/);
      if (m) return { headword: m[1].trim(), defStart: m[0].length };
      return null;
    }

    // Wasit: parenthesized headword at start: "(كتب) ..."
    case "wasit": {
      const m = line.match(/^\(([\u0600-\u06FF\u064B-\u065F\u0670]+)\)/);
      if (m) return { headword: m[1], defStart: m[0].length };
      return null;
    }

    // Spaced Arabic letters on own line (no colon): "ك ت ب"
    case "spaced-standalone": {
      const trimmed = line.trim();
      const m = trimmed.match(/^([\u0600-\u06FF]\s){2,}[\u0600-\u06FF]$/);
      if (m) {
        const headword = trimmed.replace(/\s/g, "");
        return { headword, defStart: trimmed.length };
      }
      return null;
    }

    // HTML title span: <span data-type="title">headword</span>
    case "html-title": {
      const m = line.match(/<span[^>]*data-type="title"[^>]*>([\s\S]*?)<\/span>/);
      if (m) {
        // Strip any nested HTML tags from the headword
        const headword = m[1].replace(/<[^>]+>/g, "").trim();
        if (headword.length > 0 && ARABIC_RE.test(headword)) {
          return { headword, defStart: m.index! + m[0].length };
        }
      }
      return null;
    }

    // Multi-word Arabic term + colon (longer phrases): "عبد الله: ..."
    case "colon": {
      const m = line.match(/^([\u0600-\u06FF\u064B-\u065F\u0670][\u0600-\u06FF\u064B-\u065F\u0670\s]{2,}):\s/);
      if (m) {
        const hw = m[1].trim();
        // Must have at least 2 Arabic characters and be reasonable length
        const arabicOnly = hw.replace(/[^\u0600-\u06FF]/g, "");
        if (arabicOnly.length >= 2 && hw.length <= 60) {
          return { headword: hw, defStart: m[0].length };
        }
      }
      return null;
    }
  }
}

/**
 * Extract root from headword using morphological analysis.
 */
function extractRoot(headword: string): { root: string; rootNormalized: string } {
  const normalized = normalizeArabic(headword);
  const stripped = stripDefiniteArticle(headword);

  const extracted = extractArabicRoot(stripped) || extractArabicRoot(normalized);
  if (extracted && extracted.length >= 3 && extracted.length <= 4 && ARABIC_RE.test(extracted)) {
    return { root: extracted, rootNormalized: extracted };
  }

  // For short words (3-4 letters), use normalized form as root
  const normalizedStripped = normalizeArabic(stripped);
  if (normalizedStripped.length >= 3 && normalizedStripped.length <= 4 && ARABIC_RE.test(normalizedStripped)) {
    return { root: normalizedStripped, rootNormalized: normalizedStripped };
  }

  return { root: "", rootNormalized: "" };
}

function parseArgs() {
  const args = process.argv.slice(2);
  let bookId = "";
  let slug = "";
  let nameAr = "";
  let nameEn = "";
  let entryPattern: EntryPattern | "" = "";
  let dryRun = false;

  for (const arg of args) {
    if (arg.startsWith("--book-id=")) bookId = arg.slice(10);
    else if (arg.startsWith("--slug=")) slug = arg.slice(7);
    else if (arg.startsWith("--name-ar=")) nameAr = arg.slice(10);
    else if (arg.startsWith("--name-en=")) nameEn = arg.slice(10);
    else if (arg.startsWith("--entry-pattern=")) entryPattern = arg.slice(16) as EntryPattern;
    else if (arg === "--dry-run") dryRun = true;
  }

  if (!bookId || !slug || !nameAr || !nameEn || !entryPattern) {
    console.error(
      "Usage: bun run import-entries.ts --book-id=<id> --slug=<slug> " +
        '--name-ar="<arabic>" --name-en="<english>" --entry-pattern=<pattern> [--dry-run]',
    );
    console.error(
      "\nPatterns: standard, spaced, parens, maqayis, brackets, wasit, spaced-standalone, html-title, colon",
    );
    process.exit(1);
  }

  return { bookId, slug, nameAr, nameEn, entryPattern: entryPattern as EntryPattern, dryRun };
}

interface PendingEntry {
  headword: string;
  headwordNormalized: string;
  headwordVocalized: string;
  root: string;
  rootNormalized: string;
  definitionLines: string[];
  definitionHtmlLines: string[];
  startPage: number;
  endPage: number;
}

async function main() {
  const { bookId, slug, nameAr, nameEn, entryPattern, dryRun } = parseArgs();

  console.log(`Importing dictionary entries for "${slug}" (book ${bookId})`);
  console.log(`  Pattern: ${entryPattern}`);
  console.log(`  Name: ${nameAr} / ${nameEn}`);

  // 1. Upsert DictionarySource
  const source = await prisma.dictionarySource.upsert({
    where: { slug },
    create: { slug, nameArabic: nameAr, nameEnglish: nameEn, bookId },
    update: { nameArabic: nameAr, nameEnglish: nameEn, bookId },
  });
  console.log(`Source: id=${source.id}, slug=${source.slug}`);

  // 2. Fetch all pages for the book
  const pages = await prisma.page.findMany({
    where: { bookId },
    select: { pageNumber: true, contentPlain: true, contentHtml: true },
    orderBy: { pageNumber: "asc" },
  });

  if (pages.length === 0) {
    console.error(`No pages found for book ${bookId}`);
    process.exit(1);
  }
  console.log(`Found ${pages.length} pages`);

  // 3. Parse pages to extract entries
  const useHtml = entryPattern === "html-title";
  const entries: Array<{
    headword: string;
    headwordNormalized: string;
    headwordVocalized: string;
    root: string;
    rootNormalized: string;
    definitionPlain: string;
    definitionHtml: string;
    startPage: number;
    endPage: number;
    contentHash: string;
  }> = [];

  let current: PendingEntry | null = null;

  function flushEntry() {
    if (!current) return;
    const defPlain = current.definitionLines.join("\n").trim();
    const defHtml = current.definitionHtmlLines.join("\n").trim();
    if (defPlain.length < 3) {
      current = null;
      return;
    }

    // Build a content hash for dedup
    const hash = `${current.headwordNormalized}:${current.startPage}`;

    entries.push({
      headword: current.headword,
      headwordNormalized: current.headwordNormalized,
      headwordVocalized: current.headwordVocalized,
      root: current.root,
      rootNormalized: current.rootNormalized,
      definitionPlain: defPlain,
      definitionHtml: defHtml,
      startPage: current.startPage,
      endPage: current.endPage,
      contentHash: hash,
    });
    current = null;
  }

  for (const page of pages) {
    const content = useHtml ? page.contentHtml : page.contentPlain;
    const lines = content.split("\n");

    for (const line of lines) {
      const match = matchPattern(line, entryPattern);

      if (match) {
        // Flush previous entry
        flushEntry();

        // Start new entry
        const { root, rootNormalized } = extractRoot(match.headword);
        const headwordNormalized = normalizeArabic(match.headword);
        const headwordVocalized = hasTashkeel(match.headword)
          ? normalizeArabicLight(match.headword)
          : "";

        current = {
          headword: match.headword,
          headwordNormalized,
          headwordVocalized,
          root,
          rootNormalized,
          definitionLines: [],
          definitionHtmlLines: [],
          startPage: page.pageNumber,
          endPage: page.pageNumber,
        };

        // Add rest of line as definition start
        const defText = line.slice(match.defStart).trim();
        if (defText) {
          current.definitionLines.push(defText);
          current.definitionHtmlLines.push(defText);
        }
      } else if (current) {
        // Accumulate definition text
        const trimmed = line.trim();
        if (trimmed) {
          current.definitionLines.push(trimmed);
          current.definitionHtmlLines.push(line);
          current.endPage = page.pageNumber;
        }
      }
    }
  }
  // Flush last entry
  flushEntry();

  console.log(`Parsed ${entries.length} entries`);

  // Deduplicate by contentHash
  const seen = new Set<string>();
  const dedupEntries = entries.filter((e) => {
    if (seen.has(e.contentHash)) return false;
    seen.add(e.contentHash);
    return true;
  });
  const dupes = entries.length - dedupEntries.length;
  if (dupes > 0) console.log(`Removed ${dupes} duplicates, ${dedupEntries.length} unique entries`);

  // Stats
  const withRoot = dedupEntries.filter((e) => e.rootNormalized.length > 0).length;
  const withVocalized = dedupEntries.filter((e) => e.headwordVocalized.length > 0).length;
  const avgDefLen = dedupEntries.length > 0
    ? Math.round(dedupEntries.reduce((s, e) => s + e.definitionPlain.length, 0) / dedupEntries.length)
    : 0;
  console.log(
    `Stats: ${withRoot}/${dedupEntries.length} have root (${((withRoot / dedupEntries.length) * 100).toFixed(1)}%), ` +
      `${withVocalized} vocalized, avg def length: ${avgDefLen} chars`,
  );

  if (dryRun) {
    console.log("\n--- DRY RUN ---");
    console.log(`Would insert ${dedupEntries.length} entries for source "${slug}"`);
    console.log("\nSample entries (first 15):");
    for (const e of dedupEntries.slice(0, 15)) {
      const defPreview =
        e.definitionPlain.length > 80
          ? e.definitionPlain.slice(0, 80) + "..."
          : e.definitionPlain;
      console.log(`  p${e.startPage}-${e.endPage} ${e.headword} [${e.rootNormalized}]: ${defPreview}`);
    }
    return;
  }

  // 4. Delete existing entries for this source
  const deleted = await prisma.dictionaryEntry.deleteMany({
    where: { sourceId: source.id },
  });
  console.log(`Deleted ${deleted.count} existing entries for "${slug}"`);

  // 5. Batch insert
  let inserted = 0;
  for (let i = 0; i < dedupEntries.length; i += BATCH_INSERT_SIZE) {
    const batch = dedupEntries.slice(i, i + BATCH_INSERT_SIZE);
    await prisma.dictionaryEntry.createMany({
      data: batch.map((e) => ({
        sourceId: source.id,
        headword: e.headword,
        headwordNormalized: e.headwordNormalized,
        headwordVocalized: e.headwordVocalized,
        root: e.root,
        rootNormalized: e.rootNormalized,
        definitionPlain: e.definitionPlain,
        definitionHtml: e.definitionHtml,
        contentHash: e.contentHash,
        bookId,
        startPage: e.startPage,
        endPage: e.endPage,
      })),
    });
    inserted += batch.length;
    if (inserted % 2000 === 0 || inserted === dedupEntries.length) {
      console.log(`  Inserted ${inserted}/${dedupEntries.length}`);
    }
  }

  console.log(`\nDone. Inserted ${inserted} entries for "${slug}".`);
}

main()
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
