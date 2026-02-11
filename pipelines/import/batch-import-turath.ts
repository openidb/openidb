/**
 * Batch Import Books from Turath
 *
 * Reads from turath-catalog.json and imports books with configurable concurrency.
 * Supports checkpointing, resume, and progress tracking.
 *
 * Usage:
 *   bun run pipelines/import/batch-import-turath.ts --limit=50                  # Import first 50
 *   bun run pipelines/import/batch-import-turath.ts --all                       # Import all
 *   bun run pipelines/import/batch-import-turath.ts --resume                    # Resume from checkpoint
 *   bun run pipelines/import/batch-import-turath.ts --limit=50 --offset=100     # Skip first 100
 *   bun run pipelines/import/batch-import-turath.ts --limit=50 --dry-run        # Preview only
 *   bun run pipelines/import/batch-import-turath.ts --limit=50 --delay=1000     # 1s between books
 *   bun run pipelines/import/batch-import-turath.ts --all --concurrency=10      # 10 parallel workers
 *   bun run pipelines/import/batch-import-turath.ts --all --skip-pdfs           # Skip PDF downloads
 *   bun run pipelines/import/batch-import-turath.ts --limit=50 --no-skip-existing
 */

import "../env";
import { prisma } from "../../src/db";
import { importTurathBook, type ImportResult } from "./import-turath";
import { resolve } from "path";
import { readFileSync, writeFileSync, existsSync } from "fs";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

interface BatchArgs {
  limit: number | null;
  offset: number;
  all: boolean;
  dryRun: boolean;
  resume: boolean;
  delay: number;
  skipExisting: boolean;
  concurrency: number;
  skipPdfs: boolean;
}

function parseArgs(): BatchArgs {
  const args = process.argv.slice(2);
  const result: BatchArgs = {
    limit: null,
    offset: 0,
    all: false,
    dryRun: false,
    resume: false,
    delay: 750,
    skipExisting: true,
    concurrency: 1,
    skipPdfs: false,
  };

  for (const arg of args) {
    if (arg.startsWith("--limit=")) {
      result.limit = parseInt(arg.slice(8), 10);
    } else if (arg.startsWith("--offset=")) {
      result.offset = parseInt(arg.slice(9), 10);
    } else if (arg === "--all") {
      result.all = true;
    } else if (arg === "--dry-run") {
      result.dryRun = true;
    } else if (arg === "--resume") {
      result.resume = true;
    } else if (arg.startsWith("--delay=")) {
      result.delay = parseInt(arg.slice(8), 10);
    } else if (arg === "--no-skip-existing") {
      result.skipExisting = false;
    } else if (arg.startsWith("--concurrency=")) {
      result.concurrency = Math.min(20, Math.max(1, parseInt(arg.slice(14), 10)));
    } else if (arg === "--skip-pdfs") {
      result.skipPdfs = true;
    }
  }

  if (!result.all && result.limit === null && !result.resume) {
    console.error("Usage: bun run pipelines/import/batch-import-turath.ts --limit=50 | --all | --resume");
    console.error("\nOptions:");
    console.error("  --limit=N              Import N books from catalog");
    console.error("  --offset=N             Skip first N catalog entries");
    console.error("  --all                  Import all books in catalog");
    console.error("  --resume               Resume from last checkpoint");
    console.error("  --dry-run              Preview without DB writes");
    console.error("  --delay=MS             Delay between books in ms (default: 750)");
    console.error("  --concurrency=N        Parallel workers (default: 1, max: 20)");
    console.error("  --skip-pdfs            Skip PDF download step");
    console.error("  --no-skip-existing     Re-import books already in DB");
    process.exit(1);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CatalogBook {
  id: number;
  title: string;
  authorId: number | null;
  categoryId: number;
}

interface Catalog {
  scrapedAt: string;
  totalBooks: number;
  books: CatalogBook[];
}

interface BatchProgress {
  lastIndex: number;
  imported: number;
  skipped: number;
  failed: number;
  startedAt: string;
  failedIds: number[];
  processedIndices: number[];
}

// ---------------------------------------------------------------------------
// File paths
// ---------------------------------------------------------------------------

const CATALOG_PATH = resolve(import.meta.dir, "turath-catalog.json");
const PROGRESS_PATH = resolve(import.meta.dir, "batch-progress.json");
const CHECKPOINT_INTERVAL = 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadCatalog(): Catalog {
  if (!existsSync(CATALOG_PATH)) {
    console.error(`Catalog file not found: ${CATALOG_PATH}`);
    console.error("Run scrape-turath-catalog.ts first.");
    process.exit(1);
  }
  return JSON.parse(readFileSync(CATALOG_PATH, "utf-8"));
}

function loadProgress(): BatchProgress | null {
  if (!existsSync(PROGRESS_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(PROGRESS_PATH, "utf-8"));
    // Migrate from old format (no processedIndices)
    if (!raw.processedIndices) {
      raw.processedIndices = [];
      // Backfill: assume all indices up to lastIndex were processed
      for (let i = 0; i <= raw.lastIndex; i++) {
        raw.processedIndices.push(i);
      }
    }
    return raw;
  } catch {
    return null;
  }
}

/** Mutex for serialized progress file writes */
let writeChain = Promise.resolve();

function saveProgress(progress: BatchProgress): void {
  writeChain = writeChain.then(() => {
    progress.lastIndex = progress.processedIndices.length > 0
      ? Math.max(...progress.processedIndices)
      : -1;
    writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2));
  });
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

// ---------------------------------------------------------------------------
// Worker pool
// ---------------------------------------------------------------------------

async function runPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();
  const catalog = loadCatalog();

  console.log("Turath Batch Import");
  console.log("=".repeat(60));
  console.log(`Catalog:            ${catalog.totalBooks} books (scraped ${catalog.scrapedAt})`);
  console.log(`Mode:               ${args.dryRun ? "DRY RUN" : "LIVE IMPORT"}`);
  console.log(`Concurrency:        ${args.concurrency}`);
  console.log(`Skip existing:      ${args.skipExisting ? "yes" : "no"}`);
  console.log(`Skip PDFs:          ${args.skipPdfs ? "yes" : "no"}`);
  console.log(`Delay:              ${args.delay}ms between books`);

  // Determine start index and limit
  let startIndex = args.offset;
  let progress: BatchProgress;

  if (args.resume) {
    const saved = loadProgress();
    if (saved) {
      progress = saved;
      // With parallel processing, we can't simply use lastIndex+1.
      // Instead, we filter out already-processed indices below.
      console.log(`Resuming:           ${saved.processedIndices.length} already processed (${saved.imported} imported, ${saved.failed} failed)`);
    } else {
      console.log("No checkpoint found, starting fresh.");
      progress = {
        lastIndex: -1,
        imported: 0,
        skipped: 0,
        failed: 0,
        startedAt: new Date().toISOString(),
        failedIds: [],
        processedIndices: [],
      };
    }
  } else {
    progress = {
      lastIndex: startIndex - 1,
      imported: 0,
      skipped: 0,
      failed: 0,
      startedAt: new Date().toISOString(),
      failedIds: [],
      processedIndices: [],
    };
  }

  const books = catalog.books.slice(startIndex);
  const limit = args.all ? books.length : (args.limit ?? books.length);
  const allBooks = books.slice(0, limit);

  // Build work items with global indices, filtering out already-processed ones on resume
  const processedSet = new Set(progress.processedIndices);
  const workItems: Array<{ book: CatalogBook; globalIndex: number }> = [];
  for (let i = 0; i < allBooks.length; i++) {
    const globalIndex = startIndex + i;
    if (!processedSet.has(globalIndex)) {
      workItems.push({ book: allBooks[i], globalIndex });
    }
  }

  const totalCount = allBooks.length;
  console.log(`Processing:         ${workItems.length} books remaining out of ${totalCount} (index ${startIndex} to ${startIndex + totalCount - 1})`);
  console.log("=".repeat(60));
  console.log();

  if (workItems.length === 0) {
    console.log("No books to process.");
    return;
  }

  const batchStartTime = Date.now();
  let completedInSession = 0;
  let sinceLastCheckpoint = 0;

  const processBook = async (item: { book: CatalogBook; globalIndex: number }) => {
    const { book, globalIndex } = item;
    const bookStartTime = Date.now();

    // Check if already in DB
    if (args.skipExisting && !args.dryRun) {
      const existing = await prisma.book.findUnique({
        where: { id: String(book.id) },
        select: { id: true },
      });
      if (existing) {
        progress.skipped++;
        progress.processedIndices.push(globalIndex);
        completedInSession++;
        sinceLastCheckpoint++;
        console.log(`  ⊘ Book ${book.id} skipped (already in DB)`);
        maybeCheckpoint();
        return;
      }
    }

    // Import with quiet mode when running concurrent workers
    const result: ImportResult = await importTurathBook(String(book.id), {
      dryRun: args.dryRun,
      quiet: args.concurrency > 1,
      skipPdfs: args.skipPdfs,
    });

    const elapsed = ((Date.now() - bookStartTime) / 1000).toFixed(1);

    if (result.success) {
      progress.imported++;
      console.log(`  ✓ Book ${book.id} "${result.title}" (${result.pages} pages, ${elapsed}s)`);
    } else {
      progress.failed++;
      progress.failedIds.push(book.id);
      console.log(`  ✗ Book ${book.id} FAILED: ${result.error} (${elapsed}s)`);
    }

    progress.processedIndices.push(globalIndex);
    completedInSession++;
    sinceLastCheckpoint++;
    maybeCheckpoint();

    // Show periodic summary
    if (completedInSession % 25 === 0) {
      const totalElapsed = Date.now() - batchStartTime;
      const avgPerBook = totalElapsed / completedInSession;
      const remaining = workItems.length - completedInSession;
      const eta = formatDuration(remaining * avgPerBook / Math.min(args.concurrency, remaining || 1));
      console.log(`  [${progress.processedIndices.length}/${totalCount}] ${progress.imported} imported, ${progress.skipped} skipped, ${progress.failed} failed — ETA: ${eta}`);
    }

    // Delay between books (per-worker)
    if (args.delay > 0) {
      await sleep(args.delay);
    }
  };

  function maybeCheckpoint() {
    if (sinceLastCheckpoint >= CHECKPOINT_INTERVAL) {
      sinceLastCheckpoint = 0;
      saveProgress(progress);
    }
  }

  // Run with concurrency
  if (args.concurrency <= 1) {
    // Sequential mode — preserve original verbose output
    for (let i = 0; i < workItems.length; i++) {
      await processBook(workItems[i]);
    }
  } else {
    await runPool(workItems, args.concurrency, async (item) => {
      await processBook(item);
    });
  }

  // Wait for any pending writes
  await writeChain;

  // Final checkpoint
  saveProgress(progress);
  await writeChain;

  // Summary
  const totalDuration = formatDuration(Date.now() - batchStartTime);

  console.log(`\n${"=".repeat(60)}`);
  console.log("Batch Import Complete");
  console.log("=".repeat(60));
  console.log(`  Total:      ${totalCount}`);
  console.log(`  Imported:   ${progress.imported}`);
  console.log(`  Skipped:    ${progress.skipped} (already in DB)`);
  console.log(`  Failed:     ${progress.failed}`);
  console.log(`  Duration:   ${totalDuration}`);

  if (progress.failedIds.length > 0) {
    console.log(`  Failed IDs: ${progress.failedIds.join(", ")}`);
  }

  console.log("=".repeat(60));
}

main()
  .catch((e) => {
    console.error("\nBatch import failed:");
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
