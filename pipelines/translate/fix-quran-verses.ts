/**
 * Post-processing script: Scan existing translations for Quran verses
 * that were translated by the LLM instead of being marked with {{Q:...}}.
 *
 * For each page, sends the Arabic + English to an LLM to identify unmarked
 * Quran verses, then replaces them with official translations from the DB.
 *
 * Usage:
 *   bun run pipelines/translate/fix-quran-verses.ts --book=98093 --lang=en [--dry-run] [--start-page=N] [--concurrency=N]
 */

import "../env";
import { prisma } from "../../src/db";
import { callOpenRouter } from "../../src/lib/openrouter";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const QURAN_EDITIONS: Record<string, string> = {
  en: "eng-mustafakhattaba",
};

const MODEL = "google/gemini-2.0-flash-001";
const CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (name: string) => {
    const arg = args.find((a) => a.startsWith(`--${name}=`));
    return arg ? arg.split("=")[1] : undefined;
  };
  const bookIds = get("book")?.split(",") || [];
  const lang = get("lang") || "en";
  const dryRun = args.includes("--dry-run");
  const startPage = parseInt(get("start-page") || "0", 10);
  const concurrency = parseInt(get("concurrency") || String(CONCURRENCY), 10);

  if (bookIds.length === 0) {
    console.error("Usage: --book=ID1,ID2 --lang=en [--dry-run] [--start-page=N] [--concurrency=N]");
    process.exit(1);
  }
  return { bookIds, lang, dryRun, startPage, concurrency };
}

// ---------------------------------------------------------------------------
// Fetch official Quran translations
// ---------------------------------------------------------------------------

async function fetchAyahTranslation(
  surah: number,
  ayahStart: number,
  ayahEnd: number,
  lang: string,
): Promise<string | null> {
  const editionId = QURAN_EDITIONS[lang];
  const conditions = [];
  for (let a = ayahStart; a <= ayahEnd; a++) {
    conditions.push({ surahNumber: surah, ayahNumber: a });
  }

  const rows = await prisma.ayahTranslation.findMany({
    where: {
      OR: conditions,
      ...(editionId ? { editionId } : { language: lang }),
    },
    select: { ayahNumber: true, text: true },
    orderBy: { ayahNumber: "asc" },
  });

  if (rows.length === 0) return null;
  return rows.map((r) => r.text).join(" ");
}

// ---------------------------------------------------------------------------
// LLM: Identify Quran verses in translation
// ---------------------------------------------------------------------------

interface QuranFix {
  paragraphIndex: number;
  originalText: string;
  replacementText: string;
  surah: number;
  ayahStart: number;
  ayahEnd: number;
}

async function identifyQuranVerses(
  arabicParagraphs: { index: number; text: string }[],
  translations: { index: number; translation: string }[],
): Promise<QuranFix[]> {
  // Build numbered display
  const pairs = translations.map((t) => {
    const arabic = arabicParagraphs.find((a) => a.index === t.index);
    return `[${t.index}] ARABIC: ${arabic?.text || "(no source)"}\n[${t.index}] ENGLISH: ${t.translation}`;
  }).join("\n\n");

  const prompt = `You are a Quran verse identifier. Below are Arabic paragraphs and their English translations from an Islamic book.

Your task: Find any Quran verse text in the ENGLISH translations that was translated by an AI instead of being left as a marker. Quran verses in the Arabic are typically inside ﴿...﴾ brackets or introduced by phrases like "قال تعالى", "قوله تعالى", "لقوله", "كقوله".

For each Quran verse you find translated in the English:
1. Identify the exact English text that corresponds to the Quran verse
2. Identify the surah number and ayah number(s)
3. Return a JSON array of fixes

IMPORTANT RULES:
- Only flag text that is ACTUALLY a Quran verse — do not flag hadith, poetry, or author's own words
- The "originalText" must be an EXACT substring of the English translation (copy it precisely, character for character)
- Include enough text to uniquely identify the verse in context but do NOT include surrounding non-Quran text
- If you're not sure whether something is a Quran verse, skip it
- Return an empty array [] if no unflagged Quran verses are found

${pairs}

Return ONLY a valid JSON array:
[{"paragraphIndex": N, "originalText": "exact English text of the verse", "surah": S, "ayahStart": A, "ayahEnd": B}]

If no fixes needed, return: []`;

  const result = await callOpenRouter({
    model: MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
    timeoutMs: 30000,
    maxTokens: 4096,
  });

  if (!result?.content) return [];

  try {
    const cleaned = result.content.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (f: any) =>
        typeof f.paragraphIndex === "number" &&
        typeof f.originalText === "string" &&
        typeof f.surah === "number" &&
        typeof f.ayahStart === "number" &&
        f.originalText.length > 5
    ).map((f: any) => ({
      paragraphIndex: f.paragraphIndex,
      originalText: f.originalText,
      replacementText: "", // filled in later
      surah: f.surah,
      ayahStart: f.ayahStart,
      ayahEnd: f.ayahEnd || f.ayahStart,
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Process a single page
// ---------------------------------------------------------------------------

async function processPage(
  page: {
    id: string;
    pageNumber: number;
    contentHtml: string;
    bookId: string;
  },
  translation: {
    paragraphs: { index: number; translation: string }[];
    contentHash: string | null;
  },
  lang: string,
  dryRun: boolean,
): Promise<number> {
  // Extract Arabic paragraphs from HTML
  const lines = page.contentHtml.split(/\n/);
  const arabicParagraphs: { index: number; text: string }[] = [];
  let idx = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Strip HTML tags for the LLM
    const plain = trimmed.replace(/<[^>]+>/g, "").trim();
    if (plain) {
      arabicParagraphs.push({ index: idx, text: plain });
    }
    idx++;
  }

  // Quick check: does this page even have Quran brackets in Arabic?
  const hasQuranBrackets = page.contentHtml.includes("﴿") || page.contentHtml.includes("تعالى");
  if (!hasQuranBrackets) return 0;

  // Check if any translations already have markers (skip those paragraphs)
  const paragraphsToCheck = translation.paragraphs.filter(
    (p) => !p.translation.includes("{{Q:")
  );
  if (paragraphsToCheck.length === 0) return 0;

  // Ask LLM to identify unmarked Quran verses
  const fixes = await identifyQuranVerses(arabicParagraphs, paragraphsToCheck);
  if (fixes.length === 0) return 0;

  // Fetch official translations and build replacements
  let fixCount = 0;
  const updatedParagraphs = [...translation.paragraphs];

  for (const fix of fixes) {
    const official = await fetchAyahTranslation(fix.surah, fix.ayahStart, fix.ayahEnd, lang);
    if (!official) {
      console.log(`    [skip] ${fix.surah}:${fix.ayahStart}-${fix.ayahEnd} — no official translation found`);
      continue;
    }

    const pIdx = updatedParagraphs.findIndex((p) => p.index === fix.paragraphIndex);
    if (pIdx === -1) continue;

    const current = updatedParagraphs[pIdx].translation;
    // Verify the originalText is actually in the translation
    if (!current.includes(fix.originalText)) {
      console.log(`    [skip] paragraph ${fix.paragraphIndex} — originalText not found in translation`);
      continue;
    }

    const replacement = `"${official}"`;
    const updated = current.replace(fix.originalText, replacement);

    if (dryRun) {
      console.log(`    [fix] p${fix.paragraphIndex} Q${fix.surah}:${fix.ayahStart}${fix.ayahEnd !== fix.ayahStart ? `-${fix.ayahEnd}` : ""}`);
      console.log(`      OLD: ...${fix.originalText.slice(0, 80)}...`);
      console.log(`      NEW: ...${replacement.slice(0, 80)}...`);
    }

    updatedParagraphs[pIdx] = { ...updatedParagraphs[pIdx], translation: updated };
    fixCount++;
  }

  if (fixCount > 0 && !dryRun) {
    await prisma.pageTranslation.update({
      where: { pageId_language: { pageId: page.id, language: lang } },
      data: { paragraphs: updatedParagraphs as any },
    });
  }

  return fixCount;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { bookIds, lang, dryRun, startPage, concurrency } = parseArgs();

  if (dryRun) console.log("[DRY RUN] No changes will be written.\n");

  for (const bookId of bookIds) {
    console.log(`\nProcessing book ${bookId} (lang=${lang})...`);

    // Fetch all pages with translations
    const pages = await prisma.page.findMany({
      where: { bookId, pageNumber: { gte: startPage } },
      select: { id: true, pageNumber: true, contentHtml: true, bookId: true },
      orderBy: { pageNumber: "asc" },
    });

    const translations = await prisma.pageTranslation.findMany({
      where: {
        pageId: { in: pages.map((p) => p.id) },
        language: lang,
      },
      select: { pageId: true, paragraphs: true, contentHash: true },
    });

    const translationMap = new Map(translations.map((t) => [t.pageId, t]));

    const pagesWithTranslations = pages.filter((p) => translationMap.has(p.id));
    console.log(`  ${pagesWithTranslations.length} pages with translations`);

    let totalFixes = 0;
    let pagesFixed = 0;

    // Process in batches with concurrency
    for (let i = 0; i < pagesWithTranslations.length; i += concurrency) {
      const batch = pagesWithTranslations.slice(i, i + concurrency);
      const results = await Promise.all(
        batch.map(async (page) => {
          const translation = translationMap.get(page.id)!;
          try {
            const fixes = await processPage(
              page,
              {
                paragraphs: translation.paragraphs as { index: number; translation: string }[],
                contentHash: translation.contentHash,
              },
              lang,
              dryRun,
            );
            if (fixes > 0) {
              console.log(`  page ${page.pageNumber}: ${fixes} fix(es)`);
            }
            return fixes;
          } catch (err: any) {
            console.error(`  page ${page.pageNumber}: ERROR — ${err.message}`);
            return 0;
          }
        }),
      );

      for (const r of results) {
        totalFixes += r;
        if (r > 0) pagesFixed++;
      }

      // Progress
      const done = Math.min(i + concurrency, pagesWithTranslations.length);
      if (done % 50 === 0 || done === pagesWithTranslations.length) {
        console.log(`  ... ${done}/${pagesWithTranslations.length} pages scanned, ${totalFixes} fixes so far`);
      }
    }

    console.log(`\n  Book ${bookId}: ${totalFixes} fixes across ${pagesFixed} pages${dryRun ? " (dry run)" : ""}`);
  }

  console.log("\nDone.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
