/**
 * Scrape mushaf word layout data from QUL (Quranic Universal Library)
 * Resource 19: KFGQPC V4 layout (1441H print)
 *
 * Scrapes all 604 pages and outputs words-qul.json for import-mushaf-layout.ts
 *
 * Usage:
 *   bun run pipelines/import/scrape-qul-mushaf-layout.ts [--pages=1-604] [--concurrency=5]
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const QUL_BASE = "https://qul.tarteel.ai/resources/mushaf-layout/19";
const OUTPUT_DIR = join(import.meta.dirname, "../../data/mushaf");
const OUTPUT_PATH = join(OUTPUT_DIR, "words-qul.json");
const TOTAL_PAGES = 604;

interface ScrapedWord {
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

function parsePageRange(): [number, number] {
  const arg = process.argv.find((a) => a.startsWith("--pages="));
  if (arg) {
    const [start, end] = arg.replace("--pages=", "").split("-").map(Number);
    return [start, end || start];
  }
  return [1, TOTAL_PAGES];
}

function getConcurrency(): number {
  const arg = process.argv.find((a) => a.startsWith("--concurrency="));
  return arg ? Number(arg.replace("--concurrency=", "")) : 5;
}

async function fetchPage(pageNum: number): Promise<string> {
  const url = `${QUL_BASE}?page=${pageNum}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      Accept: "text/html",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for page ${pageNum}`);
  return res.text();
}

function parsePage(html: string, pageNum: number): ScrapedWord[] {
  const words: ScrapedWord[] = [];

  // Extract turbo-frame content
  const frameMatch = html.match(/<turbo-frame[^>]*>([\s\S]*?)<\/turbo-frame>/);
  if (!frameMatch) {
    console.warn(`  Warning: No turbo-frame found on page ${pageNum}`);
    return words;
  }
  const content = frameMatch[1];

  // Split content by line-container boundaries
  const lineChunks = content.split(/(?=<div class="line-container")/);

  for (const chunk of lineChunks) {
    // Extract line number
    const lineNumMatch = chunk.match(/data-line="(\d+)"/);
    if (!lineNumMatch) continue;
    const lineNum = parseInt(lineNumMatch[1]);

    // Extract line type from class
    const lineClassMatch = chunk.match(/<div class="line\s+([\s\S]*?)\s*"\s+id="line-/);
    const lineClasses = lineClassMatch ? lineClassMatch[1] : "";
    let lineType = "text";
    if (lineClasses.includes("line--surah-name")) lineType = "surah_name";
    else if (lineClasses.includes("line--bismillah")) lineType = "bismillah";
    else if (lineClasses.includes("line--center")) lineType = "center";

    // For surah_name lines, extract surah icon
    if (lineType === "surah_name") {
      const surahIconMatch = chunk.match(/surah-name-v4-icon[^>]*>\s*surah(\d+)\s*</);
      const surahNum = surahIconMatch ? parseInt(surahIconMatch[1]) : 0;
      words.push({
        pageNumber: pageNum,
        lineNumber: lineNum,
        lineType: "surah_name",
        positionInLine: 1,
        charTypeName: "surah_name",
        surahNumber: surahNum,
        ayahNumber: 0,
        wordPosition: 0,
        textUthmani: `surah${String(surahNum).padStart(3, "0")}`,
        glyphCode: `surah${String(surahNum).padStart(3, "0")}`,
      });
      continue;
    }

    // Parse word spans — collect in DOM order, then assign sequential positions
    const spanRegex = /class="char\s+([\s\S]*?)"[\s\S]*?data-location="(\d+):(\d+):(\d+)"[\s\S]*?data-position="(\d+)"[\s\S]*?data-id="(\d+)"[\s\S]*?<a[^>]*>\s*([\s\S]*?)\s*<\/a>/g;

    let match;
    let seqPosition = 0;
    while ((match = spanRegex.exec(chunk)) !== null) {
      const charClasses = match[1].trim();
      let charType = "word";
      if (charClasses.includes("char-end")) charType = "end";

      const surahNum = parseInt(match[2]);
      const ayahNum = parseInt(match[3]);
      const wordPos = parseInt(match[4]);
      const glyphChar = match[7].trim();

      seqPosition++;
      words.push({
        pageNumber: pageNum,
        lineNumber: lineNum,
        lineType,
        positionInLine: seqPosition,
        charTypeName: charType,
        surahNumber: surahNum,
        ayahNumber: ayahNum,
        wordPosition: wordPos,
        textUthmani: "",
        glyphCode: glyphChar,
      });
    }
  }

  return words;
}

async function main() {
  const [startPage, endPage] = parsePageRange();
  const concurrency = getConcurrency();

  console.log("QUL Mushaf Layout Scraper");
  console.log("========================");
  console.log(`Pages: ${startPage}-${endPage}`);
  console.log(`Concurrency: ${concurrency}`);
  console.log(`Output: ${OUTPUT_PATH}`);
  console.log();

  mkdirSync(OUTPUT_DIR, { recursive: true });

  const allWords: ScrapedWord[] = [];
  let scraped = 0;
  let errors = 0;

  for (let batch = startPage; batch <= endPage; batch += concurrency) {
    const batchEnd = Math.min(batch + concurrency - 1, endPage);
    const promises = [];

    for (let p = batch; p <= batchEnd; p++) {
      promises.push(
        fetchPage(p)
          .then((html) => {
            const words = parsePage(html, p);
            if (words.length === 0) {
              console.warn(`  Warning: No words found on page ${p}`);
              errors++;
            }
            return words;
          })
          .catch((err) => {
            console.error(`  Error on page ${p}: ${err.message}`);
            errors++;
            return [] as ScrapedWord[];
          })
      );
    }

    const results = await Promise.all(promises);
    for (const words of results) {
      allWords.push(...words);
    }

    scraped += batchEnd - batch + 1;
    if (scraped % 50 === 0 || batchEnd === endPage) {
      console.log(
        `  Progress: ${scraped}/${endPage - startPage + 1} pages, ${allWords.length} words`
      );
    }

    // Rate limit
    if (batchEnd < endPage) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // Sort
  allWords.sort(
    (a, b) =>
      a.pageNumber - b.pageNumber ||
      a.lineNumber - b.lineNumber ||
      a.positionInLine - b.positionInLine
  );

  console.log(`\nTotal words scraped: ${allWords.length}`);
  console.log(`Errors: ${errors}`);

  // Stats
  const lineTypes = new Map<string, number>();
  const charTypes = new Map<string, number>();
  for (const w of allWords) {
    lineTypes.set(w.lineType, (lineTypes.get(w.lineType) || 0) + 1);
    charTypes.set(w.charTypeName, (charTypes.get(w.charTypeName) || 0) + 1);
  }
  console.log("Line types:", Object.fromEntries(lineTypes));
  console.log("Char types:", Object.fromEntries(charTypes));

  // Page coverage
  const pages = new Set(allWords.map((w) => w.pageNumber));
  console.log(`Pages with data: ${pages.size}`);

  writeFileSync(OUTPUT_PATH, JSON.stringify(allWords));
  console.log(`\nSaved to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
