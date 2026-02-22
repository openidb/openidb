/**
 * Import mushaf word layout data into Postgres
 *
 * Reads the words-qul.json file scraped by scrape-qul-mushaf-layout.ts
 * and bulk inserts into the mushaf_words table.
 *
 * Also enriches words with textUthmani from the ayahs table.
 *
 * Usage:
 *   bun run pipelines/import/import-mushaf-layout.ts [--force]
 */

import "../env";
import { prisma } from "../../src/db";
import { readFileSync } from "fs";
import { join } from "path";

const DATA_PATH = join(import.meta.dirname, "../../data/mushaf/words-qul.json");

interface MushafWordData {
  pageNumber: number;
  lineNumber: number;
  lineType: string;
  positionInLine: number;
  charTypeName: string;
  surahNumber: number;
  ayahNumber: number;
  wordPosition: number;
  textUthmani: string;
  glyphCode: string;
}

async function main() {
  const force = process.argv.includes("--force");

  console.log("Mushaf Layout Import (QUL Resource 19)");
  console.log("======================================");

  // Check existing count
  const existing = await prisma.mushafWord.count();
  if (existing > 0 && !force) {
    console.log(`Already have ${existing} mushaf words. Use --force to reimport.`);
    await prisma.$disconnect();
    return;
  }

  if (existing > 0 && force) {
    console.log(`Deleting ${existing} existing mushaf words...`);
    await prisma.mushafWord.deleteMany();
  }

  console.log(`Reading ${DATA_PATH}...`);
  const words: MushafWordData[] = JSON.parse(readFileSync(DATA_PATH, "utf-8"));
  console.log(`Loaded ${words.length} words from JSON`);

  // Batch insert
  const BATCH_SIZE = 5000;
  let imported = 0;

  for (let i = 0; i < words.length; i += BATCH_SIZE) {
    const batch = words.slice(i, i + BATCH_SIZE);
    const result = await prisma.mushafWord.createMany({
      data: batch.map((w) => ({
        pageNumber: w.pageNumber,
        lineNumber: w.lineNumber,
        lineType: w.lineType,
        positionInLine: w.positionInLine,
        charTypeName: w.charTypeName,
        surahNumber: w.surahNumber,
        ayahNumber: w.ayahNumber,
        wordPosition: w.wordPosition,
        textUthmani: w.textUthmani,
        glyphCode: w.glyphCode,
      })),
      skipDuplicates: true,
    });
    imported += result.count;

    if ((i + BATCH_SIZE) % 20000 === 0 || i + BATCH_SIZE >= words.length) {
      console.log(`  Progress: ${Math.min(i + BATCH_SIZE, words.length)}/${words.length} (${imported} inserted)`);
    }
  }

  // Verify
  const total = await prisma.mushafWord.count();
  const pageCount = await prisma.mushafWord.groupBy({
    by: ["pageNumber"],
    _count: true,
  });

  console.log(`\nImported ${imported} mushaf words`);
  console.log(`Total in DB: ${total}`);
  console.log(`Pages covered: ${pageCount.length}`);

  // Line type stats
  const lineTypeStats = await prisma.mushafWord.groupBy({
    by: ["lineType"],
    _count: true,
  });
  console.log("Line types:", lineTypeStats.map((s) => `${s.lineType}: ${s._count}`).join(", "));

  console.log("Done!");
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
