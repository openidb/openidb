/**
 * Replace Sunnah.com Bukhari with Sultaniyya Edition
 *
 * Reads chunk-NNN.extracted.json files from bukhari-pages-cache/,
 * deduplicates, DELETES all existing Bukhari data (translations, hadiths, books),
 * then creates new HadithBooks from the 39 kitab headings and inserts all 7,333
 * Sultaniyya hadiths as the sole Bukhari source.
 *
 * Usage:
 *   bun run pipelines/import/import-sultaniyya-bukhari.ts --dry-run
 *   bun run pipelines/import/import-sultaniyya-bukhari.ts --force
 */

import "../env";
import { prisma } from "../../src/db";
import { normalizeArabicText } from "../../src/embeddings";
import { hashHadith } from "../../src/utils/content-hash";
import * as fs from "fs";
import * as path from "path";

const CACHE_DIR = path.join(import.meta.dir, "bukhari-pages-cache");
const BATCH_SIZE = 500;
const SOURCE_BOOK_ID = "1681";
const COLLECTION_SLUG = "bukhari";

// ============================================================================
// Types
// ============================================================================

interface ExtractedHadith {
  hadithNumber: string;
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

// ============================================================================
// Chunk Loading & Deduplication (reused from import-bukhari-parsed.ts)
// ============================================================================

function loadExtractedChunks(): ExtractedChunk[] {
  const files = fs
    .readdirSync(CACHE_DIR)
    .filter((f) => f.match(/^chunk-\d+\.extracted\.json$/))
    .sort();

  if (files.length === 0) {
    console.error("No .extracted.json files found in", CACHE_DIR);
    process.exit(1);
  }

  console.log(`Found ${files.length} extracted chunk files.`);

  const chunks: ExtractedChunk[] = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(CACHE_DIR, file), "utf-8");
    const chunk: ExtractedChunk = JSON.parse(content);
    chunks.push(chunk);
  }

  return chunks;
}

/**
 * Deduplicate hadiths across chunks (overlap pages may produce duplicates).
 * Prefer the extraction from the chunk where the hadith is in the middle.
 */
function deduplicateHadiths(chunks: ExtractedChunk[]): ExtractedHadith[] {
  const seen = new Map<
    string,
    { hadith: ExtractedHadith; chunkId: number; position: number; totalInChunk: number }
  >();

  for (const chunk of chunks) {
    for (let i = 0; i < chunk.hadiths.length; i++) {
      const h = chunk.hadiths[i];
      const key = h.hadithNumber;
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

      // Prefer the version that's more "middle" in its chunk
      const existingMidDist = Math.abs(existing.position - existing.totalInChunk / 2);
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

  // Sort by hadith number (numeric sort)
  return [...seen.values()]
    .map((v) => v.hadith)
    .sort((a, b) => {
      const numA = parseInt(a.hadithNumber.replace(/[^0-9]/g, ""), 10) || 0;
      const numB = parseInt(b.hadithNumber.replace(/[^0-9]/g, ""), 10) || 0;
      return numA - numB;
    });
}

// ============================================================================
// Extract Unique Kitab Headings (in order of first appearance)
// ============================================================================

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

// ============================================================================
// Page Lookup
// ============================================================================

async function buildPageLookup(): Promise<
  Map<number, { volumeNumber: number; printedPageNumber: number | null }>
> {
  const pages = await prisma.page.findMany({
    where: { bookId: SOURCE_BOOK_ID },
    select: { pageNumber: true, volumeNumber: true, printedPageNumber: true },
  });

  const lookup = new Map<number, { volumeNumber: number; printedPageNumber: number | null }>();
  for (const p of pages) {
    lookup.set(p.pageNumber, {
      volumeNumber: p.volumeNumber,
      printedPageNumber: p.printedPageNumber,
    });
  }

  return lookup;
}

// ============================================================================
// Import Logic
// ============================================================================

async function replaceData(
  hadiths: ExtractedHadith[],
  kitabs: string[],
  pageLookup: Map<number, { volumeNumber: number; printedPageNumber: number | null }>,
  dryRun: boolean,
): Promise<ReplacementReport> {
  const report: ReplacementReport = {
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
  report.kitabs = kitabs.map((k) => ({ name: k, hadithCount: kitabCounts.get(k) || 0 }));

  // Find bukhari collection
  const collection = await prisma.hadithCollection.findUnique({
    where: { slug: COLLECTION_SLUG },
    include: { books: { select: { id: true } } },
  });

  if (!collection) {
    console.error(`Collection '${COLLECTION_SLUG}' not found!`);
    process.exit(1);
  }

  const bookIds = collection.books.map((b) => b.id);

  if (dryRun) {
    // Count what would be deleted
    const translationCount = await prisma.hadithTranslation.count({
      where: { bookId: { in: bookIds } },
    });
    const hadithCount = await prisma.hadith.count({
      where: { bookId: { in: bookIds } },
    });

    report.deletedTranslations = translationCount;
    report.deletedHadiths = hadithCount;
    report.deletedBooks = bookIds.length;
    report.createdBooks = kitabs.length;
    report.insertedHadiths = hadiths.length;

    return report;
  }

  // ---- Step 1: Delete existing Bukhari data ----
  console.log("\n--- Deleting existing Bukhari data ---");

  // Delete translations first (no FK cascade)
  const deletedTranslations = await prisma.hadithTranslation.deleteMany({
    where: { bookId: { in: bookIds } },
  });
  report.deletedTranslations = deletedTranslations.count;
  console.log(`  Deleted ${deletedTranslations.count} translations`);

  // Delete hadiths
  const deletedHadiths = await prisma.hadith.deleteMany({
    where: { bookId: { in: bookIds } },
  });
  report.deletedHadiths = deletedHadiths.count;
  console.log(`  Deleted ${deletedHadiths.count} hadiths`);

  // Delete books
  const deletedBooks = await prisma.hadithBook.deleteMany({
    where: { collectionId: collection.id },
  });
  report.deletedBooks = deletedBooks.count;
  console.log(`  Deleted ${deletedBooks.count} books`);

  // ---- Step 2: Create new HadithBooks from kitab headings ----
  console.log("\n--- Creating new HadithBooks ---");

  const kitabToBookId = new Map<string, number>();

  for (let i = 0; i < kitabs.length; i++) {
    const kitab = kitabs[i];
    const bookNumber = i + 1;

    const book = await prisma.hadithBook.create({
      data: {
        collectionId: collection.id,
        bookNumber,
        nameArabic: kitab,
        nameEnglish: "", // Can be enriched later
      },
    });

    kitabToBookId.set(kitab, book.id);
    report.createdBooks++;
  }

  console.log(`  Created ${report.createdBooks} books`);

  // ---- Step 3: Insert all hadiths ----
  console.log("\n--- Inserting hadiths ---");

  for (let i = 0; i < hadiths.length; i += BATCH_SIZE) {
    const batch = hadiths.slice(i, i + BATCH_SIZE);
    const creates = [];

    for (const h of batch) {
      const kitab = h.kitab || kitabs[0]; // Fallback to first kitab
      const bookId = kitabToBookId.get(kitab);

      if (!bookId) {
        console.warn(`  Warning: No book found for kitab "${kitab}", hadith #${h.hadithNumber}`);
        continue;
      }

      // Look up page info
      const pageInfo = pageLookup.get(h.pageStart);

      // Build full text
      const fullText = h.isnad ? `${h.isnad}\n${h.matn}` : h.matn;
      const textPlain = normalizeArabicText(fullText);
      const contentHash = hashHadith(COLLECTION_SLUG, h.hadithNumber, fullText);

      creates.push(
        prisma.hadith.create({
          data: {
            bookId,
            hadithNumber: h.hadithNumber,
            textArabic: fullText,
            textPlain,
            contentHash,
            isnad: h.isnad,
            matn: h.matn,
            kitabArabic: h.kitab,
            chapterArabic: h.bab,
            footnotes: h.footnotes,
            isChainVariation: h.isChainVariation,
            sourceBookId: SOURCE_BOOK_ID,
            sourcePageStart: h.pageStart,
            sourcePageEnd: h.pageEnd,
            sourceVolumeNumber: pageInfo?.volumeNumber ?? null,
            sourcePrintedPage: pageInfo?.printedPageNumber ?? null,
            source: "sultaniyya",
          },
        }),
      );
    }

    if (creates.length > 0) {
      await prisma.$transaction(creates);
      report.insertedHadiths += creates.length;
    }

    if ((i + BATCH_SIZE) % 2000 === 0 || i + BATCH_SIZE >= hadiths.length) {
      console.log(`  Progress: ${Math.min(i + BATCH_SIZE, hadiths.length)}/${hadiths.length}`);
    }
  }

  return report;
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");

  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage:");
    console.log("  --dry-run    Preview counts and kitab breakdown without modifying DB");
    console.log("  --force      Actually execute the replacement (deletes + inserts)");
    console.log("");
    console.log("WARNING: --force will DELETE all existing Bukhari hadiths, translations,");
    console.log("and books, then replace with Sultaniyya edition data.");
    process.exit(0);
  }

  if (!dryRun && !force) {
    console.error("ERROR: Must specify either --dry-run or --force");
    console.error("Run with --help for usage.");
    process.exit(1);
  }

  console.log("=== Bukhari Sultaniyya Replacement ===");
  console.log(`Mode: ${dryRun ? "DRY RUN" : "FORCE (will modify DB)"}`);

  // Load extracted chunks
  const chunks = loadExtractedChunks();
  const totalRaw = chunks.reduce((sum, c) => sum + c.hadiths.length, 0);
  console.log(`Total raw hadiths across chunks: ${totalRaw}`);

  // Deduplicate
  const hadiths = deduplicateHadiths(chunks);
  console.log(`After deduplication: ${hadiths.length} unique hadiths`);

  // Extract kitab headings
  const kitabs = extractKitabHeadings(hadiths);
  console.log(`Unique kitab headings: ${kitabs.length}`);

  // Build page lookup
  const pageLookup = await buildPageLookup();
  console.log(`Page lookup: ${pageLookup.size} pages loaded`);

  // Execute replacement
  const report = await replaceData(hadiths, kitabs, pageLookup, dryRun);

  // Print report
  console.log("\n=== Replacement Report ===");
  console.log(`Total extracted:     ${report.totalExtracted}`);
  console.log(`After dedup:         ${report.totalDeduplicated}`);
  console.log(`Kitab count:         ${report.kitabCount}`);
  console.log(`Deleted translations: ${report.deletedTranslations}`);
  console.log(`Deleted hadiths:     ${report.deletedHadiths}`);
  console.log(`Deleted books:       ${report.deletedBooks}`);
  console.log(`Created books:       ${report.createdBooks}`);
  console.log(`Inserted hadiths:    ${report.insertedHadiths}`);

  console.log("\n--- Kitab Breakdown ---");
  for (let i = 0; i < report.kitabs.length; i++) {
    const k = report.kitabs[i];
    console.log(`  ${i + 1}. ${k.name} (${k.hadithCount} hadiths)`);
  }

  if (dryRun) {
    // Show first 5 hadiths per kitab
    console.log("\n--- Sample Hadiths (first 5 per kitab) ---");
    for (const kitab of kitabs.slice(0, 5)) {
      console.log(`\n  [${kitab}]`);
      const kitabHadiths = hadiths.filter((h) => h.kitab === kitab).slice(0, 5);
      for (const h of kitabHadiths) {
        const preview = (h.matn || "").slice(0, 80).replace(/\n/g, " ");
        console.log(`    #${h.hadithNumber}: ${preview}...`);
      }
    }
  }

  // Write report
  const reportPath = path.join(CACHE_DIR, "replacement-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nFull report written to ${reportPath}`);
}

main()
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
