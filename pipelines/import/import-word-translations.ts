/**
 * Import Word-by-Word Quran Translations
 *
 * Fetches per-word translations from the quran.com API v4 and imports
 * them into the database. Currently supports English word-by-word
 * translations.
 *
 * Data Source: https://api.quran.com/api/v4
 *
 * Usage:
 *   bun run pipelines/import/import-word-translations.ts --lang=en [--force]
 */

import "../env";
import { prisma } from "../../src/db";

const QURAN_COM_API = "https://api.quran.com/api/v4";

interface QuranComVerse {
  id: number;
  verse_number: number;
  verse_key: string;
  words: Array<{
    id: number;
    position: number;
    text_uthmani: string;
    char_type_name: string;  // "word" or "end"
    translation: { text: string; language_name: string };
    transliteration: { text: string | null; language_name: string } | null;
  }>;
}

interface QuranComResponse {
  verses: QuranComVerse[];
  pagination: { per_page: number; current_page: number; total_pages: number; total_records: number };
}

/**
 * Fetch verses with word data for a chapter from quran.com API
 */
async function fetchChapterWords(
  chapter: number,
  language: string,
  page: number = 1
): Promise<QuranComResponse | null> {
  const url = `${QURAN_COM_API}/verses/by_chapter/${chapter}?words=true&word_fields=translation,transliteration&per_page=50&page=${page}&language=${language}`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`   Failed to fetch chapter ${chapter} page ${page}: ${response.status}`);
      return null;
    }
    return (await response.json()) as QuranComResponse;
  } catch (error) {
    console.error(`   Error fetching chapter ${chapter} page ${page}:`, error);
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const langArg = args.find((a) => a.startsWith("--lang="));

  const language = langArg ? langArg.split("=")[1].trim() : "en";

  if (!langArg && !args.includes("--force")) {
    console.error("Usage:");
    console.error("  --lang=en            Language to import (default: en)");
    console.error("  --force              Re-import even if already exists");
    process.exit(1);
  }

  console.log("🕌 Word-by-Word Translation Import Script");
  console.log("==========================================");
  console.log(`Language: ${language}`);
  console.log(`Force mode: ${force ? "ON" : "OFF"}`);

  // Check existing count
  if (!force) {
    const existingCount = await prisma.wordTranslation.count({
      where: { language },
    });
    if (existingCount > 0) {
      console.log(`\n⏭️  Already imported ${existingCount} word translations for "${language}".`);
      console.log(`   Use --force to re-import.`);
      await prisma.$disconnect();
      return;
    }
  }

  // Delete existing if forcing
  if (force) {
    const deleted = await prisma.wordTranslation.deleteMany({
      where: { language },
    });
    if (deleted.count > 0) {
      console.log(`🗑️  Deleted ${deleted.count} existing word translations`);
    }
  }

  let totalImported = 0;

  for (let chapter = 1; chapter <= 114; chapter++) {
    let page = 1;
    let totalPages = 1;
    const chapterWords: Array<{
      surahNumber: number;
      ayahNumber: number;
      wordPosition: number;
      language: string;
      text: string;
      transliteration: string | null;
      source: string;
    }> = [];

    while (page <= totalPages) {
      const data = await fetchChapterWords(chapter, language, page);
      if (!data) break;

      totalPages = data.pagination.total_pages;

      for (const verse of data.verses) {
        const [, ayahStr] = verse.verse_key.split(":");
        const ayahNumber = parseInt(ayahStr, 10);

        for (const word of verse.words) {
          // Skip end markers (verse number symbols)
          if (word.char_type_name === "end") continue;

          chapterWords.push({
            surahNumber: chapter,
            ayahNumber,
            wordPosition: word.position,
            language,
            text: word.translation?.text || "",
            transliteration: word.transliteration?.text || null,
            source: "quran.com",
          });
        }
      }

      page++;

      // Small delay between pages
      await new Promise((r) => setTimeout(r, 100));
    }

    // Batch insert chapter words
    if (chapterWords.length > 0) {
      const BATCH_SIZE = 1000;
      for (let i = 0; i < chapterWords.length; i += BATCH_SIZE) {
        const batch = chapterWords.slice(i, i + BATCH_SIZE);
        await prisma.wordTranslation.createMany({
          data: batch,
          skipDuplicates: true,
        });
      }
      totalImported += chapterWords.length;
    }

    process.stdout.write(`   📝 Chapter ${chapter}/114 — ${totalImported} words total\r`);

    // Delay between chapters
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`\n\n✅ Imported ${totalImported} word translations for "${language}"`);
}

main()
  .catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
