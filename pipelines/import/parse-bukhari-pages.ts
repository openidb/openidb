/**
 * Deterministic parser for Sahih al-Bukhari from Sultaniyya edition pages.
 *
 * Reads chunk-NNN.json files exported by export-bukhari-pages.ts and
 * produces chunk-NNN.extracted.json files with parsed hadiths.
 *
 * Patterns detected:
 *   - Hadith number: [٠-٩]+ - (Arabic-Indic digits + dash)
 *   - Kitab heading: كِتَابُ / كتاب at start of section
 *   - Bab heading: بَابُ / بَابٌ at start of section
 *   - Footnotes: after _________ separator
 *   - Isnad/Matn splitting deferred to LLM (split-isnad-matn-llm.ts)
 *
 * Usage: bun run pipelines/import/parse-bukhari-pages.ts [--chunk=NNN] [--dry-run]
 */

import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";

const CACHE_DIR = join(__dirname, "bukhari-pages-cache");

// --- Arabic-Indic numeral conversion ---
function toWestern(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d).toString());
}

/**
 * Strip printed page markers like ⦗٣٢⦘ from text.
 * These are page boundary indicators from the source book.
 */
function stripPageMarkers(s: string): string {
  return s.replace(/\s*⦗[٠-٩]+⦘\s*/g, " ").replace(/\s{2,}/g, " ").trim();
}

/**
 * Strip Arabic diacritics (tashkeel) for comparison purposes.
 */
function stripDiacritics(s: string): string {
  return s.replace(/[\u064B-\u065F\u0670]/g, "");
}

/**
 * Clean kitab heading text:
 * - Strip بسملة (بسم الله الرحمن الرحيم or ﷽) that appears on same line
 * - Strip trailing periods
 * Uses diacritic-stripped matching to avoid shadda/fatha ordering issues.
 */
function cleanKitabName(s: string): string {
  // Match بسملة regardless of diacritic ordering
  const plain = stripDiacritics(s);
  const bismIdx = plain.indexOf("بسم الله الرحمن الرحيم");
  if (bismIdx >= 0) {
    // Map the diacritic-stripped index back to original string position
    let origPos = 0;
    let strippedCount = 0;
    while (strippedCount < bismIdx && origPos < s.length) {
      if (!/[\u064B-\u065F\u0670]/.test(s[origPos])) strippedCount++;
      origPos++;
    }
    s = s.substring(0, origPos).trim();
  }

  return s
    .replace(/\s*﷽\s*/g, "")
    .replace(/\.\s*$/, "")
    .trim();
}

// --- Page data types ---
interface PageData {
  pageNumber: number;
  volumeNumber: number;
  printedPageNumber: number;
  contentPlain: string;
}

interface ChunkData {
  chunkId: number;
  pagesFrom: number;
  pagesTo: number;
  pages: PageData[];
}

interface ParsedHadith {
  hadithNumber: string;
  isnad: string;
  matn: string;
  kitab: string;
  bab: string;
  footnotes: string | null;
  pageStart: number;
  pageEnd: number;
  isChainVariation: boolean;
}

interface ExtractedChunk {
  chunkId: number;
  lastKitab: string;
  lastBab: string;
  hadiths: ParsedHadith[];
}

// --- Core parser ---

/**
 * Split text into footnote body and main content.
 * Footnotes appear after a line of underscores.
 */
function splitFootnotes(text: string): { main: string; footnotes: string | null } {
  const sepIdx = text.indexOf("_________");
  if (sepIdx === -1) return { main: text, footnotes: null };
  const main = text.substring(0, sepIdx).trim();
  const footnotes = text.substring(sepIdx).replace(/^_+\s*/, "").trim();
  return { main, footnotes: footnotes || null };
}

/**
 * Detect if a line/section is a kitab heading.
 * Kitab headings contain كِتَابُ or كتاب and are typically short standalone lines.
 */
function extractKitab(text: string): string | null {
  // Match lines that start with or are primarily a kitab heading
  // Common patterns: "كِتَابُ الْإِيمَانِ" or "كِتَابُ بَدْءِ الْوَحْيِ"
  const match = text.match(/^(كِتَابُ\s+[^\n]+)/m);
  if (match) return match[1].trim();

  // Also check without tashkeel
  const match2 = text.match(/^(كتاب\s+[^\n]+)/m);
  if (match2) return match2[1].trim();

  return null;
}

/**
 * Detect if a line/section is a bab heading.
 * Bab headings start with بَابُ or بَابٌ.
 */
function extractBab(text: string): string | null {
  // Bab with tashkeel
  const match = text.match(/^(بَابُ[^\n]*)/m);
  if (match) return match[1].trim();

  const match2 = text.match(/^(بَابٌ[^\n]*)/m);
  if (match2) return match2[1].trim();

  // Without tashkeel
  const match3 = text.match(/^(باب\s+[^\n]+)/m);
  if (match3) return match3[1].trim();

  return null;
}

/**
 * Parse the text preceding a hadith number for any kitab/bab headings.
 * Returns updated kitab/bab values.
 */
function parseHeadings(
  text: string,
  currentKitab: string,
  currentBab: string
): { kitab: string; bab: string } {
  let kitab = currentKitab;
  let bab = currentBab;

  // Split into lines and process each
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check for kitab heading
    if (/^كِتَابُ\s/.test(trimmed) || /^كتاب\s/.test(trimmed)) {
      kitab = cleanKitabName(trimmed);
      bab = ""; // Reset bab when new kitab starts
    }
    // Check for bab heading
    else if (/^بَابُ\s/.test(trimmed) || /^بَابٌ/.test(trimmed) || /^باب\s/.test(trimmed)) {
      // Bab heading might span multiple lines — take everything until the next structural element
      bab = trimmed;
    }
  }

  return { kitab, bab };
}

/** Detect chain variations: short texts referencing a previous hadith */
function detectChainVariation(fullText: string): boolean {
  const stripped = stripDiacritics(fullText);

  if (stripped.length < 200) {
    if (
      /بمثله|بنحوه|مثله|نحوه|بمثل ذلك|بنحو حديثهم|بنحو حديث|بهذا الاسناد/.test(
        stripped
      )
    ) {
      return true;
    }
    // Very short text — likely a brief cross-reference
    if (stripped.length < 60) return true;
  }
  return false;
}

// --- Main parsing logic ---

function parseAllPages(pages: PageData[]): {
  hadiths: ParsedHadith[];
  lastKitab: string;
  lastBab: string;
} {
  // Build a single text stream with page markers
  interface TextSegment {
    text: string;
    pageNumber: number;
    volumeNumber: number;
    printedPageNumber: number;
  }

  const segments: TextSegment[] = pages.map((p) => ({
    text: p.contentPlain,
    pageNumber: p.pageNumber,
    volumeNumber: p.volumeNumber,
    printedPageNumber: p.printedPageNumber,
  }));

  // Regex to find hadith numbers in Arabic-Indic format
  // Pattern: start of line or after whitespace, Arabic-Indic digits, space-dash-space
  const hadithPattern = /(?:^|\n)\s*([٠-٩]+)\s*-\s*/g;

  let currentKitab = "";
  let currentBab = "";
  const hadiths: ParsedHadith[] = [];

  // First pass: detect special initial heading for "بدء الوحي"
  // The first page typically has introductory text with the initial kitab heading
  for (const seg of segments) {
    const text = seg.text;
    // Check for the very first kitab (بدء الوحي)
    if (/كَيْفَ كَانَ بَدْءُ الْوَحْيِ/.test(text) || /بَدْءُ الْوَحْيِ/.test(text)) {
      if (!currentKitab) {
        // The first section of Bukhari doesn't use "كتاب" prefix — it's just
        // "كَيْفَ كَانَ بَدْءُ الْوَحْيِ" or Imam Bukhari's intro
        currentKitab = "بَدْءُ الْوَحْيِ";
        currentBab = "كَيْفَ كَانَ بَدْءُ الْوَحْيِ إِلَى رَسُولِ اللهِ ﷺ";
      }
      break;
    }
    if (/كِتَابُ/.test(text)) break; // Found a regular kitab first
  }

  // Second pass: process each page, find hadith boundaries
  // Collect all hadith positions across all pages
  interface HadithPosition {
    number: string;
    textBefore: string; // Text between previous hadith end and this hadith start
    textBody: string; // Text from after "N - " to next hadith or page end
    pageStart: number;
    pageEnd: number;
    volumeNumber: number;
    printedPageNumber: number;
  }

  // Concatenate all text with page boundary markers
  const PAGE_MARKER = "\n\u0000PAGE_BREAK\u0000\n";
  let fullText = "";
  const pageBreakPositions: { pos: number; page: PageData }[] = [];

  for (const seg of segments) {
    if (fullText.length > 0) {
      pageBreakPositions.push({
        pos: fullText.length,
        page: {
          pageNumber: seg.pageNumber,
          volumeNumber: seg.volumeNumber,
          printedPageNumber: seg.printedPageNumber,
          contentPlain: seg.text,
        },
      });
      fullText += "\n";
    } else {
      pageBreakPositions.push({
        pos: 0,
        page: {
          pageNumber: seg.pageNumber,
          volumeNumber: seg.volumeNumber,
          printedPageNumber: seg.printedPageNumber,
          contentPlain: seg.text,
        },
      });
    }
    fullText += seg.text;
  }

  // Find all hadith start positions
  const hadithStarts: { index: number; number: string; matchEnd: number }[] = [];
  const pattern = /(?:^|\n)\s*([٠-٩]+)\s*-\s*/g;
  let match;
  while ((match = pattern.exec(fullText)) !== null) {
    const num = toWestern(match[1]);
    hadithStarts.push({
      index: match.index,
      number: num,
      matchEnd: match.index + match[0].length,
    });
  }

  // Helper: find page number for a position in fullText
  function getPageAtPos(pos: number): PageData {
    let result = pageBreakPositions[0].page;
    for (const bp of pageBreakPositions) {
      if (bp.pos <= pos) result = bp.page;
      else break;
    }
    return result;
  }

  // Process each hadith
  for (let i = 0; i < hadithStarts.length; i++) {
    const hs = hadithStarts[i];
    const nextStart = i + 1 < hadithStarts.length ? hadithStarts[i + 1].index : fullText.length;

    // Text before this hadith (between previous hadith/start and this one)
    const prevEnd = i > 0 ? hadithStarts[i - 1].matchEnd : 0;
    const textBefore = fullText.substring(
      i > 0 ? prevEnd : 0,
      hs.index
    );

    // Hadith body text (from after "N - " to next hadith start)
    let hadithBody = fullText.substring(hs.matchEnd, nextStart).trim();

    // Parse any headings in the text before this hadith
    const headings = parseHeadings(textBefore, currentKitab, currentBab);
    currentKitab = headings.kitab;
    currentBab = headings.bab;

    // Also check if there are headings embedded in the hadith body
    // (e.g., a bab heading appears after a hadith ends but before the next number)
    // This is handled by checking between hadiths

    // Determine page range
    const startPage = getPageAtPos(hs.matchEnd);
    const endPage = getPageAtPos(Math.min(nextStart - 1, fullText.length - 1));

    // Split footnotes
    const { main, footnotes } = splitFootnotes(hadithBody);

    // Store full text in matn (isnad/matn splitting done later by LLM)
    const cleanedMain = stripPageMarkers(main.trim());

    hadiths.push({
      hadithNumber: hs.number,
      isnad: "",
      matn: cleanedMain,
      kitab: currentKitab,
      bab: currentBab,
      footnotes,
      pageStart: startPage.pageNumber,
      pageEnd: endPage.pageNumber,
      isChainVariation: detectChainVariation(cleanedMain),
    });
  }

  // Check for headings after the last hadith
  if (hadithStarts.length > 0) {
    const lastEnd = hadithStarts[hadithStarts.length - 1].matchEnd;
    const remaining = fullText.substring(lastEnd);
    // Don't update headings from remaining — that belongs to the hadith body
  }

  return { hadiths, lastKitab: currentKitab, lastBab: currentBab };
}

// --- CLI ---

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const chunkArg = args.find((a) => a.startsWith("--chunk="));
  const specificChunk = chunkArg ? parseInt(chunkArg.split("=")[1]) : null;

  // Find all chunk files
  const files = readdirSync(CACHE_DIR)
    .filter((f) => f.match(/^chunk-\d+\.json$/))
    .sort();

  if (specificChunk !== null) {
    const targetFile = `chunk-${String(specificChunk).padStart(3, "0")}.json`;
    if (!files.includes(targetFile)) {
      console.error(`Chunk file not found: ${targetFile}`);
      process.exit(1);
    }
    processChunk(targetFile, dryRun);
  } else {
    // Process all chunks, maintaining kitab/bab state across chunks
    let prevKitab = "";
    let prevBab = "";
    let totalHadiths = 0;
    let emptyKitab = 0;
    let emptyBab = 0;
    let emptyMatn = 0;
    let chainVars = 0;
    let withFootnotes = 0;

    for (const file of files) {
      const result = processChunk(file, dryRun, prevKitab, prevBab);
      if (result) {
        prevKitab = result.lastKitab;
        prevBab = result.lastBab;
        totalHadiths += result.count;
        emptyKitab += result.emptyKitab;
        emptyBab += result.emptyBab;
        emptyMatn += result.emptyMatn;
        chainVars += result.chainVars;
        withFootnotes += result.withFootnotes;
      }
    }

    console.log("\n=== TOTALS ===");
    console.log(`Total hadiths: ${totalHadiths}`);
    console.log(`Empty kitab: ${emptyKitab} (${((emptyKitab / totalHadiths) * 100).toFixed(1)}%)`);
    console.log(`Empty bab: ${emptyBab} (${((emptyBab / totalHadiths) * 100).toFixed(1)}%)`);
    console.log(`Empty matn: ${emptyMatn} (${((emptyMatn / totalHadiths) * 100).toFixed(1)}%)`);
    console.log(`Chain variations: ${chainVars} (${((chainVars / totalHadiths) * 100).toFixed(1)}%)`);
    console.log(`With footnotes: ${withFootnotes} (${((withFootnotes / totalHadiths) * 100).toFixed(1)}%)`);
  }
}

function processChunk(
  filename: string,
  dryRun: boolean,
  inheritKitab?: string,
  inheritBab?: string
): {
  lastKitab: string;
  lastBab: string;
  count: number;
  emptyKitab: number;
  emptyBab: number;
  emptyMatn: number;
  chainVars: number;
  withFootnotes: number;
} | null {
  const filepath = join(CACHE_DIR, filename);
  const chunk: ChunkData = JSON.parse(readFileSync(filepath, "utf8"));

  // Parse pages
  const result = parseAllPages(chunk.pages);

  // If we have inherited kitab/bab from previous chunk, apply to hadiths that lack them
  if (inheritKitab || inheritBab) {
    let kitab = inheritKitab || "";
    let bab = inheritBab || "";
    for (const h of result.hadiths) {
      if (!h.kitab && kitab) h.kitab = kitab;
      if (!h.bab && bab) h.bab = bab;
      // Once we see a hadith with its own kitab/bab, stop inheriting
      if (h.kitab) kitab = h.kitab;
      if (h.bab) bab = h.bab;
    }
    if (!result.lastKitab && kitab) result.lastKitab = kitab;
    if (!result.lastBab && bab) result.lastBab = bab;
  }

  // Deduplicate by hadith number (keep first occurrence within chunk,
  // but cross-chunk dedup is handled by the import script)
  const seen = new Set<string>();
  const deduped: ParsedHadith[] = [];
  for (const h of result.hadiths) {
    if (!seen.has(h.hadithNumber)) {
      seen.add(h.hadithNumber);
      deduped.push(h);
    }
  }

  // Stats
  const emptyKitab = deduped.filter((h) => !h.kitab).length;
  const emptyBab = deduped.filter((h) => !h.bab).length;
  const emptyMatn = deduped.filter((h) => !h.matn).length;
  const chainVars = deduped.filter((h) => h.isChainVariation).length;
  const withFootnotes = deduped.filter((h) => h.footnotes).length;

  const chunkLabel = filename.replace(".json", "");
  console.log(
    `${chunkLabel}: ${deduped.length} hadiths` +
      ` (kitab: ${emptyKitab === 0 ? "✓" : emptyKitab + " empty"}` +
      `, bab: ${emptyBab === 0 ? "✓" : emptyBab + " empty"}` +
      `, matn: ${emptyMatn === 0 ? "✓" : emptyMatn + " empty"}` +
      `, chain-var: ${chainVars}` +
      `, footnotes: ${withFootnotes})`
  );

  if (!dryRun) {
    const output: ExtractedChunk = {
      chunkId: chunk.chunkId,
      lastKitab: result.lastKitab,
      lastBab: result.lastBab,
      hadiths: deduped,
    };
    const outPath = join(CACHE_DIR, filename.replace(".json", ".extracted.json"));
    writeFileSync(outPath, JSON.stringify(output, null, 2), "utf8");
  }

  return {
    lastKitab: result.lastKitab,
    lastBab: result.lastBab,
    count: deduped.length,
    emptyKitab,
    emptyBab,
    emptyMatn,
    chainVars,
    withFootnotes,
  };
}

main();
