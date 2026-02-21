/**
 * Export Bukhari Pages to Chunk Batch Files
 *
 * Reads all pages for the Sultaniyya edition (book_id=1681) and splits them
 * into numbered chunk files for LLM parsing by Claude subagents.
 *
 * Each chunk contains 50 pages with 2-page overlap between adjacent chunks
 * to ensure heading context (kitab/bab) propagates correctly.
 *
 * Usage:
 *   bun run pipelines/import/export-bukhari-pages.ts
 *   bun run pipelines/import/export-bukhari-pages.ts --book-id=1681 --chunk-size=50
 */

import "../env";
import { prisma } from "../../src/db";
import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";

const CACHE_DIR = resolve(import.meta.dir, "bukhari-pages-cache");
const DEFAULT_BOOK_ID = "1681";
const DEFAULT_CHUNK_SIZE = 50;
const OVERLAP = 2;

function parseArgs(): { bookId: string; chunkSize: number } {
  const args = process.argv.slice(2);
  let bookId = DEFAULT_BOOK_ID;
  let chunkSize = DEFAULT_CHUNK_SIZE;

  for (const arg of args) {
    if (arg.startsWith("--book-id=")) {
      bookId = arg.slice(10);
    } else if (arg.startsWith("--chunk-size=")) {
      chunkSize = parseInt(arg.slice(13), 10) || DEFAULT_CHUNK_SIZE;
    }
  }

  return { bookId, chunkSize };
}

async function main() {
  const { bookId, chunkSize } = parseArgs();

  console.log(`Fetching pages for book_id=${bookId}...`);

  const pages = await prisma.page.findMany({
    where: { bookId },
    orderBy: [{ volumeNumber: "asc" }, { pageNumber: "asc" }],
    select: {
      pageNumber: true,
      volumeNumber: true,
      printedPageNumber: true,
      contentPlain: true,
    },
  });

  if (pages.length === 0) {
    console.log("No pages found. Check book_id.");
    return;
  }

  console.log(`Found ${pages.length} total pages.`);

  // Skip front-matter (volume 0 or pages with no meaningful content)
  const contentPages = pages.filter((p) => {
    if (p.volumeNumber === 0) return false;
    // Skip pages with very little content (likely blank/toc)
    if (p.contentPlain.trim().length < 50) return false;
    return true;
  });

  console.log(`After filtering front-matter: ${contentPages.length} content pages.`);

  mkdirSync(CACHE_DIR, { recursive: true });

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

    // Move forward by chunkSize minus overlap
    startIdx += chunkSize - OVERLAP;
    chunkId++;
  }

  console.log(`Writing ${chunks.length} chunk files (${chunkSize} pages each, ${OVERLAP}-page overlap)...`);

  for (const chunk of chunks) {
    const num = String(chunk.chunkId).padStart(3, "0");
    const filePath = resolve(CACHE_DIR, `chunk-${num}.json`);
    writeFileSync(filePath, JSON.stringify(chunk, null, 2));
    console.log(`  chunk-${num}.json: ${chunk.pages.length} pages (pp. ${chunk.pagesFrom}–${chunk.pagesTo})`);
  }

  console.log(`\nDone. ${chunks.length} chunk files written to ${CACHE_DIR}`);
}

main()
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
