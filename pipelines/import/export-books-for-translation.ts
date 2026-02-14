/**
 * Export Books for Title Translation
 *
 * Exports books with context (author, category) to numbered batch JSON files
 * for processing by Claude subagents.
 *
 * Usage:
 *   bun run pipelines/import/export-books-for-translation.ts --batch-size=50
 */

import "../env";
import { prisma } from "../../src/db";
import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";

const BATCH_DIR = resolve(import.meta.dir, "book-title-batches");

function parseArgs(): { batchSize: number } {
  const args = process.argv.slice(2);
  let batchSize = 50;

  for (const arg of args) {
    if (arg.startsWith("--batch-size=")) {
      batchSize = parseInt(arg.slice(13), 10) || 50;
    }
  }

  return { batchSize };
}

async function main() {
  const { batchSize } = parseArgs();

  console.log("Fetching all books with author and category context...");

  const books = await prisma.book.findMany({
    select: {
      id: true,
      titleArabic: true,
      titleLatin: true,
      author: {
        select: {
          nameArabic: true,
          nameLatin: true,
        },
      },
      category: {
        select: {
          nameArabic: true,
          nameEnglish: true,
        },
      },
    },
    orderBy: { id: "asc" },
  });

  console.log(`Found ${books.length} books.`);

  if (books.length === 0) {
    console.log("Nothing to export.");
    return;
  }

  mkdirSync(BATCH_DIR, { recursive: true });

  const totalBatches = Math.ceil(books.length / batchSize);
  console.log(`Writing ${totalBatches} batch files (${batchSize} books each)...`);

  for (let i = 0; i < totalBatches; i++) {
    const batch = books.slice(i * batchSize, (i + 1) * batchSize);
    const batchNum = String(i + 1).padStart(3, "0");
    const filePath = resolve(BATCH_DIR, `batch-${batchNum}.json`);
    writeFileSync(filePath, JSON.stringify(batch, null, 2));
    console.log(`  batch-${batchNum}.json: ${batch.length} books`);
  }

  console.log(`\nDone. ${totalBatches} batch files written to ${BATCH_DIR}`);
}

main()
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
