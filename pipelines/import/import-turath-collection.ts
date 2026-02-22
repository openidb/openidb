/**
 * Generic Turath Hadith Import
 *
 * Reads chunk-NNN.extracted.json files, deduplicates, DELETES all existing
 * data for the collection, then creates new HadithBooks from kitab headings
 * and inserts all parsed hadiths.
 *
 * Usage:
 *   bun run pipelines/import/import-turath-collection.ts --collection=abudawud --dry-run
 *   bun run pipelines/import/import-turath-collection.ts --collection=abudawud --force
 */

import "../env";
import { prisma } from "../../src/db";
import { normalizeArabicText } from "../../src/embeddings";
import { hashHadith } from "../../src/utils/content-hash";
import * as fs from "fs";
import * as path from "path";
import { getConfig, ALL_REMAINING, type CollectionConfig } from "./turath-hadith-configs";

const BATCH_SIZE = 500;

// =============================================================================
// Types
// =============================================================================

interface ExtractedHadith {
  hadithNumber: string;
  sequentialNumber: number;
  parenthesizedNumber: number;
  isnad: string | null;
  matn: string;
  kitab: string | null;
  bab: string | null;
  footnotes: string | null;
  pageStart: number;
  pageEnd: number;
  isChainVariation: boolean;
}

interface ExtractedChunk {
  chunkId: number;
  lastKitab: string | null;
  lastBab: string | null;
  hadiths: ExtractedHadith[];
}

interface ReplacementReport {
  collection: string;
  totalExtracted: number;
  totalDeduplicated: number;
  kitabCount: number;
  kitabs: Array<{ name: string; hadithCount: number }>;
  deletedTranslations: number;
  deletedHadiths: number;
  deletedBooks: number;
  createdBooks: number;
  insertedHadiths: number;
}

// =============================================================================
// Chunk Loading & Deduplication
// =============================================================================

function loadExtractedChunks(cacheDir: string): ExtractedChunk[] {
  const files = fs
    .readdirSync(cacheDir)
    .filter((f) => f.match(/^chunk-\d+\.extracted\.json$/))
    .sort();

  if (files.length === 0) {
    console.error("No .extracted.json files found in", cacheDir);
    console.error("Run parse-turath-collection.ts first.");
    process.exit(1);
  }

  console.log(`Found ${files.length} extracted chunk files.`);

  const chunks: ExtractedChunk[] = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(cacheDir, file), "utf-8");
    const chunk: ExtractedChunk = JSON.parse(content);
    chunks.push(chunk);
  }

  return chunks;
}

/**
 * Deduplicate hadiths across chunks (overlap pages may produce duplicates).
 * Uses hadithNumber + pageStart as dedup key.
 * Prefers the version from the chunk where the hadith is most "middle".
 */
function deduplicateHadiths(chunks: ExtractedChunk[]): ExtractedHadith[] {
  const seen = new Map<
    string,
    {
      hadith: ExtractedHadith;
      chunkId: number;
      position: number;
      totalInChunk: number;
    }
  >();

  for (const chunk of chunks) {
    for (let i = 0; i < chunk.hadiths.length; i++) {
      const h = chunk.hadiths[i];
      const key = `${h.hadithNumber}-${h.pageStart}`;
      const existing = seen.get(key);

      if (!existing) {
        seen.set(key, {
          hadith: h,
          chunkId: chunk.chunkId,
          position: i,
          totalInChunk: chunk.hadiths.length,
        });
        continue;
      }

      // Prefer version with longer text content (less likely truncated)
      const existingLen = (existing.hadith.isnad || "").length + existing.hadith.matn.length;
      const newLen = (h.isnad || "").length + h.matn.length;

      if (newLen > existingLen) {
        seen.set(key, {
          hadith: h,
          chunkId: chunk.chunkId,
          position: i,
          totalInChunk: chunk.hadiths.length,
        });
      } else if (newLen === existingLen) {
        // Tiebreaker: prefer version more "middle" in its chunk
        const existingMidDist = Math.abs(
          existing.position - existing.totalInChunk / 2
        );
        const newMidDist = Math.abs(i - chunk.hadiths.length / 2);

        if (newMidDist < existingMidDist) {
          seen.set(key, {
            hadith: h,
            chunkId: chunk.chunkId,
            position: i,
            totalInChunk: chunk.hadiths.length,
          });
        }
      }
    }
  }

  // Sort by hadith number (numeric)
  return [...seen.values()]
    .map((v) => v.hadith)
    .sort((a, b) => {
      const numA =
        parseInt(a.hadithNumber.replace(/[^0-9]/g, ""), 10) || 0;
      const numB =
        parseInt(b.hadithNumber.replace(/[^0-9]/g, ""), 10) || 0;
      if (numA !== numB) return numA - numB;
      return a.pageStart - b.pageStart;
    });
}

/**
 * For collections with chain variants, assign unique hadith numbers
 * using letter suffixes: "8", "8a", "8b", etc.
 */
function assignUniqueHadithNumbers(hadiths: ExtractedHadith[]): void {
  const seenCounts = new Map<string, number>();

  for (const h of hadiths) {
    const base = h.hadithNumber;
    const count = seenCounts.get(base) || 0;
    seenCounts.set(base, count + 1);

    if (count === 0) {
      h.hadithNumber = base;
    } else {
      h.hadithNumber = `${base}${numberToLetterSuffix(count)}`;
    }
  }
}

function numberToLetterSuffix(n: number): string {
  let result = "";
  let remaining = n;
  while (remaining > 0) {
    remaining--;
    result = String.fromCharCode(97 + (remaining % 26)) + result;
    remaining = Math.floor(remaining / 26);
  }
  return result;
}

// =============================================================================
// Extract Unique Kitab Headings (in order of first appearance)
// =============================================================================

function extractKitabHeadings(hadiths: ExtractedHadith[]): string[] {
  const seen = new Set<string>();
  const kitabs: string[] = [];

  for (const h of hadiths) {
    const kitab = h.kitab;
    if (kitab && !seen.has(kitab)) {
      seen.add(kitab);
      kitabs.push(kitab);
    }
  }

  return kitabs;
}

// =============================================================================
// Page Lookup
// =============================================================================

async function buildPageLookup(
  bookId: string
): Promise<
  Map<number, { volumeNumber: number; printedPageNumber: number | null }>
> {
  const pages = await prisma.page.findMany({
    where: { bookId },
    select: { pageNumber: true, volumeNumber: true, printedPageNumber: true },
  });

  const lookup = new Map<
    number,
    { volumeNumber: number; printedPageNumber: number | null }
  >();
  for (const p of pages) {
    lookup.set(p.pageNumber, {
      volumeNumber: p.volumeNumber,
      printedPageNumber: p.printedPageNumber,
    });
  }

  return lookup;
}

// =============================================================================
// Page Link Validation
// =============================================================================

/** Strip Arabic diacritics (tashkeel) for comparison */
function stripDiacritics(s: string): string {
  return s.replace(/[\u064B-\u065F\u0670]/g, "");
}

/**
 * Sample hadiths and verify their text appears on the linked source page.
 * Logs warnings for mismatches but does not fail.
 */
async function validatePageLinks(
  hadiths: ExtractedHadith[],
  bookId: string,
  sampleSize = 50
): Promise<void> {
  const step = Math.max(1, Math.ceil(hadiths.length / sampleSize));
  const sample = hadiths.filter((_, i) => i % step === 0);
  const pageNums = [...new Set(sample.map((h) => h.pageStart))];

  const pages = await prisma.page.findMany({
    where: { bookId, pageNumber: { in: pageNums } },
    select: { pageNumber: true, contentPlain: true },
  });
  const pageMap = new Map(pages.map((p) => [p.pageNumber, p.contentPlain]));

  let checked = 0;
  let mismatches = 0;
  for (const h of sample) {
    const pageContent = pageMap.get(h.pageStart);
    if (!pageContent) continue;
    checked++;

    // Check that hadith text (first 50 chars, stripped) appears on the page
    const textStart = stripDiacritics(h.matn.slice(0, 50));
    const pageStripped = stripDiacritics(pageContent);
    if (!pageStripped.includes(textStart)) {
      mismatches++;
      if (mismatches <= 5) {
        console.warn(`  MISMATCH: #${h.hadithNumber} page ${h.pageStart}`);
      }
    }
  }

  if (mismatches > 0) {
    console.error(
      `  Page link validation: ${mismatches}/${checked} mismatches!`
    );
  } else {
    console.log(`  Page link validation: ${checked}/${checked} OK`);
  }
}

// =============================================================================
// Import Logic
// =============================================================================

async function replaceData(
  config: CollectionConfig,
  hadiths: ExtractedHadith[],
  kitabs: string[],
  pageLookup: Map<
    number,
    { volumeNumber: number; printedPageNumber: number | null }
  >,
  dryRun: boolean
): Promise<ReplacementReport> {
  const report: ReplacementReport = {
    collection: config.slug,
    totalExtracted: hadiths.length,
    totalDeduplicated: hadiths.length,
    kitabCount: kitabs.length,
    kitabs: [],
    deletedTranslations: 0,
    deletedHadiths: 0,
    deletedBooks: 0,
    createdBooks: 0,
    insertedHadiths: 0,
  };

  // Count hadiths per kitab
  const kitabCounts = new Map<string, number>();
  for (const h of hadiths) {
    const k = h.kitab || "(no kitab)";
    kitabCounts.set(k, (kitabCounts.get(k) || 0) + 1);
  }
  report.kitabs = kitabs.map((k) => ({
    name: k,
    hadithCount: kitabCounts.get(k) || 0,
  }));

  // Find collection
  let collection = await prisma.hadithCollection.findUnique({
    where: { slug: config.slug },
    include: { books: { select: { id: true } } },
  });

  if (!collection) {
    if (dryRun) {
      console.log(
        `  Collection '${config.slug}' not found — would create it.`
      );
      report.createdBooks = kitabs.length;
      report.insertedHadiths = hadiths.length;
      return report;
    }

    // Create the collection
    console.log(`  Creating collection '${config.slug}'...`);
    collection = await prisma.hadithCollection.create({
      data: {
        slug: config.slug,
        nameEnglish: config.name,
        nameArabic: config.nameArabic,
      },
      include: { books: { select: { id: true } } },
    });
  }

  const bookIds = collection.books.map((b) => b.id);

  if (dryRun) {
    const translationCount =
      bookIds.length > 0
        ? await prisma.hadithTranslation.count({
            where: { bookId: { in: bookIds } },
          })
        : 0;
    const hadithCount =
      bookIds.length > 0
        ? await prisma.hadith.count({
            where: { bookId: { in: bookIds } },
          })
        : 0;

    report.deletedTranslations = translationCount;
    report.deletedHadiths = hadithCount;
    report.deletedBooks = bookIds.length;
    report.createdBooks = kitabs.length;
    report.insertedHadiths = hadiths.length;

    return report;
  }

  // ---- Step 1: Delete existing data ----
  console.log(`\n--- Deleting existing ${config.slug} data ---`);

  if (bookIds.length > 0) {
    const deletedTranslations = await prisma.hadithTranslation.deleteMany({
      where: { bookId: { in: bookIds } },
    });
    report.deletedTranslations = deletedTranslations.count;
    console.log(`  Deleted ${deletedTranslations.count} translations`);

    const deletedHadiths = await prisma.hadith.deleteMany({
      where: { bookId: { in: bookIds } },
    });
    report.deletedHadiths = deletedHadiths.count;
    console.log(`  Deleted ${deletedHadiths.count} hadiths`);

    const deletedBooks = await prisma.hadithBook.deleteMany({
      where: { collectionId: collection.id },
    });
    report.deletedBooks = deletedBooks.count;
    console.log(`  Deleted ${deletedBooks.count} books`);
  } else {
    console.log("  No existing data to delete.");
  }

  // ---- Step 2: Create new HadithBooks from kitab headings ----
  console.log(`\n--- Creating new HadithBooks ---`);

  const kitabToBookId = new Map<string, number>();

  for (let i = 0; i < kitabs.length; i++) {
    const kitab = kitabs[i];
    const bookNumber = i + 1;

    const book = await prisma.hadithBook.create({
      data: {
        collectionId: collection.id,
        bookNumber,
        nameArabic: kitab,
        nameEnglish: "",
      },
    });

    kitabToBookId.set(kitab, book.id);
    report.createdBooks++;
  }

  console.log(`  Created ${report.createdBooks} books`);

  // ---- Step 3: Insert all hadiths ----
  console.log(`\n--- Inserting hadiths ---`);

  for (let i = 0; i < hadiths.length; i += BATCH_SIZE) {
    const batch = hadiths.slice(i, i + BATCH_SIZE);
    const creates = [];

    for (const h of batch) {
      const kitab = h.kitab || kitabs[0];
      const bookId = kitabToBookId.get(kitab);

      if (!bookId) {
        console.warn(
          `  Warning: No book found for kitab "${kitab}", hadith #${h.hadithNumber}`
        );
        continue;
      }

      const pageInfo = pageLookup.get(h.pageStart);

      // Full text is stored in matn (isnad/matn split deferred to LLM)
      const fullText = h.matn;
      const textPlain = normalizeArabicText(fullText);
      const contentHash = hashHadith(
        config.slug,
        h.hadithNumber,
        fullText
      );

      creates.push(
        prisma.hadith.create({
          data: {
            bookId,
            hadithNumber: h.hadithNumber,
            textArabic: fullText,
            textPlain,
            contentHash,
            isnad: "",
            matn: fullText,
            kitabArabic: h.kitab,
            chapterArabic: h.bab,
            footnotes: h.footnotes,
            isChainVariation: h.isChainVariation,
            sourceBookId: config.bookId,
            sourcePageStart: h.pageStart,
            sourcePageEnd: h.pageEnd,
            sourceVolumeNumber: pageInfo?.volumeNumber ?? null,
            sourcePrintedPage: pageInfo?.printedPageNumber ?? null,
            source: "turath",
          },
        })
      );
    }

    if (creates.length > 0) {
      await prisma.$transaction(creates);
      report.insertedHadiths += creates.length;
    }

    if ((i + BATCH_SIZE) % 2000 === 0 || i + BATCH_SIZE >= hadiths.length) {
      console.log(
        `  Progress: ${Math.min(i + BATCH_SIZE, hadiths.length)}/${hadiths.length}`
      );
    }
  }

  return report;
}

// =============================================================================
// CLI
// =============================================================================

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");
  const collectionArg = args.find((a) => a.startsWith("--collection="));

  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage:");
    console.log(
      "  --collection=SLUG  Collection to import (required)"
    );
    console.log(
      "  --dry-run          Preview counts and kitab breakdown"
    );
    console.log(
      "  --force            Execute the replacement (deletes + inserts)"
    );
    console.log(
      `\nAvailable: ${ALL_REMAINING.join(", ")}`
    );
    process.exit(0);
  }

  if (!collectionArg) {
    console.error("ERROR: --collection=SLUG is required");
    console.error(`Available: ${ALL_REMAINING.join(", ")}`);
    process.exit(1);
  }

  if (!dryRun && !force) {
    console.error("ERROR: Must specify either --dry-run or --force");
    process.exit(1);
  }

  const slug = collectionArg.slice(13);
  const config = getConfig(slug);

  console.log(`=== ${config.name} — Turath Replacement ===`);
  console.log(`Mode: ${dryRun ? "DRY RUN" : "FORCE (will modify DB)"}`);

  // Load extracted chunks
  const chunks = loadExtractedChunks(config.cacheDir);
  const totalRaw = chunks.reduce((sum, c) => sum + c.hadiths.length, 0);
  console.log(`Total raw hadiths across chunks: ${totalRaw}`);

  // Deduplicate
  const hadiths = deduplicateHadiths(chunks);
  console.log(`After deduplication: ${hadiths.length} unique hadiths`);

  // Renumber sequentially for collections with per-section numbering
  if (config.renumberSequentially) {
    console.log("Renumbering hadiths sequentially (per-section → global)...");
    for (let i = 0; i < hadiths.length; i++) {
      hadiths[i].hadithNumber = String(i + 1);
      hadiths[i].sequentialNumber = i + 1;
    }
    console.log(`Renumbered: 1 to ${hadiths.length}`);
  }

  // Assign unique hadith numbers for collections with chain variants
  if (config.hasChainVariants) {
    assignUniqueHadithNumbers(hadiths);

    // Verify uniqueness
    const numberSet = new Set(hadiths.map((h) => h.hadithNumber));
    console.log(
      `Unique hadith numbers: ${numberSet.size} (expected: ${hadiths.length})`
    );
    if (numberSet.size !== hadiths.length) {
      console.error("ERROR: Duplicate hadith numbers detected!");
      process.exit(1);
    }
  }

  // Extract kitab headings
  const kitabs = extractKitabHeadings(hadiths);
  console.log(`Unique kitab headings: ${kitabs.length}`);

  // Build page lookup
  const pageLookup = await buildPageLookup(config.bookId);
  console.log(`Page lookup: ${pageLookup.size} pages loaded`);

  // Validate page links (sample 50 hadiths)
  console.log("\nValidating page links...");
  await validatePageLinks(hadiths, config.bookId);

  // Execute replacement
  const report = await replaceData(config, hadiths, kitabs, pageLookup, dryRun);

  // Print report
  console.log("\n=== Replacement Report ===");
  console.log(`Collection:           ${report.collection}`);
  console.log(`Total extracted:      ${report.totalExtracted}`);
  console.log(`After dedup:          ${report.totalDeduplicated}`);
  console.log(`Kitab count:          ${report.kitabCount}`);
  console.log(`Deleted translations: ${report.deletedTranslations}`);
  console.log(`Deleted hadiths:      ${report.deletedHadiths}`);
  console.log(`Deleted books:        ${report.deletedBooks}`);
  console.log(`Created books:        ${report.createdBooks}`);
  console.log(`Inserted hadiths:     ${report.insertedHadiths}`);

  console.log("\n--- Kitab Breakdown ---");
  for (let i = 0; i < report.kitabs.length; i++) {
    const k = report.kitabs[i];
    console.log(`  ${i + 1}. ${k.name} (${k.hadithCount} hadiths)`);
  }

  if (dryRun) {
    // Show sample hadiths
    console.log("\n--- Sample Hadiths (first 3 per kitab, first 5 kitabs) ---");
    for (const kitab of kitabs.slice(0, 5)) {
      console.log(`\n  [${kitab}]`);
      const kitabHadiths = hadiths
        .filter((h) => h.kitab === kitab)
        .slice(0, 3);
      for (const h of kitabHadiths) {
        const preview = (h.matn || h.isnad || "")
          .slice(0, 80)
          .replace(/\n/g, " ");
        console.log(
          `    #${h.hadithNumber} (p.${h.pageStart}): ${preview}...`
        );
      }
    }
  }

  // Write report
  const reportPath = path.join(config.cacheDir, "replacement-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nFull report written to ${reportPath}`);
}

main()
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
