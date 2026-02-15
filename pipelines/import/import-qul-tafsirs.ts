/**
 * Import QUL (Tarteel AI) Quran Tafsirs
 *
 * Fetches tafsirs from the Quranic Universal Library API
 * and imports them into the database. QUL offers 114 tafsir editions
 * (32 mukhtasar + 82 detailed) — far more than the 27 from spa5k.
 *
 * Key difference from spa5k tafsirs: QUL tafsirs can group multiple ayahs
 * (e.g. verses: ["2:285", "2:286"]). We duplicate the text for each ayah.
 *
 * Data Source: https://qul.tarteel.ai
 * API: https://qul.tarteel.ai/api/v1
 *
 * Usage:
 *   bun run pipelines/import/import-qul-tafsirs.ts --all [--force]
 *   bun run pipelines/import/import-qul-tafsirs.ts --lang=ar,en
 *   bun run pipelines/import/import-qul-tafsirs.ts --id=14,90
 */

import "../env";
import { prisma } from "../../src/db";
import { hashAyahTafsir } from "../../src/utils/content-hash";
import {
  fetchQulTafsirEditions,
  syncQulTafsirMetadata,
  QUL_API_BASE,
  type QulTafsirEdition,
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

interface QulTafsirResponse {
  tafsirs: Array<{
    id: number;
    verses: string[];      // ["1:1"] or ["2:285", "2:286"] (grouped)
    resource_id: number;
    resource_name: string;
    language_name: string;
    text: string;
  }>;
}

/**
 * Strip HTML tags from tafsir text, preserving paragraph breaks
 */
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

/**
 * Fetch tafsir for a surah from QUL API
 */
async function fetchQulSurahTafsir(
  resourceId: number,
  surahNumber: number,
  ayahCount: number
): Promise<QulTafsirResponse["tafsirs"] | null> {
  const url = `${QUL_API_BASE}/tafsirs/${resourceId}/by_range?from=${surahNumber}:1&to=${surahNumber}:${ayahCount}`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      if (response.status === 404) return null;
      console.error(`   Failed to fetch surah ${surahNumber}: ${response.status}`);
      return null;
    }
    const data: QulTafsirResponse = await response.json();
    return data.tafsirs;
  } catch (error) {
    console.error(`   Error fetching surah ${surahNumber}:`, error);
    return null;
  }
}

/**
 * Import a single QUL tafsir edition
 */
async function importEdition(
  edition: QulTafsirEdition,
  force: boolean
): Promise<{ imported: number; skipped: boolean }> {
  console.log(`\n📖 [${edition.id}] ${edition.name} (${edition.language})...`);

  // Check if already imported
  if (!force) {
    const existingCount = await prisma.ayahTafsir.count({
      where: { editionId: edition.id },
    });
    if (existingCount > 0) {
      console.log(`   ⏭️  Already imported (${existingCount} entries). Use --force to re-import.`);
      return { imported: 0, skipped: true };
    }
  }

  // Delete existing if forcing
  if (force) {
    const deleted = await prisma.ayahTafsir.deleteMany({
      where: { editionId: edition.id },
    });
    if (deleted.count > 0) {
      console.log(`   🗑️  Deleted ${deleted.count} existing entries`);
    }
  }

  let totalImported = 0;
  let emptyCount = 0;

  for (let surah = 1; surah <= 114; surah++) {
    const ayahCount = SURAH_AYAH_COUNTS[surah];
    const entries = await fetchQulSurahTafsir(edition.resourceId, surah, ayahCount);

    if (!entries || entries.length === 0) {
      emptyCount++;
      if (emptyCount >= 5 && totalImported === 0) {
        console.log(`   ⚠️  No data available for this resource (${emptyCount} empty surahs)`);
        return { imported: 0, skipped: false };
      }
      continue;
    }

    // Expand grouped ayahs: if verses: ["2:285","2:286"], create entry for each
    const data: Array<{
      surahNumber: number;
      ayahNumber: number;
      source: string;
      editionId: string;
      language: string;
      text: string;
      contentHash: string;
    }> = [];

    for (const entry of entries) {
      const cleanText = stripHtmlTags(entry.text);
      if (!cleanText) continue;

      for (const verseKey of entry.verses) {
        const [surahStr, ayahStr] = verseKey.split(":");
        const surahNum = parseInt(surahStr, 10);
        const ayahNum = parseInt(ayahStr, 10);

        // Only include entries for the current surah (safety check)
        if (surahNum !== surah) continue;

        data.push({
          surahNumber: surahNum,
          ayahNumber: ayahNum,
          source: edition.id,
          editionId: edition.id,
          language: edition.language,
          text: cleanText,
          contentHash: hashAyahTafsir(surahNum, ayahNum, edition.id, cleanText),
        });
      }
    }

    if (data.length > 0) {
      await prisma.ayahTafsir.createMany({
        data,
        skipDuplicates: true,
      });
      totalImported += data.length;
    }

    process.stdout.write(`   📝 Surah ${surah}/114 — ${totalImported} entries total\r`);

    // Small delay to be respectful to the API
    await new Promise((r) => setTimeout(r, 50));
  }

  console.log(`   ✅ Imported ${totalImported} entries`);
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
    console.error("  --all                Import all available QUL tafsir editions");
    console.error("  --lang=ar,en         Import editions for specific languages");
    console.error("  --id=14,90           Import specific QUL resource IDs");
    console.error("  --force              Re-import even if already exists");
    process.exit(1);
  }

  console.log("🕌 QUL Quran Tafsir Import Script");
  console.log("=====================================");
  console.log(`Force mode: ${force ? "ON" : "OFF"}`);

  // Fetch all available editions
  console.log("Fetching available editions from QUL API...");
  const allEditions = await fetchQulTafsirEditions();
  console.log(`Found ${allEditions.length} QUL tafsir editions`);

  // Sync metadata
  console.log("Syncing tafsir metadata...");
  const synced = await syncQulTafsirMetadata(allEditions);
  console.log(`Synced ${synced} tafsir metadata rows`);

  // Filter editions
  let editions: QulTafsirEdition[];
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
  console.log(`   Total entries imported: ${totalImported}`);
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
