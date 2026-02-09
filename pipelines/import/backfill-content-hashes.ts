/**
 * Backfill Content Hashes
 *
 * Computes SHA-256 content hashes for all existing records that have
 * contentHash IS NULL. Processes in batches for efficiency.
 *
 * Usage:
 *   bun run pipelines/import/backfill-content-hashes.ts --all
 *   bun run pipelines/import/backfill-content-hashes.ts --model=ayah,hadith
 *   bun run pipelines/import/backfill-content-hashes.ts --model=page,pageTranslation
 */

import "./env";
import { prisma } from "../../src/db";
import {
  hashAyah,
  hashAyahTranslation,
  hashAyahTafsir,
  hashHadith,
  hashHadithTranslation,
  hashPage,
  hashPageTranslation,
} from "../../src/utils/content-hash";

const BATCH_SIZE = 500;

type ModelName = "ayah" | "ayahTranslation" | "ayahTafsir" | "hadith" | "hadithTranslation" | "page" | "pageTranslation";

const ALL_MODELS: ModelName[] = [
  "ayah", "ayahTranslation", "ayahTafsir",
  "hadith", "hadithTranslation",
  "page", "pageTranslation",
];

async function backfillAyahs(): Promise<number> {
  let updated = 0;
  let batch;

  do {
    batch = await prisma.ayah.findMany({
      where: { contentHash: null },
      select: { id: true, surahId: true, ayahNumber: true, textUthmani: true, surah: { select: { number: true } } },
      take: BATCH_SIZE,
    });

    for (const row of batch) {
      await prisma.ayah.update({
        where: { id: row.id },
        data: { contentHash: hashAyah(row.surah.number, row.ayahNumber, row.textUthmani) },
      });
      updated++;
    }

    if (batch.length > 0) {
      process.stdout.write(`  Ayah: ${updated} updated\r`);
    }
  } while (batch.length === BATCH_SIZE);

  return updated;
}

async function backfillAyahTranslations(): Promise<number> {
  let updated = 0;
  let batch;

  do {
    batch = await prisma.ayahTranslation.findMany({
      where: { contentHash: null },
      select: { id: true, surahNumber: true, ayahNumber: true, editionId: true, text: true },
      take: BATCH_SIZE,
    });

    for (const row of batch) {
      await prisma.ayahTranslation.update({
        where: { id: row.id },
        data: { contentHash: hashAyahTranslation(row.surahNumber, row.ayahNumber, row.editionId, row.text) },
      });
      updated++;
    }

    if (batch.length > 0) {
      process.stdout.write(`  AyahTranslation: ${updated} updated\r`);
    }
  } while (batch.length === BATCH_SIZE);

  return updated;
}

async function backfillAyahTafsirs(): Promise<number> {
  let updated = 0;
  let batch;

  do {
    batch = await prisma.ayahTafsir.findMany({
      where: { contentHash: null },
      select: { id: true, surahNumber: true, ayahNumber: true, editionId: true, text: true },
      take: BATCH_SIZE,
    });

    for (const row of batch) {
      await prisma.ayahTafsir.update({
        where: { id: row.id },
        data: { contentHash: hashAyahTafsir(row.surahNumber, row.ayahNumber, row.editionId, row.text) },
      });
      updated++;
    }

    if (batch.length > 0) {
      process.stdout.write(`  AyahTafsir: ${updated} updated\r`);
    }
  } while (batch.length === BATCH_SIZE);

  return updated;
}

async function backfillHadiths(): Promise<number> {
  let updated = 0;
  let batch;

  do {
    batch = await prisma.hadith.findMany({
      where: { contentHash: null },
      select: {
        id: true,
        hadithNumber: true,
        textArabic: true,
        book: {
          select: { collection: { select: { slug: true } } },
        },
      },
      take: BATCH_SIZE,
    });

    for (const row of batch) {
      await prisma.hadith.update({
        where: { id: row.id },
        data: { contentHash: hashHadith(row.book.collection.slug, row.hadithNumber, row.textArabic) },
      });
      updated++;
    }

    if (batch.length > 0) {
      process.stdout.write(`  Hadith: ${updated} updated\r`);
    }
  } while (batch.length === BATCH_SIZE);

  return updated;
}

async function backfillHadithTranslations(): Promise<number> {
  let updated = 0;
  let batch;

  do {
    batch = await prisma.hadithTranslation.findMany({
      where: { contentHash: null },
      select: {
        id: true,
        hadithNumber: true,
        language: true,
        text: true,
        bookId: true,
      },
      take: BATCH_SIZE,
    });

    if (batch.length === 0) break;

    // Fetch collection slugs for all books in this batch
    const bookIds = [...new Set(batch.map((r) => r.bookId))];
    const books = await prisma.hadithBook.findMany({
      where: { id: { in: bookIds } },
      select: { id: true, collection: { select: { slug: true } } },
    });
    const slugMap = new Map(books.map((b) => [b.id, b.collection.slug]));

    for (const row of batch) {
      const slug = slugMap.get(row.bookId);
      if (!slug) continue;
      await prisma.hadithTranslation.update({
        where: { id: row.id },
        data: { contentHash: hashHadithTranslation(slug, row.hadithNumber, row.language, row.text) },
      });
      updated++;
    }

    process.stdout.write(`  HadithTranslation: ${updated} updated\r`);
  } while (batch.length === BATCH_SIZE);

  return updated;
}

async function backfillPages(): Promise<number> {
  let updated = 0;
  let batch;

  do {
    batch = await prisma.page.findMany({
      where: { contentHash: null },
      select: { id: true, bookId: true, pageNumber: true, contentPlain: true },
      take: BATCH_SIZE,
    });

    for (const row of batch) {
      await prisma.page.update({
        where: { id: row.id },
        data: { contentHash: hashPage(row.bookId, row.pageNumber, row.contentPlain) },
      });
      updated++;
    }

    if (batch.length > 0) {
      process.stdout.write(`  Page: ${updated} updated\r`);
    }
  } while (batch.length === BATCH_SIZE);

  return updated;
}

async function backfillPageTranslations(): Promise<number> {
  let updated = 0;
  let batch;

  do {
    batch = await prisma.pageTranslation.findMany({
      where: { contentHash: null },
      select: {
        id: true,
        language: true,
        paragraphs: true,
        page: { select: { bookId: true, pageNumber: true } },
      },
      take: BATCH_SIZE,
    });

    for (const row of batch) {
      await prisma.pageTranslation.update({
        where: { id: row.id },
        data: {
          contentHash: hashPageTranslation(
            row.page.bookId,
            row.page.pageNumber,
            row.language,
            row.paragraphs,
          ),
        },
      });
      updated++;
    }

    if (batch.length > 0) {
      process.stdout.write(`  PageTranslation: ${updated} updated\r`);
    }
  } while (batch.length === BATCH_SIZE);

  return updated;
}

const BACKFILL_MAP: Record<ModelName, () => Promise<number>> = {
  ayah: backfillAyahs,
  ayahTranslation: backfillAyahTranslations,
  ayahTafsir: backfillAyahTafsirs,
  hadith: backfillHadiths,
  hadithTranslation: backfillHadithTranslations,
  page: backfillPages,
  pageTranslation: backfillPageTranslations,
};

async function main() {
  const args = process.argv.slice(2);
  const allFlag = args.includes("--all");
  const modelArg = args.find((a) => a.startsWith("--model="));

  let models: ModelName[];

  if (allFlag) {
    models = ALL_MODELS;
  } else if (modelArg) {
    const requested = modelArg.split("=")[1].split(",").map((m) => m.trim()) as ModelName[];
    const invalid = requested.filter((m) => !ALL_MODELS.includes(m));
    if (invalid.length > 0) {
      console.error(`Unknown models: ${invalid.join(", ")}`);
      console.error(`Valid models: ${ALL_MODELS.join(", ")}`);
      process.exit(1);
    }
    models = requested;
  } else {
    console.error("Usage:");
    console.error("  --all                          Backfill all models");
    console.error("  --model=ayah,hadith,page       Backfill specific models");
    console.error(`\nValid models: ${ALL_MODELS.join(", ")}`);
    process.exit(1);
  }

  console.log("Content Hash Backfill");
  console.log("=".repeat(60));
  console.log(`Models: ${models.join(", ")}\n`);

  const results: Record<string, number> = {};

  for (const model of models) {
    const fn = BACKFILL_MAP[model];
    const count = await fn();
    results[model] = count;
    console.log(`  ${model}: ${count} records updated`);
  }

  console.log("\n" + "=".repeat(60));
  console.log("Summary:");
  for (const [model, count] of Object.entries(results)) {
    console.log(`  ${model.padEnd(20)} ${count}`);
  }
  const total = Object.values(results).reduce((a, b) => a + b, 0);
  console.log(`  ${"TOTAL".padEnd(20)} ${total}`);
  console.log("=".repeat(60));
}

main()
  .catch((error) => {
    console.error("Backfill failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
