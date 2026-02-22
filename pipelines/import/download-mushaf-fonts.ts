/**
 * Download mushaf fonts and data for the Quran Mushaf Viewer
 *
 * Downloads:
 * - 604 QPC V2 WOFF2 page fonts → frontend/web/public/fonts/mushaf/v2/
 * - QPC Hafs Unicode font → frontend/web/public/fonts/mushaf/
 * - Surah Header ligature font → frontend/web/public/fonts/mushaf/
 * - Common/Juz ligature font → frontend/web/public/fonts/mushaf/
 *
 * Also fetches mushaf word data from quran.com API v4 (all 604 pages)
 * and saves to api/data/mushaf/words.json
 *
 * Usage:
 *   bun run pipelines/import/download-mushaf-fonts.ts [--fonts-only] [--data-only]
 */

import { mkdirSync, existsSync, writeFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dirname, "../../../");
const FONT_DIR = join(ROOT, "frontend/web/public/fonts/mushaf");
const V2_DIR = join(FONT_DIR, "v2");
const DATA_DIR = join(ROOT, "api/data/mushaf");

// CDN base for QPC V2 per-page fonts (quran.com foundation CDN)
const V2_CDN_BASE = "https://verses.quran.foundation/fonts/quran/hafs/v2/woff2";

// Static font CDN (Tarteel)
const TARTEEL_CDN = "https://static-cdn.tarteel.ai/qul/fonts";

// Font URLs
const FONTS: Record<string, string> = {
  "UthmanicHafs_V22.woff2": `${TARTEEL_CDN}/UthmanicHafs_V22.woff2`,
  "QCF_SurahHeader_COLOR-Regular.woff2": `${TARTEEL_CDN}/QCF_SurahHeader_COLOR-Regular.woff2`,
  "QCF_Bismillah.woff2": `${TARTEEL_CDN}/QCF_Bismillah.woff2`,
};

const TOTAL_PAGES = 604;
const CONCURRENCY = 20;

async function downloadFile(url: string, dest: string): Promise<boolean> {
  if (existsSync(dest)) return true;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`  Failed: ${url} → ${res.status}`);
      return false;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(dest, buf);
    return true;
  } catch (e: any) {
    console.error(`  Error downloading ${url}: ${e.message}`);
    return false;
  }
}

async function downloadV2Fonts() {
  console.log(`\nDownloading ${TOTAL_PAGES} QPC V2 page fonts...`);
  mkdirSync(V2_DIR, { recursive: true });

  let downloaded = 0;
  let skipped = 0;

  for (let batch = 1; batch <= TOTAL_PAGES; batch += CONCURRENCY) {
    const promises: Promise<boolean>[] = [];
    for (let p = batch; p < Math.min(batch + CONCURRENCY, TOTAL_PAGES + 1); p++) {
      const url = `${V2_CDN_BASE}/p${p}.woff2`;
      const dest = join(V2_DIR, `p${p}.woff2`);

      if (existsSync(dest)) {
        skipped++;
        continue;
      }

      promises.push(
        downloadFile(url, dest).then((ok) => {
          if (ok) downloaded++;
          return ok;
        })
      );
    }
    if (promises.length > 0) {
      await Promise.all(promises);
    }

    const total = Math.min(batch + CONCURRENCY - 1, TOTAL_PAGES);
    if (total % 100 === 0 || total === TOTAL_PAGES) {
      console.log(`  Progress: ${total}/${TOTAL_PAGES} (${downloaded} new, ${skipped} existing)`);
    }
  }

  console.log(`  Done: ${downloaded} downloaded, ${skipped} already existed`);
}

async function downloadStaticFonts() {
  console.log("\nDownloading static mushaf fonts...");
  mkdirSync(FONT_DIR, { recursive: true });

  for (const [filename, url] of Object.entries(FONTS)) {
    const dest = join(FONT_DIR, filename);
    const existed = existsSync(dest);
    const ok = await downloadFile(url, dest);
    console.log(`  ${filename}: ${existed ? "already exists" : ok ? "downloaded" : "FAILED"}`);
  }
}

interface QuranComWord {
  id: number;
  position: number;
  char_type_name: string;
  code_v2: string;
  line_number: number;
  page_number: number;
  text_uthmani: string;
  verse_key: string;
}

interface MushafWord {
  pageNumber: number;
  lineNumber: number;
  positionInLine: number;
  charTypeName: string;
  surahNumber: number;
  ayahNumber: number;
  wordPosition: number;
  textUthmani: string;
  glyphCode: string;
}

async function fetchPageData(page: number): Promise<MushafWord[]> {
  const url = `https://api.quran.com/api/v4/verses/by_page/${page}?words=true&word_fields=code_v2,line_number,page_number,position,char_type_name,text_uthmani&per_page=50`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error for page ${page}: ${res.status}`);

  const data = await res.json();
  const words: MushafWord[] = [];

  for (const verse of data.verses) {
    const [surah, ayah] = verse.verse_key.split(":").map(Number);
    for (const word of verse.words) {
      words.push({
        pageNumber: word.page_number,
        lineNumber: word.line_number,
        positionInLine: word.position,
        charTypeName: word.char_type_name,
        surahNumber: surah,
        ayahNumber: ayah,
        wordPosition: word.position,
        textUthmani: word.text_uthmani || "",
        glyphCode: word.code_v2 || "",
      });
    }
  }

  return words;
}

async function downloadMushafData() {
  console.log(`\nFetching mushaf word data from quran.com API (${TOTAL_PAGES} pages)...`);
  mkdirSync(DATA_DIR, { recursive: true });

  const outputPath = join(DATA_DIR, "words.json");
  if (existsSync(outputPath)) {
    console.log("  words.json already exists, skipping. Delete to re-download.");
    return;
  }

  const allWords: MushafWord[] = [];
  const API_CONCURRENCY = 5; // Rate-limit friendly

  for (let batch = 1; batch <= TOTAL_PAGES; batch += API_CONCURRENCY) {
    const promises: Promise<MushafWord[]>[] = [];
    for (let p = batch; p < Math.min(batch + API_CONCURRENCY, TOTAL_PAGES + 1); p++) {
      promises.push(fetchPageData(p));
    }

    const results = await Promise.all(promises);
    for (const words of results) {
      allWords.push(...words);
    }

    const total = Math.min(batch + API_CONCURRENCY - 1, TOTAL_PAGES);
    if (total % 50 === 0 || total === TOTAL_PAGES) {
      console.log(`  Progress: ${total}/${TOTAL_PAGES} pages (${allWords.length} words so far)`);
    }

    // Small delay between batches to be nice to the API
    if (batch + API_CONCURRENCY <= TOTAL_PAGES) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  writeFileSync(outputPath, JSON.stringify(allWords));
  console.log(`  Saved ${allWords.length} words to ${outputPath}`);
}

async function main() {
  const args = process.argv.slice(2);
  const fontsOnly = args.includes("--fonts-only");
  const dataOnly = args.includes("--data-only");

  console.log("Mushaf Font & Data Downloader");
  console.log("===============================");

  if (!dataOnly) {
    await downloadStaticFonts();
    await downloadV2Fonts();
  }

  if (!fontsOnly) {
    await downloadMushafData();
  }

  console.log("\nDone!");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
