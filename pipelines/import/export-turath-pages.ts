/**
 * Generic Turath Page Export
 *
 * Reads all pages for a book from the database and splits them into numbered
 * chunk files for deterministic parsing. Each chunk contains 50 pages with
 * 2-page overlap between adjacent chunks.
 *
 * Usage:
 *   bun run pipelines/import/export-turath-pages.ts --collection=abudawud
 *   bun run pipelines/import/export-turath-pages.ts --all
 *   bun run pipelines/import/export-turath-pages.ts --collection=abudawud --chunk-size=100
 */

import "../env";
import { prisma } from "../../src/db";
import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";
import { getConfig, ALL_REMAINING } from "./turath-hadith-configs";

const DEFAULT_CHUNK_SIZE = 50;
const OVERLAP = 2;

function parseArgs(): { collections: string[]; chunkSize: number } {
  const args = process.argv.slice(2);
  let collections: string[] = [];
  let chunkSize = DEFAULT_CHUNK_SIZE;

  for (const arg of args) {
    if (arg.startsWith("--collection=")) {
      collections.push(arg.slice(13));
    } else if (arg.startsWith("--chunk-size=")) {
      chunkSize = parseInt(arg.slice(13), 10) || DEFAULT_CHUNK_SIZE;
    } else if (arg === "--all") {
      collections = [...ALL_REMAINING];
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage:");
      console.log("  --collection=SLUG   Export pages for a specific collection");
      console.log("  --all               Export pages for all remaining collections");
      console.log("  --chunk-size=N      Pages per chunk (default: 50)");
      console.log(`\nAvailable: ${ALL_REMAINING.join(", ")}`);
      process.exit(0);
    }
  }

  if (collections.length === 0) {
    console.error("ERROR: Specify --collection=SLUG or --all");
    console.error(`Available: ${ALL_REMAINING.join(", ")}`);
    process.exit(1);
  }

  return { collections, chunkSize };
}

async function exportCollection(slug: string, chunkSize: number) {
  const config = getConfig(slug);

  console.log(`\n=== Exporting ${config.name} (book ${config.bookId}) ===`);

  const pages = await prisma.page.findMany({
    where: { bookId: config.bookId },
    orderBy: [{ volumeNumber: "asc" }, { pageNumber: "asc" }],
    select: {
      pageNumber: true,
      volumeNumber: true,
      printedPageNumber: true,
      contentPlain: true,
    },
  });

  if (pages.length === 0) {
    console.log(`  No pages found for book ${config.bookId}. Skipping.`);
    return;
  }

  console.log(`  Found ${pages.length} total pages.`);

  // Skip front-matter (volume 0 or pages with no meaningful content)
  const contentPages = pages.filter((p) => {
    if (p.volumeNumber === 0) return false;
    if (p.contentPlain.trim().length < 50) return false;
    return true;
  });

  console.log(`  After filtering front-matter: ${contentPages.length} content pages.`);

  mkdirSync(config.cacheDir, { recursive: true });

  // Split into chunks with overlap
  const chunks: Array<{
    chunkId: number;
    pagesFrom: number;
    pagesTo: number;
    pages: typeof contentPages;
  }> = [];

  let startIdx = 0;
  let chunkId = 1;

  while (startIdx < contentPages.length) {
    const endIdx = Math.min(startIdx + chunkSize, contentPages.length);
    const chunkPages = contentPages.slice(startIdx, endIdx);

    chunks.push({
      chunkId,
      pagesFrom: chunkPages[0].pageNumber,
      pagesTo: chunkPages[chunkPages.length - 1].pageNumber,
      pages: chunkPages,
    });

    startIdx += chunkSize - OVERLAP;
    chunkId++;
  }

  console.log(
    `  Writing ${chunks.length} chunk files (${chunkSize} pages each, ${OVERLAP}-page overlap)...`
  );

  for (const chunk of chunks) {
    const num = String(chunk.chunkId).padStart(3, "0");
    const filePath = resolve(config.cacheDir, `chunk-${num}.json`);
    writeFileSync(filePath, JSON.stringify(chunk, null, 2));
  }

  console.log(`  Done. ${chunks.length} chunks written to ${config.cacheDir}`);
}

async function main() {
  const { collections, chunkSize } = parseArgs();

  console.log(`Exporting ${collections.length} collection(s)...`);

  for (const slug of collections) {
    await exportCollection(slug, chunkSize);
  }

  console.log("\nAll exports complete.");
}

main()
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
