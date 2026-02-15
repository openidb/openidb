/**
 * Import QUL translations/tafsirs from downloaded JSON files
 *
 * Fills gaps where the QUL API returned incomplete data but
 * full JSON files were downloaded manually from the QUL website.
 *
 * Usage:
 *   bun run pipelines/import/import-qul-json-files.ts
 */

import "../env";
import { prisma } from "../../src/db";
import { hashAyahTranslation, hashAyahTafsir } from "../../src/utils/content-hash";
import { readFileSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.env.HOME!, "Downloads/temp-check");

function stripHtmlTags(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

interface TranslationEntry {
  t: string;
}

interface TafsirEntry {
  text: string;
}

/**
 * Import a translation JSON file (format: {"1:1": {"t": "text"}, ...})
 * Only imports ayahs that don't already exist in the DB.
 */
async function importTranslation(
  filename: string,
  editionId: string,
  description: string
) {
  console.log(`\n📖 Importing translation: ${description}`);
  console.log(`   Edition: ${editionId}, File: ${filename}`);

  const filePath = join(DATA_DIR, filename);
  const data: Record<string, TranslationEntry> = JSON.parse(
    readFileSync(filePath, "utf-8")
  );

  // Get existing ayahs for this edition
  const existing = await prisma.ayahTranslation.findMany({
    where: { editionId },
    select: { surahNumber: true, ayahNumber: true },
  });
  const existingSet = new Set(
    existing.map((e) => `${e.surahNumber}:${e.ayahNumber}`)
  );

  console.log(`   File entries: ${Object.keys(data).length}`);
  console.log(`   Already in DB: ${existing.length}`);

  // Get language from metadata
  const meta = await prisma.quranTranslation.findUnique({
    where: { id: editionId },
  });
  const language = meta?.language ?? "unknown";

  const rows: Array<{
    surahNumber: number;
    ayahNumber: number;
    editionId: string;
    language: string;
    text: string;
    contentHash: string;
  }> = [];

  for (const [verseKey, entry] of Object.entries(data)) {
    if (!entry.t) continue;
    if (existingSet.has(verseKey)) continue;

    const [surah, ayah] = verseKey.split(":").map(Number);
    if (!surah || !ayah) continue;

    const text = entry.t.trim();
    if (!text) continue;

    rows.push({
      surahNumber: surah,
      ayahNumber: ayah,
      editionId,
      language,
      text,
      contentHash: hashAyahTranslation(surah, ayah, editionId, text),
    });
  }

  if (rows.length === 0) {
    console.log(`   ⚠️  No new ayahs to import`);
    return 0;
  }

  // Batch insert
  const BATCH = 500;
  let imported = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const result = await prisma.ayahTranslation.createMany({
      data: batch,
      skipDuplicates: true,
    });
    imported += result.count;
  }

  console.log(`   ✅ Imported ${imported} new ayahs`);
  return imported;
}

/**
 * Import a tafsir JSON file (format: {"1:1": {"text": "<html>"}, ...})
 * Only imports ayahs that have non-empty text and don't already exist.
 */
async function importTafsir(
  filename: string,
  editionId: string,
  description: string
) {
  console.log(`\n📖 Importing tafsir: ${description}`);
  console.log(`   Edition: ${editionId}, File: ${filename}`);

  const filePath = join(DATA_DIR, filename);
  const data: Record<string, TafsirEntry> = JSON.parse(
    readFileSync(filePath, "utf-8")
  );

  // Get existing entries
  const existing = await prisma.ayahTafsir.findMany({
    where: { editionId },
    select: { surahNumber: true, ayahNumber: true },
  });
  const existingSet = new Set(
    existing.map((e) => `${e.surahNumber}:${e.ayahNumber}`)
  );

  const totalEntries = Object.keys(data).length;
  const withText = Object.values(data).filter(
    (v) => v && v.text && stripHtmlTags(v.text).length > 0
  ).length;

  console.log(`   File entries: ${totalEntries} (${withText} with text)`);
  console.log(`   Already in DB: ${existing.length}`);

  // Get language from metadata
  const meta = await prisma.quranTafsir.findUnique({
    where: { id: editionId },
  });
  const language = meta?.language ?? "ar";

  const rows: Array<{
    surahNumber: number;
    ayahNumber: number;
    editionId: string;
    language: string;
    text: string;
    source: string;
    contentHash: string;
  }> = [];

  for (const [verseKey, entry] of Object.entries(data)) {
    if (!entry || !entry.text) continue;
    if (existingSet.has(verseKey)) continue;

    const [surah, ayah] = verseKey.split(":").map(Number);
    if (!surah || !ayah) continue;

    const text = stripHtmlTags(entry.text);
    if (!text) continue;

    rows.push({
      surahNumber: surah,
      ayahNumber: ayah,
      editionId,
      language,
      text,
      source: editionId,
      contentHash: hashAyahTafsir(surah, ayah, editionId, text),
    });
  }

  if (rows.length === 0) {
    console.log(`   ⚠️  No new entries to import`);
    return 0;
  }

  // Batch insert
  const BATCH = 500;
  let imported = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const result = await prisma.ayahTafsir.createMany({
      data: batch,
      skipDuplicates: true,
    });
    imported += result.count;
  }

  console.log(`   ✅ Imported ${imported} new entries`);
  return imported;
}

/**
 * Ensure tafsir metadata exists for a new edition
 */
async function ensureTafsirMetadata(
  editionId: string,
  name: string,
  language: string,
  author: string
) {
  await prisma.quranTafsir.upsert({
    where: { id: editionId },
    update: {},
    create: {
      id: editionId,
      name,
      language,
      author,
      source: "qul",
      direction: ["ar", "fa", "ur", "he"].includes(language) ? "rtl" : "ltr",
    },
  });
}

async function main() {
  console.log("🕌 QUL JSON File Import Script");
  console.log("=====================================");

  let totalImported = 0;

  // 1. Filipino translation — fill missing surahs 7, 8, 9
  totalImported += await importTranslation(
    "filipino-iranionian-translation-simple.json",
    "qul-1257",
    "Filipino translation — filling 410 missing ayahs (surahs 7, 8, 9)"
  );

  // 2. Al-Wajiz fi Tafsir al-Kitab al-Aziz (al-Wahidi) — new tafsir
  await ensureTafsirMetadata(
    "qul-wajiz-wahidi",
    "Al-Wajiz fi Tafsir al-Kitab al-Aziz (al-Wahidi)",
    "ar",
    "Abu al-Hasan al-Wahidi"
  );
  totalImported += await importTafsir(
    "al-wajiz-wahidi.json",
    "qul-wajiz-wahidi",
    "Al-Wajiz al-Wahidi — 1,645 entries (new tafsir)"
  );

  // 3. Ibn Kathir (Dar Ibn al-Jawzi edition) — fill empty edition
  totalImported += await importTafsir(
    "ar-tafsir-ibn-kathir.json",
    "qul-1525",
    "Tafsir Ibn Kathir (Dar Ibn al-Jawzi) — 1,911 entries"
  );

  console.log("\n=====================================");
  console.log(`📊 Total imported: ${totalImported}`);
  console.log("✅ Done!");

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
