/**
 * Phase 3 Parser — nawawi40, qudsi40, hisn
 *
 * These collections use non-standard numbering:
 *   - nawawi40/qudsi40: Arabic ordinal headings ("الحديث الأول", "الحديث الثاني", ...)
 *   - hisn: Numbered du'a items with chapter headings
 *
 * Outputs chunk-NNN.extracted.json in the same ExtractedChunk format
 * as parse-turath-collection.ts, so import-turath-collection.ts works unchanged.
 *
 * Usage:
 *   bun run pipelines/import/parse-phase3-collections.ts --collection=nawawi40
 *   bun run pipelines/import/parse-phase3-collections.ts --collection=qudsi40 --dry-run
 *   bun run pipelines/import/parse-phase3-collections.ts --collection=hisn
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { getConfig, type CollectionConfig } from "./turath-hadith-configs";

// =============================================================================
// Shared Utilities (same as generic parser)
// =============================================================================

function toWestern(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d).toString());
}

function stripPageMarkers(s: string): string {
  return s
    .replace(/\s*⦗[٠-٩]+⦘\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function stripDiacritics(s: string): string {
  return s.replace(/[\u064B-\u065F\u0670]/g, "");
}

/** Strip footnote markers like (^١) (^٢) from text */
function stripFootnoteMarkers(s: string): string {
  return s.replace(/\(\^[٠-٩0-9]+\)/g, "").replace(/\s{2,}/g, " ");
}

function splitFootnotes(text: string): { main: string; footnotes: string | null } {
  const sepIdx = text.indexOf("_________");
  if (sepIdx === -1) return { main: text, footnotes: null };
  const main = text.substring(0, sepIdx).trim();
  const footnotes = text
    .substring(sepIdx)
    .replace(/^_+\s*/, "")
    .trim();
  return { main, footnotes: footnotes || null };
}

// =============================================================================
// Types
// =============================================================================

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
  sequentialNumber: number;
  parenthesizedNumber: number;
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

// =============================================================================
// Nawawi40 / Qudsi40 — Ordinal Parser
// =============================================================================

/**
 * Parse collections that use ordinal Arabic headings:
 *   الحديث الأول, الحديث الثاني, ..., الحديث الثاني والأربعون
 *
 * Strips diacritics before matching to handle vocalized headings like
 * الحديثُ الثَّالِثُ or الحدِيْثُ الرابِعُ.
 *
 * Skips headings on overlap pages (skipPagesBelow) to avoid duplicates.
 */
function parseOrdinal(
  pages: PageData[],
  config: CollectionConfig,
  startNumber: number,
  skipPagesBelow: number
): { hadiths: ParsedHadith[]; lastNumber: number; lastPage: number } {
  const hadiths: ParsedHadith[] = [];

  // Build concatenated text with page position tracking
  // NOTE: Strip footnote markers per-page BEFORE concatenation so that
  // pageBreaks and fullText positions stay in sync.
  const pageBreaks: { pos: number; page: PageData }[] = [];
  let fullText = "";
  for (const seg of pages) {
    const stripped = stripFootnoteMarkers(seg.contentPlain);
    if (fullText.length > 0) {
      pageBreaks.push({ pos: fullText.length, page: seg });
      fullText += "\n";
    } else {
      pageBreaks.push({ pos: 0, page: seg });
    }
    fullText += stripped;
  }

  // Build position mapping: strippedPos → originalPos
  // Stripping diacritics changes string length, so we need to map positions back
  const strippedChars: string[] = [];
  const strippedToOriginal: number[] = [];
  for (let i = 0; i < fullText.length; i++) {
    if (!/[\u064B-\u065F\u0670]/.test(fullText[i])) {
      strippedToOriginal.push(i);
      strippedChars.push(fullText[i]);
    }
  }
  const strippedText = strippedChars.join("");

  // Find all ordinal hadith headings in stripped text
  // Pattern: الحديث ال followed by Arabic letters/spaces (ordinal word)
  const headingPattern = /الحديث\s+ال[\u0600-\u06FF\s]+/g;
  const headingMatches: { index: number; matchEnd: number; text: string }[] = [];
  let match;
  while ((match = headingPattern.exec(strippedText)) !== null) {
    // Map back to original positions
    const origIndex = strippedToOriginal[match.index];

    // Only accept headings that appear on their own line or near start of line
    const lineStart = fullText.lastIndexOf("\n", origIndex);
    const before = fullText
      .substring(Math.max(0, lineStart), origIndex)
      .trim();
    // Allow empty or short prefix (page number marker, etc.)
    if (before.length > 30) continue;

    // Trim the match to end at the next newline in original text
    let end = fullText.indexOf("\n", origIndex);
    if (end === -1) end = fullText.length;
    const headingText = fullText.substring(origIndex, end).trim();

    headingMatches.push({
      index: origIndex,
      matchEnd: end,
      text: headingText,
    });
  }

  if (headingMatches.length === 0)
    return { hadiths: [], lastNumber: startNumber - 1, lastPage: 0 };

  // Helper: find page at position
  function getPageAtPos(pos: number): PageData {
    let result = pageBreaks[0].page;
    for (const bp of pageBreaks) {
      if (bp.pos <= pos) result = bp.page;
      else break;
    }
    return result;
  }

  // Filter out headings on overlap pages
  const filteredHeadings = headingMatches.filter((h) => {
    const page = getPageAtPos(h.index);
    return page.pageNumber > skipPagesBelow;
  });

  if (filteredHeadings.length === 0)
    return { hadiths: [], lastNumber: startNumber - 1, lastPage: 0 };

  // Extract hadith text between consecutive headings
  let lastPage = 0;
  for (let i = 0; i < filteredHeadings.length; i++) {
    const h = filteredHeadings[i];
    const bodyStart = h.matchEnd;
    // End at next heading (from full list, not filtered) or end of text
    let bodyEnd = fullText.length;
    for (const hm of headingMatches) {
      if (hm.index > h.index) {
        bodyEnd = hm.index;
        break;
      }
    }

    const bodyText = fullText.substring(bodyStart, bodyEnd).trim();
    const num = startNumber + i;

    // Split footnotes
    const { main, footnotes } = splitFootnotes(bodyText);

    // For qudsi40: strip takhrij commentary (separated by ــ line)
    let hadithText = main;
    const takhrijSep = hadithText.match(/\n\s*ــ\s*\n/);
    let takhrijText: string | null = null;
    if (takhrijSep && takhrijSep.index !== undefined) {
      takhrijText = hadithText.substring(takhrijSep.index).trim();
      hadithText = hadithText.substring(0, takhrijSep.index).trim();
    }

    // Split isnad/matn
    let isnad = "";
    let matn = "";

    if (config.isnadDelimiter === "guillemets") {
      // nawawi40: entire hadith inside guillemets «...»
      const guilStart = hadithText.indexOf("\u00AB");
      const guilEnd = hadithText.lastIndexOf("\u00BB");
      if (guilStart !== -1 && guilEnd > guilStart) {
        const insideGuillemets = hadithText
          .substring(guilStart + 1, guilEnd)
          .trim();

        // Strip diacritics for matching, build position mapping
        const strippedGuil = stripDiacritics(insideGuillemets);
        const guilMap: number[] = [];
        for (let ci = 0; ci < insideGuillemets.length; ci++) {
          if (!/[\u064B-\u065F\u0670]/.test(insideGuillemets[ci])) {
            guilMap.push(ci);
          }
        }

        // Find the LATEST قال: or يقول: within the first 70% of text
        const transitions = [/قال:\s/, /يقول:\s/, /قالت:\s/];
        const limit = strippedGuil.length * 0.7;
        let latestOrigEnd = -1;
        let latestOrigStart = -1;

        for (const t of transitions) {
          const re = new RegExp(t.source, "g");
          let m;
          while ((m = re.exec(strippedGuil)) !== null) {
            const endIdx = m.index + m[0].length;
            if (endIdx <= limit && endIdx > latestOrigEnd) {
              latestOrigStart = guilMap[m.index];
              latestOrigEnd = endIdx < guilMap.length
                ? guilMap[endIdx]
                : insideGuillemets.length;
            }
          }
        }

        if (latestOrigEnd > 0) {
          isnad = insideGuillemets.substring(0, latestOrigStart).trim();
          matn = insideGuillemets.substring(latestOrigEnd).trim();
        } else {
          isnad = "";
          matn = insideGuillemets;
        }
      } else {
        isnad = hadithText;
        matn = "";
      }
    } else {
      // qudsi40: double quotes for matn
      const qs = hadithText.indexOf('"');
      const qe = hadithText.lastIndexOf('"');
      if (qs !== -1 && qe > qs) {
        isnad = hadithText.substring(0, qs).trim();
        matn = hadithText.substring(qs + 1, qe).trim();
      } else {
        const cqs = hadithText.indexOf("\u201C");
        const cqe = hadithText.lastIndexOf("\u201D");
        if (cqs !== -1 && cqe > cqs) {
          isnad = hadithText.substring(0, cqs).trim();
          matn = hadithText.substring(cqs + 1, cqe).trim();
        } else {
          isnad = hadithText;
          matn = "";
        }
      }
    }

    // Combine footnotes with takhrij
    let allFootnotes = footnotes;
    if (takhrijText) {
      allFootnotes = allFootnotes
        ? `${allFootnotes}\n${takhrijText}`
        : takhrijText;
    }

    // Page range
    const startPage = getPageAtPos(bodyStart);
    const endPage = getPageAtPos(Math.min(bodyEnd - 1, fullText.length - 1));
    lastPage = endPage.pageNumber;

    hadiths.push({
      hadithNumber: String(num),
      sequentialNumber: num,
      parenthesizedNumber: num,
      isnad: stripPageMarkers(isnad),
      matn: stripPageMarkers(matn),
      kitab: config.nameArabic,
      bab: "",
      footnotes: allFootnotes,
      pageStart: startPage.pageNumber,
      pageEnd: endPage.pageNumber,
      isChainVariation: false,
    });
  }

  return {
    hadiths,
    lastNumber: startNumber + filteredHeadings.length - 1,
    lastPage,
  };
}

/**
 * Remove inline footnotes from text (for Hisn al-Muslim).
 *
 * Footnote blocks (_________) can appear MID-PAGE. splitFootnotes() truncates
 * at the first separator, losing continuation text. This function:
 * 1. Splits text at _________ separators
 * 2. In each section after separator, classifies lines as footnote (starts with (N)) or continuation
 * 3. Strips footnote lines, rejoins continuation text
 */
function removeInlineFootnotes(text: string): { main: string; footnotes: string | null } {
  const sections = text.split(/_________+/);
  if (sections.length <= 1) return { main: text, footnotes: null };

  const mainParts: string[] = [sections[0]];
  const footnoteParts: string[] = [];

  for (let i = 1; i < sections.length; i++) {
    const lines = sections[i].split("\n");
    const continuationLines: string[] = [];
    const footnoteLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^\([٠-٩0-9]+\)/.test(trimmed)) {
        footnoteLines.push(trimmed);
      } else {
        continuationLines.push(line);
      }
    }

    if (continuationLines.length > 0) {
      mainParts.push(continuationLines.join("\n"));
    }
    if (footnoteLines.length > 0) {
      footnoteParts.push(footnoteLines.join("\n"));
    }
  }

  const main = mainParts.join("\n").trim();
  const footnotes = footnoteParts.length > 0 ? footnoteParts.join("\n") : null;
  return { main, footnotes };
}

// =============================================================================
// Hisn al-Muslim — Du'a Parser
// =============================================================================

/**
 * Parse Hisn al-Muslim which uses:
 *   Chapter headings: N - CHAPTER_TITLE (no guillemets/brackets in heading)
 *   Du'a items with sub-number: N - (M) «du'a text» or N - (M) ﴿Quran verse﴾
 *   Du'a items without sub-number: N - «du'a text» (single-item chapters)
 *   Du'a items with plain text: N - text... «quoted part»
 *
 * Classification: if text after N - contains «, ﴿, or ( in the first 200 chars → item.
 * Otherwise → chapter heading.
 */
function parseHisn(
  pages: PageData[],
  _config: CollectionConfig
): { hadiths: ParsedHadith[]; lastBab: string } {
  const hadiths: ParsedHadith[] = [];

  // Build concatenated text with page position tracking
  // NOTE: Strip footnote markers per-page BEFORE concatenation so that
  // pageBreaks and fullText positions stay in sync.
  const pageBreaks: { pos: number; page: PageData }[] = [];
  let fullText = "";
  for (const seg of pages) {
    const stripped = stripFootnoteMarkers(seg.contentPlain);
    if (fullText.length > 0) {
      pageBreaks.push({ pos: fullText.length, page: seg });
      fullText += "\n";
    } else {
      pageBreaks.push({ pos: 0, page: seg });
    }
    fullText += stripped;
  }

  // Find all N - patterns
  const allMatches: {
    index: number;
    matchEnd: number;
    number: number;
    isChapter: boolean;
    chapterTitle: string;
  }[] = [];

  const pattern = /(?:^|\n)\s*([٠-٩]+)\s*-\s*/g;
  let match;
  while ((match = pattern.exec(fullText)) !== null) {
    const num = parseInt(toWestern(match[1]), 10);
    const matchEnd = match.index + match[0].length;

    // Get text between this N - and the next N - (up to 500 chars for analysis)
    const afterMatch = fullText.substring(matchEnd, matchEnd + 500);

    // Classify: items have (, «, ﴿ on the first line; chapters are short title lines
    const firstLine = afterMatch.split("\n")[0] || "";
    const isItem =
      /^\(/.test(firstLine.trim()) ||     // sub-number (M) at start
      /[«﴿"]/.test(firstLine);             // guillemets, Quran brackets, or quotes on first line

    let chapterTitle = "";
    if (!isItem) {
      // Extract chapter title (up to next newline)
      const nlIdx = afterMatch.indexOf("\n");
      chapterTitle = (nlIdx >= 0 ? afterMatch.substring(0, nlIdx) : afterMatch).trim();
      if (chapterTitle.length > 100) chapterTitle = chapterTitle.substring(0, 100);
    }

    allMatches.push({
      index: match.index,
      matchEnd,
      number: num,
      isChapter: !isItem,
      chapterTitle,
    });
  }

  // Helper: find page at position
  function getPageAtPos(pos: number): PageData {
    let result = pageBreaks[0].page;
    for (const bp of pageBreaks) {
      if (bp.pos <= pos) result = bp.page;
      else break;
    }
    return result;
  }

  // Process items, tracking current chapter
  let currentBab = "";
  for (let i = 0; i < allMatches.length; i++) {
    const m = allMatches[i];

    if (m.isChapter) {
      currentBab = m.chapterTitle;
      continue;
    }

    // Du'a item — extract body text
    const bodyStart = m.matchEnd;
    let bodyEnd = fullText.length;
    for (let j = i + 1; j < allMatches.length; j++) {
      bodyEnd = allMatches[j].index;
      break;
    }

    const bodyText = fullText.substring(bodyStart, bodyEnd).trim();

    // Remove inline footnotes (handles mid-page footnote blocks)
    const { main, footnotes } = removeInlineFootnotes(bodyText);

    // Strip the sub-number (M) from the start if present
    let hadithText = main.replace(/^\([٠-٩]+\)\s*/, "").trim();

    // Extract du'a text from guillemets or Quranic brackets
    let matn = "";
    let isnad = "";

    // Try guillemets
    const guilStart = hadithText.indexOf("\u00AB");
    const guilEnd = hadithText.lastIndexOf("\u00BB");
    if (guilStart !== -1 && guilEnd > guilStart) {
      matn = hadithText.substring(guilStart + 1, guilEnd).trim();
      const before = hadithText.substring(0, guilStart).trim();
      if (before) isnad = before;
    } else {
      // Try Quranic brackets ﴿...﴾
      const qStart = hadithText.indexOf("\uFD3F");
      const qEnd = hadithText.lastIndexOf("\uFD3E");
      if (qStart !== -1 && qEnd > qStart) {
        matn = hadithText.substring(qStart, qEnd + 1).trim();
        const before = hadithText.substring(0, qStart).trim();
        if (before) isnad = before;
      } else {
        // No delimiters — use full text as matn
        matn = hadithText;
      }
    }

    // Page range
    const startPage = getPageAtPos(bodyStart);
    const endPage = getPageAtPos(Math.min(bodyEnd - 1, fullText.length - 1));

    hadiths.push({
      hadithNumber: String(m.number),
      sequentialNumber: m.number,
      parenthesizedNumber: m.number,
      isnad: stripPageMarkers(isnad),
      matn: stripPageMarkers(matn),
      kitab: "حصن المسلم",
      bab: currentBab,
      footnotes,
      pageStart: startPage.pageNumber,
      pageEnd: endPage.pageNumber,
      isChainVariation: false,
    });
  }

  return { hadiths, lastBab: currentBab };
}

// =============================================================================
// Chunk Processing
// =============================================================================

function processChunk(
  filename: string,
  config: CollectionConfig,
  dryRun: boolean,
  prevState: { lastNumber: number; lastBab: string; lastPage: number }
): {
  lastNumber: number;
  lastBab: string;
  lastPage: number;
  count: number;
  emptyMatn: number;
  withFootnotes: number;
} | null {
  const filepath = join(config.cacheDir, filename);
  const chunk: ChunkData = JSON.parse(readFileSync(filepath, "utf8"));

  let hadiths: ParsedHadith[];
  let lastNumber = prevState.lastNumber;
  let lastBab = prevState.lastBab;
  let lastPage = prevState.lastPage;

  if (config.slug === "hisn") {
    const result = parseHisn(chunk.pages, config);
    hadiths = result.hadiths;
    lastBab = result.lastBab;
    if (hadiths.length > 0) {
      lastNumber = hadiths[hadiths.length - 1].sequentialNumber;
      lastPage = hadiths[hadiths.length - 1].pageEnd;
    }
  } else {
    // nawawi40, qudsi40 — ordinal parser with overlap skip
    const skipPagesBelow = prevState.lastPage;
    const result = parseOrdinal(
      chunk.pages,
      config,
      prevState.lastNumber + 1,
      skipPagesBelow
    );
    hadiths = result.hadiths;
    lastNumber = result.lastNumber;
    lastPage = result.lastPage;
  }

  // Deduplicate within chunk (by hadith number)
  const seen = new Set<string>();
  const deduped: ParsedHadith[] = [];
  for (const h of hadiths) {
    const key = `${h.hadithNumber}-${h.pageStart}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(h);
    }
  }

  // Apply inherited bab for hisn
  if (config.slug === "hisn" && prevState.lastBab) {
    for (const h of deduped) {
      if (!h.bab && prevState.lastBab) {
        h.bab = prevState.lastBab;
      }
      if (h.bab) lastBab = h.bab;
    }
  }

  // Stats
  const emptyMatn = deduped.filter((h) => !h.matn).length;
  const withFootnotes = deduped.filter((h) => h.footnotes).length;

  const chunkLabel = filename.replace(".json", "");
  console.log(
    `  ${chunkLabel}: ${deduped.length} hadiths` +
      ` (matn: ${emptyMatn === 0 ? "ok" : emptyMatn + " empty"}` +
      `, footnotes: ${withFootnotes})`
  );

  if (!dryRun) {
    const output: ExtractedChunk = {
      chunkId: chunk.chunkId,
      lastKitab: config.nameArabic,
      lastBab: lastBab,
      hadiths: deduped,
    };
    const outPath = join(
      config.cacheDir,
      filename.replace(".json", ".extracted.json")
    );
    writeFileSync(outPath, JSON.stringify(output, null, 2), "utf8");
  }

  return {
    lastNumber,
    lastBab,
    lastPage,
    count: deduped.length,
    emptyMatn,
    withFootnotes,
  };
}

// =============================================================================
// CLI
// =============================================================================

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const collectionArg = args.find((a) => a.startsWith("--collection="));

  if (!collectionArg) {
    console.error(
      "Usage: bun run parse-phase3-collections.ts --collection=SLUG [--dry-run]"
    );
    console.error("Available: nawawi40, qudsi40, hisn");
    process.exit(1);
  }

  const slug = collectionArg.slice(13);
  if (!["nawawi40", "qudsi40", "hisn"].includes(slug)) {
    console.error(`Unknown Phase 3 collection: ${slug}`);
    console.error("Available: nawawi40, qudsi40, hisn");
    process.exit(1);
  }

  const config = getConfig(slug);

  console.log(`=== Parsing ${config.name} (Phase 3) ===`);
  console.log(`  Parser: ${slug === "hisn" ? "hisn (du'a items)" : "ordinal"}`);
  console.log(`  Mode: ${dryRun ? "DRY RUN" : "WRITE"}`);

  if (!existsSync(config.cacheDir)) {
    console.error(`Cache directory not found: ${config.cacheDir}`);
    console.error("Run export-turath-pages.ts first.");
    process.exit(1);
  }

  // Find chunk files
  const files = readdirSync(config.cacheDir)
    .filter((f) => f.match(/^chunk-\d+\.json$/))
    .sort();

  if (files.length === 0) {
    console.error(`No chunk files found in ${config.cacheDir}`);
    process.exit(1);
  }

  console.log(`  Found ${files.length} chunk files.\n`);

  let state = { lastNumber: 0, lastBab: "", lastPage: 0 };
  let totalHadiths = 0;
  let totalEmptyMatn = 0;
  let totalFootnotes = 0;

  for (const file of files) {
    const result = processChunk(file, config, dryRun, state);
    if (result) {
      state = {
        lastNumber: result.lastNumber,
        lastBab: result.lastBab,
        lastPage: result.lastPage,
      };
      totalHadiths += result.count;
      totalEmptyMatn += result.emptyMatn;
      totalFootnotes += result.withFootnotes;
    }
  }

  console.log("\n=== TOTALS ===");
  console.log(`Total hadiths: ${totalHadiths}`);
  if (totalHadiths > 0) {
    console.log(
      `Empty matn: ${totalEmptyMatn} (${((totalEmptyMatn / totalHadiths) * 100).toFixed(1)}%)`
    );
    console.log(
      `With footnotes: ${totalFootnotes} (${((totalFootnotes / totalHadiths) * 100).toFixed(1)}%)`
    );
  }
}

main();
