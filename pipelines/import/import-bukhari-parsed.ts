/**
 * Import Parsed Bukhari Hadiths from LLM-Extracted Chunk Files
 *
 * Reads chunk-NNN.extracted.json files produced by Claude subagents,
 * deduplicates, and enriches existing Bukhari hadiths with:
 * - isnad/matn separation (fully vocalized)
 * - Source page references (Sultaniyya edition)
 * - kitab/bab headings
 * - Scholarly footnotes
 *
 * Usage:
 *   bun run pipelines/import/import-bukhari-parsed.ts --dry-run
 *   bun run pipelines/import/import-bukhari-parsed.ts --skip-text-update
 *   bun run pipelines/import/import-bukhari-parsed.ts --force
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

interface ImportReport {
  totalExtracted: number;
  totalDeduplicated: number;
  matched: number;
  notFound: number;
  updated: number;
  skipped: number;
  mismatches: Array<{ hadithNumber: string; reason: string }>;
}

// ============================================================================
// Chunk Loading & Deduplication
// ============================================================================

function loadExtractedChunks(): ExtractedChunk[] {
  const files = fs.readdirSync(CACHE_DIR)
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
  const seen = new Map<string, { hadith: ExtractedHadith; chunkId: number; position: number; totalInChunk: number }>();

  for (const chunk of chunks) {
    for (let i = 0; i < chunk.hadiths.length; i++) {
      const h = chunk.hadiths[i];
      const key = h.hadithNumber;
      const existing = seen.get(key);

      if (!existing) {
        seen.set(key, { hadith: h, chunkId: chunk.chunkId, position: i, totalInChunk: chunk.hadiths.length });
        continue;
      }

      // Prefer the version that's more "middle" in its chunk
      const existingMidDist = Math.abs(existing.position - existing.totalInChunk / 2);
      const newMidDist = Math.abs(i - chunk.hadiths.length / 2);

      if (newMidDist < existingMidDist) {
        seen.set(key, { hadith: h, chunkId: chunk.chunkId, position: i, totalInChunk: chunk.hadiths.length });
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
// Page Lookup
// ============================================================================

async function buildPageLookup(): Promise<Map<number, { volumeNumber: number; printedPageNumber: number | null }>> {
  const pages = await prisma.page.findMany({
    where: { bookId: SOURCE_BOOK_ID },
    select: { pageNumber: true, volumeNumber: true, printedPageNumber: true },
  });

  const lookup = new Map<number, { volumeNumber: number; printedPageNumber: number | null }>();
  for (const p of pages) {
    lookup.set(p.pageNumber, { volumeNumber: p.volumeNumber, printedPageNumber: p.printedPageNumber });
  }

  return lookup;
}

// ============================================================================
// Import Logic
// ============================================================================

async function importHadiths(
  hadiths: ExtractedHadith[],
  pageLookup: Map<number, { volumeNumber: number; printedPageNumber: number | null }>,
  flags: { dryRun: boolean; skipTextUpdate: boolean; force: boolean },
): Promise<ImportReport> {
  const report: ImportReport = {
    totalExtracted: hadiths.length,
    totalDeduplicated: hadiths.length,
    matched: 0,
    notFound: 0,
    updated: 0,
    skipped: 0,
    mismatches: [],
  };

  // Find the bukhari collection and its books
  const collection = await prisma.hadithCollection.findUnique({
    where: { slug: COLLECTION_SLUG },
    include: { books: { select: { id: true, bookNumber: true } } },
  });

  if (!collection) {
    console.error(`Collection '${COLLECTION_SLUG}' not found!`);
    process.exit(1);
  }

  // Build hadith number → DB record mapping
  const existingHadiths = await prisma.hadith.findMany({
    where: { book: { collection: { slug: COLLECTION_SLUG } } },
    select: { id: true, hadithNumber: true, bookId: true, textArabic: true },
  });

  const hadithMap = new Map<string, { id: number; bookId: number; textArabic: string }>();
  for (const h of existingHadiths) {
    hadithMap.set(h.hadithNumber, { id: h.id, bookId: h.bookId, textArabic: h.textArabic });
  }

  console.log(`Existing Bukhari hadiths in DB: ${hadithMap.size}`);
  console.log(`Extracted hadiths to import: ${hadiths.length}`);

  if (flags.dryRun) {
    // Just count matches
    for (const h of hadiths) {
      if (hadithMap.has(h.hadithNumber)) {
        report.matched++;
      } else {
        report.notFound++;
        report.mismatches.push({ hadithNumber: h.hadithNumber, reason: "not_found_in_db" });
      }
    }
    return report;
  }

  // Process in batches
  for (let i = 0; i < hadiths.length; i += BATCH_SIZE) {
    const batch = hadiths.slice(i, i + BATCH_SIZE);
    const updates: Array<Promise<any>> = [];

    for (const h of batch) {
      const existing = hadithMap.get(h.hadithNumber);
      if (!existing) {
        report.notFound++;
        report.mismatches.push({ hadithNumber: h.hadithNumber, reason: "not_found_in_db" });
        continue;
      }

      report.matched++;

      // Look up page info
      const pageInfo = pageLookup.get(h.pageStart);

      // Build update data
      const updateData: Record<string, any> = {
        sourceBookId: SOURCE_BOOK_ID,
        sourcePageStart: h.pageStart,
        sourcePageEnd: h.pageEnd,
        sourceVolumeNumber: pageInfo?.volumeNumber ?? null,
        sourcePrintedPage: pageInfo?.printedPageNumber ?? null,
        kitabArabic: h.kitab,
        chapterArabic: h.bab,
        isChainVariation: h.isChainVariation,
      };

      if (h.isnad) updateData.isnad = h.isnad;
      if (h.matn) updateData.matn = h.matn;
      if (h.footnotes) updateData.footnotes = h.footnotes;

      // Update text with vocalized version from book (richer than sunnah.com)
      if (!flags.skipTextUpdate) {
        const fullText = h.isnad ? `${h.isnad}\n${h.matn}` : h.matn;
        updateData.textArabic = fullText;
        updateData.textPlain = normalizeArabicText(fullText);
        updateData.contentHash = hashHadith(COLLECTION_SLUG, h.hadithNumber, fullText);
      }

      updates.push(
        prisma.hadith.update({
          where: { id: existing.id },
          data: updateData,
        }),
      );
    }

    if (updates.length > 0) {
      await prisma.$transaction(updates);
      report.updated += updates.length;
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
  const flags = {
    dryRun: args.includes("--dry-run"),
    skipTextUpdate: args.includes("--skip-text-update"),
    force: args.includes("--force"),
  };

  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage:");
    console.log("  --dry-run           Preview without updating DB");
    console.log("  --skip-text-update  Only update page refs and metadata, keep existing textArabic");
    console.log("  --force             Update textArabic with vocalized version from book");
    console.log("");
    process.exit(0);
  }

  console.log("=== Bukhari Parsed Hadith Importer ===");
  console.log(`Mode: ${flags.dryRun ? "DRY RUN" : flags.skipTextUpdate ? "SAFE (page refs only)" : "FULL UPDATE"}`);

  // Load extracted chunks
  const chunks = loadExtractedChunks();
  const totalRaw = chunks.reduce((sum, c) => sum + c.hadiths.length, 0);
  console.log(`Total raw hadiths across chunks: ${totalRaw}`);

  // Deduplicate
  const hadiths = deduplicateHadiths(chunks);
  console.log(`After deduplication: ${hadiths.length} unique hadiths`);

  // Build page lookup
  const pageLookup = await buildPageLookup();
  console.log(`Page lookup: ${pageLookup.size} pages loaded`);

  // Import
  const report = await importHadiths(hadiths, pageLookup, flags);

  // Report
  console.log("\n=== Import Report ===");
  console.log(`Total extracted:    ${report.totalExtracted}`);
  console.log(`After dedup:        ${report.totalDeduplicated}`);
  console.log(`Matched in DB:      ${report.matched}`);
  console.log(`Not found in DB:    ${report.notFound}`);
  console.log(`Updated:            ${report.updated}`);

  if (report.mismatches.length > 0) {
    console.log(`\nMismatches (${report.mismatches.length}):`);
    for (const m of report.mismatches.slice(0, 20)) {
      console.log(`  #${m.hadithNumber}: ${m.reason}`);
    }
    if (report.mismatches.length > 20) {
      console.log(`  ... and ${report.mismatches.length - 20} more`);
    }
  }

  // Write full report
  const reportPath = path.join(CACHE_DIR, "import-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nFull report written to ${reportPath}`);
}

main()
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
