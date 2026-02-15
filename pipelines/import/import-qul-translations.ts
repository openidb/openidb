/**
 * Import QUL (Tarteel AI) Quran Translations
 *
 * Fetches translations from the Quranic Universal Library API
 * and imports them into the database. QUL offers 193 curated translations
 * across 75+ languages.
 *
 * Data Source: https://qul.tarteel.ai
 * API: https://qul.tarteel.ai/api/v1
 *
 * Usage:
 *   bun run pipelines/import/import-qul-translations.ts --all [--force]
 *   bun run pipelines/import/import-qul-translations.ts --lang=en,ar
 *   bun run pipelines/import/import-qul-translations.ts --id=20,85
 */

import "../env";
import { prisma } from "../../src/db";
import { hashAyahTranslation } from "../../src/utils/content-hash";
import {
  fetchQulTranslationEditions,
  syncQulTranslationMetadata,
  QUL_API_BASE,
  type QulTranslationEdition,
} from "./quran-resources";

// Ayah counts per surah (1-indexed)
const SURAH_AYAH_COUNTS = [
  0, 7, 286, 200, 176, 120, 165, 206, 75, 129, 109, 123, 111, 43, 52, 99,
  128, 111, 110, 98, 135, 112, 78, 118, 64, 77, 227, 93, 88, 69, 60, 34, 30,
  73, 54, 45, 83, 182, 88, 75, 85, 54, 53, 89, 59, 37, 35, 38, 29, 18, 45,
  60, 49, 62, 55, 78, 96, 29, 22, 24, 13, 14, 11, 11, 18, 12, 12, 30, 52,
  52, 44, 28, 28, 20, 56, 40, 31, 50, 40, 46, 42, 29, 19, 36, 25, 22, 17,
  19, 26, 30, 20, 15, 21, 11, 8, 8, 19, 5, 8, 8, 11, 11, 8, 3, 9, 5, 4, 7,
  3, 6, 3, 5, 4, 5, 6,
];

interface QulTranslationResponse {
  translations: Array<{
    id: number;
    verse_key: string;     // "1:1"
    resource_id: number;
    resource_name: string;
    language_id: number;
    language_name: string;
    text: string;
  }>;
}

/**
 * Strip HTML tags from translation text
 */
function stripHtmlTags(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fetch translations for a surah from QUL API
 */
async function fetchQulSurahTranslations(
  resourceId: number,
  surahNumber: number,
  ayahCount: number
): Promise<QulTranslationResponse["translations"] | null> {
  const url = `${QUL_API_BASE}/translations/${resourceId}/by_range?from=${surahNumber}:1&to=${surahNumber}:${ayahCount}`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      if (response.status === 404) return null;
      console.error(`   Failed to fetch surah ${surahNumber}: ${response.status}`);
      return null;
    }
    const data: QulTranslationResponse = await response.json();
    return data.translations;
  } catch (error) {
    console.error(`   Error fetching surah ${surahNumber}:`, error);
    return null;
  }
}

/**
 * Import a single QUL translation edition
 */
async function importEdition(
  edition: QulTranslationEdition,
  force: boolean
): Promise<{ imported: number; skipped: boolean }> {
  console.log(`\n📖 [${edition.id}] ${edition.name} (${edition.language})...`);

  // Check if already imported
  if (!force) {
    const existingCount = await prisma.ayahTranslation.count({
      where: { editionId: edition.id },
    });
    if (existingCount > 0) {
      console.log(`   ⏭️  Already imported (${existingCount} ayahs). Use --force to re-import.`);
      return { imported: 0, skipped: true };
    }
  }

  // Delete existing if forcing
  if (force) {
    const deleted = await prisma.ayahTranslation.deleteMany({
      where: { editionId: edition.id },
    });
    if (deleted.count > 0) {
      console.log(`   🗑️  Deleted ${deleted.count} existing translations`);
    }
  }

  let totalImported = 0;
  let emptyCount = 0;

  for (let surah = 1; surah <= 114; surah++) {
    const ayahCount = SURAH_AYAH_COUNTS[surah];
    const entries = await fetchQulSurahTranslations(edition.resourceId, surah, ayahCount);

    if (!entries || entries.length === 0) {
      emptyCount++;
      if (emptyCount >= 5 && totalImported === 0) {
        console.log(`   ⚠️  No data available for this resource (${emptyCount} empty surahs)`);
        return { imported: 0, skipped: false };
      }
      continue;
    }

    const data = entries.map((entry) => {
      const [, ayahStr] = entry.verse_key.split(":");
      const ayahNumber = parseInt(ayahStr, 10);
      const cleanText = stripHtmlTags(entry.text);
      return {
        surahNumber: surah,
        ayahNumber,
        language: edition.language,
        editionId: edition.id,
        text: cleanText,
        contentHash: hashAyahTranslation(surah, ayahNumber, edition.id, cleanText),
      };
    });

    await prisma.ayahTranslation.createMany({
      data,
      skipDuplicates: true,
    });

    totalImported += data.length;
    process.stdout.write(`   📝 Surah ${surah}/114 — ${totalImported} ayahs total\r`);

    // Small delay to be respectful to the API
    await new Promise((r) => setTimeout(r, 50));
  }

  console.log(`   ✅ Imported ${totalImported} ayahs`);
  return { imported: totalImported, skipped: false };
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const all = args.includes("--all");
  const langArg = args.find((a) => a.startsWith("--lang="));
  const idArg = args.find((a) => a.startsWith("--id="));

  const selectedLangs = langArg
    ? langArg.split("=")[1].split(",").map((l) => l.trim())
    : null;
  const selectedIds = idArg
    ? idArg.split("=")[1].split(",").map((id) => parseInt(id.trim(), 10))
    : null;

  if (!all && !selectedLangs && !selectedIds) {
    console.error("Usage:");
    console.error("  --all                Import all available QUL editions");
    console.error("  --lang=en,ar         Import editions for specific languages");
    console.error("  --id=20,85           Import specific QUL resource IDs");
    console.error("  --force              Re-import even if already exists");
    process.exit(1);
  }

  console.log("🕌 QUL Quran Translations Import Script");
  console.log("=====================================");
  console.log(`Force mode: ${force ? "ON" : "OFF"}`);

  // Fetch all available editions
  console.log("Fetching available editions from QUL API...");
  const allEditions = await fetchQulTranslationEditions();
  console.log(`Found ${allEditions.length} QUL translation editions`);

  // Sync metadata
  console.log("Syncing translation metadata...");
  const synced = await syncQulTranslationMetadata(allEditions);
  console.log(`Synced ${synced} translation metadata rows`);

  // Filter editions
  let editions: QulTranslationEdition[];
  if (selectedIds) {
    editions = allEditions.filter((e) => selectedIds.includes(e.resourceId));
    if (editions.length === 0) {
      console.error(`No editions found for IDs: ${selectedIds.join(", ")}`);
      const sample = allEditions.slice(0, 10).map((e) => `  ${e.resourceId} → ${e.id} (${e.language}) ${e.name}`);
      console.error("Sample editions:\n" + sample.join("\n"));
      process.exit(1);
    }
  } else if (selectedLangs) {
    editions = allEditions.filter((e) => selectedLangs.includes(e.language));
    console.log(`Filtered to ${editions.length} editions for languages: ${selectedLangs.join(", ")}`);
  } else {
    editions = allEditions;
  }

  if (editions.length === 0) {
    console.error("No editions match the given filters.");
    process.exit(1);
  }

  console.log(`\nImporting ${editions.length} editions...`);

  let totalImported = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (let i = 0; i < editions.length; i++) {
    const edition = editions[i];
    console.log(`\n[${i + 1}/${editions.length}]`);
    try {
      const { imported, skipped } = await importEdition(edition, force);
      totalImported += imported;
      if (skipped) totalSkipped++;
    } catch (error) {
      console.error(`   ❌ Error importing ${edition.id}:`, error);
      totalFailed++;
    }
  }

  console.log("\n=====================================");
  console.log(`📊 Summary:`);
  console.log(`   Editions processed: ${editions.length}`);
  console.log(`   Total ayahs imported: ${totalImported}`);
  console.log(`   Editions skipped: ${totalSkipped}`);
  console.log(`   Editions failed: ${totalFailed}`);
  console.log("✅ Done!");
}

main()
  .catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
