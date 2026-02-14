/**
 * HadithDB Importer — Import structured hadith data from hadithunlocked.com
 *
 * Downloads TSV bulk exports with complete Arabic text (with tashkeel),
 * isnad/matn separation, English translations, and grading.
 *
 * Usage:
 *   bun run pipelines/import/import-hadithdb.ts --collection=hakim       # Single collection
 *   bun run pipelines/import/import-hadithdb.ts --all                    # All 7 target collections
 *   bun run pipelines/import/import-hadithdb.ts --collection=hakim --download-only  # Just cache TSV
 *   bun run pipelines/import/import-hadithdb.ts --collection=hakim --import-only    # Import from cache
 *   bun run pipelines/import/import-hadithdb.ts --collection=hakim --dry-run        # Preview
 */

import "../env";
import { prisma } from "../../src/db";
import { normalizeArabicText } from "../../src/embeddings";
import { hashHadith, hashHadithTranslation } from "../../src/utils/content-hash";
import * as fs from "fs";
import * as path from "path";

// ============================================================================
// Configuration
// ============================================================================

const CACHE_DIR = path.join(import.meta.dir, "hadithdb-cache");
const BASE_URL = "https://hadithunlocked.com";

// HadithDB alias → our slug mapping
const ALIAS_TO_SLUG: Record<string, string> = {
  "hakim": "mustadrak",
  "ibnhibban": "ibn-hibban",
  "tabarani": "mujam-kabir",
  "bayhaqi": "sunan-kubra-bayhaqi",
  "nasai-kubra": "sunan-kubra-nasai",
  "suyuti": "suyuti",
  "ahmad-zuhd": "ahmad-zuhd",
};

interface CollectionDef {
  alias: string;
  slug: string;
  nameEnglish: string;
  nameArabic: string;
}

const TARGET_COLLECTIONS: CollectionDef[] = [
  { alias: "hakim", slug: "mustadrak", nameEnglish: "Al-Mustadrak", nameArabic: "المستدرك على الصحيحين" },
  { alias: "ibnhibban", slug: "ibn-hibban", nameEnglish: "Sahih Ibn Hibban", nameArabic: "صحيح ابن حبان" },
  { alias: "tabarani", slug: "mujam-kabir", nameEnglish: "Al-Mu'jam al-Kabir", nameArabic: "المعجم الكبير" },
  { alias: "bayhaqi", slug: "sunan-kubra-bayhaqi", nameEnglish: "Al-Sunan al-Kubra (Bayhaqi)", nameArabic: "السنن الكبرى للبيهقي" },
  { alias: "nasai-kubra", slug: "sunan-kubra-nasai", nameEnglish: "Al-Sunan al-Kubra (Nasa'i)", nameArabic: "السنن الكبرى للنسائي" },
  { alias: "suyuti", slug: "suyuti", nameEnglish: "Jam' al-Jawami'", nameArabic: "جمع الجوامع" },
  { alias: "ahmad-zuhd", slug: "ahmad-zuhd", nameEnglish: "Al-Zuhd (Ahmad)", nameArabic: "الزهد لأحمد" },
];

// Dorar-imported collection slugs that will be replaced
const DORAR_REPLACEMENT_SLUGS = new Set(["mustadrak", "ibn-hibban", "sunan-kubra-bayhaqi"]);

// ============================================================================
// TSV Parsing
// ============================================================================

interface TsvRow {
  [key: string]: string;
}

function parseTsv(content: string): TsvRow[] {
  const lines = content.split("\n");
  if (lines.length < 2) return [];

  const headers = lines[0].split("\t");
  const rows: TsvRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const values = line.split("\t");
    const row: TsvRow = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ?? "";
    }
    rows.push(row);
  }

  return rows;
}

// ============================================================================
// Download
// ============================================================================

async function downloadTsv(alias: string, force: boolean): Promise<string> {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cachePath = path.join(CACHE_DIR, `${alias}.tsv`);

  if (!force && fs.existsSync(cachePath)) {
    const stats = fs.statSync(cachePath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
    console.log(`  Using cached TSV: ${cachePath} (${sizeMB} MB)`);
    return cachePath;
  }

  const url = `${BASE_URL}/${alias}?tsv&download`;
  console.log(`  Downloading: ${url}`);

  const response = await fetch(url, {
    headers: {
      "User-Agent": "OpenIslamicDB/1.0 (academic research; contact: github.com/openidb)",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to download ${alias}: HTTP ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  fs.writeFileSync(cachePath, text);
  const sizeMB = (text.length / 1024 / 1024).toFixed(1);
  console.log(`  Saved: ${cachePath} (${sizeMB} MB)`);

  return cachePath;
}

// ============================================================================
// Import Logic
// ============================================================================

interface ImportStats {
  books: number;
  hadiths: number;
  translations: number;
  skipped: number;
}

async function importCollection(
  colDef: CollectionDef,
  rows: TsvRow[],
  dryRun: boolean,
): Promise<ImportStats> {
  const stats: ImportStats = { books: 0, hadiths: 0, translations: 0, skipped: 0 };
  const { alias, slug, nameEnglish, nameArabic } = colDef;

  // Use TSV metadata for collection name if available
  const firstRow = rows[0];
  const tsvNameEn = firstRow?.book_shortName_en || nameEnglish;
  const tsvNameAr = firstRow?.book_shortName || nameArabic;

  if (dryRun) {
    console.log(`  [DRY RUN] Would import ${rows.length} rows for ${slug}`);
  }

  // 1. Delete existing Dorar data for replaced collections
  if (DORAR_REPLACEMENT_SLUGS.has(slug)) {
    const existing = await prisma.hadithCollection.findUnique({ where: { slug } });
    if (existing) {
      // Count existing for logging
      const existingCount = await prisma.hadith.count({
        where: { book: { collectionId: existing.id } },
      });
      if (existingCount > 0) {
        if (dryRun) {
          console.log(`  [DRY RUN] Would delete ${existingCount} existing Dorar hadiths for ${slug}`);
        } else {
          console.log(`  Deleting ${existingCount} existing hadiths for ${slug} (replacing Dorar data)...`);
          // Get book IDs for this collection
          const bookIds = await prisma.hadithBook.findMany({
            where: { collectionId: existing.id },
            select: { id: true },
          });
          const bookIdList = bookIds.map((b) => b.id);
          // Delete translations first (no FK relation, just bookId)
          await prisma.hadithTranslation.deleteMany({
            where: { bookId: { in: bookIdList } },
          });
          // Delete hadiths
          await prisma.hadith.deleteMany({
            where: { bookId: { in: bookIdList } },
          });
          // Delete books
          await prisma.hadithBook.deleteMany({
            where: { collectionId: existing.id },
          });
          console.log(`  Deleted existing data for ${slug}`);
        }
      }
    }
  }

  if (dryRun) {
    // Just count stats
    const bookNumbers = new Set<number>();
    for (const row of rows) {
      const body = row.body?.trim();
      if (!body || body === "null") { stats.skipped++; continue; }
      const h1 = parseInt(row.h1);
      if (!isNaN(h1)) bookNumbers.add(h1);
      stats.hadiths++;
      const bodyEn = row.body_en?.trim();
      if (bodyEn && bodyEn !== "null" && bodyEn !== "[Machine]" && !bodyEn.startsWith("[Machine]")) {
        stats.translations++;
      }
    }
    stats.books = bookNumbers.size;
    return stats;
  }

  // 2. Upsert collection
  const collection = await prisma.hadithCollection.upsert({
    where: { slug },
    create: { slug, nameEnglish: tsvNameEn, nameArabic: tsvNameAr },
    update: { nameEnglish: tsvNameEn, nameArabic: tsvNameAr },
  });

  // 3. Group rows by h1 (book number) and create books
  const bookGroups = new Map<number, TsvRow[]>();
  for (const row of rows) {
    const h1 = parseInt(row.h1);
    if (isNaN(h1)) continue;
    if (!bookGroups.has(h1)) bookGroups.set(h1, []);
    bookGroups.get(h1)!.push(row);
  }

  // Create all books first
  const bookIdMap = new Map<number, number>(); // bookNumber → DB bookId
  const sortedBookNums = [...bookGroups.keys()].sort((a, b) => a - b);

  for (const bookNum of sortedBookNums) {
    const groupRows = bookGroups.get(bookNum)!;
    const sampleRow = groupRows[0];
    const bookNameEn = sampleRow.h1_title_en?.trim() || null;
    const bookNameAr = sampleRow.h1_title?.trim() || null;

    const nameEn = (bookNameEn && bookNameEn !== "null") ? bookNameEn : "";
    const nameAr = (bookNameAr && bookNameAr !== "null") ? bookNameAr : "";

    const book = await prisma.hadithBook.upsert({
      where: {
        collectionId_bookNumber: {
          collectionId: collection.id,
          bookNumber: bookNum,
        },
      },
      create: {
        collection: { connect: { id: collection.id } },
        bookNumber: bookNum,
        nameEnglish: nameEn,
        nameArabic: nameAr,
      },
      update: {
        nameEnglish: nameEn,
        nameArabic: nameAr,
      },
    });

    bookIdMap.set(bookNum, book.id);
    stats.books++;
  }

  console.log(`  Created/updated ${stats.books} books`);

  // 4. Import hadiths in batches
  const BATCH_SIZE = 500;
  const hadithRows: Array<{ row: TsvRow; bookNum: number }> = [];

  for (const [bookNum, groupRows] of bookGroups) {
    for (const row of groupRows) {
      const body = row.body?.trim();
      if (!body || body === "null") { stats.skipped++; continue; }
      hadithRows.push({ row, bookNum });
    }
  }

  console.log(`  Importing ${hadithRows.length} hadiths (${stats.skipped} skipped)...`);

  for (let i = 0; i < hadithRows.length; i += BATCH_SIZE) {
    const batch = hadithRows.slice(i, i + BATCH_SIZE);

    await prisma.$transaction(
      batch.map(({ row, bookNum }) => {
        const bookId = bookIdMap.get(bookNum)!;
        const chain = row.chain?.trim();
        const body = row.body?.trim();
        const hadithNumber = row.hId || row.num || String(i);

        // Combine chain + body for full text
        const isnad = (chain && chain !== "null") ? chain : null;
        const matn = body!;
        const textArabic = isnad ? `${isnad}\n${matn}` : matn;
        const textPlain = normalizeArabicText(textArabic);
        const contentHash = hashHadith(slug, hadithNumber, textArabic);

        // Prefer per-hadith title, fall back to h2 (section), then h3
        const rawChapterAr = row.title?.trim();
        const rawChapterEn = row.title_en?.trim();
        const chapterAr = (rawChapterAr && rawChapterAr !== "null") ? rawChapterAr
          : (row.h2_title?.trim() && row.h2_title.trim() !== "null") ? row.h2_title.trim()
          : null;
        const chapterEn = (rawChapterEn && rawChapterEn !== "null") ? rawChapterEn
          : (row.h2_title_en?.trim() && row.h2_title_en.trim() !== "null" && !row.h2_title_en.trim().startsWith("[Machine]")) ? row.h2_title_en.trim()
          : null;
        const gradeAr = row.grade_grade?.trim();
        const gradeEn = row.grade_grade_en?.trim();
        const graderName = row.grader_shortName?.trim();

        return prisma.hadith.upsert({
          where: { bookId_hadithNumber: { bookId, hadithNumber } },
          create: {
            bookId,
            hadithNumber,
            textArabic,
            textPlain,
            contentHash,
            source: "hadithunlocked.com",
            isnad,
            matn,
            chapterArabic: chapterAr,
            chapterEnglish: chapterEn,
            grade: (gradeAr && gradeAr !== "null") ? gradeAr : null,
            gradeText: (gradeEn && gradeEn !== "null" && gradeEn !== "No Grade") ? gradeEn : null,
            graderName: (graderName && graderName !== "null" && graderName !== "N/A") ? graderName : null,
          },
          update: {
            textArabic,
            textPlain,
            contentHash,
            source: "hadithunlocked.com",
            isnad,
            matn,
            chapterArabic: chapterAr,
            chapterEnglish: chapterEn,
            grade: (gradeAr && gradeAr !== "null") ? gradeAr : null,
            gradeText: (gradeEn && gradeEn !== "null" && gradeEn !== "No Grade") ? gradeEn : null,
            graderName: (graderName && graderName !== "null" && graderName !== "N/A") ? graderName : null,
          },
        });
      }),
    );

    stats.hadiths += batch.length;
    if ((i + BATCH_SIZE) % 2000 === 0 || i + BATCH_SIZE >= hadithRows.length) {
      console.log(`    Hadiths: ${Math.min(i + BATCH_SIZE, hadithRows.length)}/${hadithRows.length}`);
    }
  }

  // 5. Import English translations
  const translationRows = hadithRows.filter(({ row }) => {
    const bodyEn = row.body_en?.trim();
    return bodyEn && bodyEn !== "null" && bodyEn !== "[Machine]" && !bodyEn.startsWith("[Machine]");
  });

  if (translationRows.length > 0) {
    console.log(`  Importing ${translationRows.length} English translations...`);

    for (let i = 0; i < translationRows.length; i += BATCH_SIZE) {
      const batch = translationRows.slice(i, i + BATCH_SIZE);

      await prisma.$transaction(
        batch.map(({ row, bookNum }) => {
          const bookId = bookIdMap.get(bookNum)!;
          const hadithNumber = row.hId || row.num || "";

          // Combine English chain + body + footnote
          const parts: string[] = [];
          const chainEn = row.chain_en?.trim();
          const bodyEn = row.body_en?.trim();
          const footnoteEn = row.footnote_en?.trim();

          if (chainEn && chainEn !== "null" && !chainEn.startsWith("[Machine]")) {
            parts.push(chainEn);
          }
          if (bodyEn && bodyEn !== "null") {
            parts.push(bodyEn);
          }
          if (footnoteEn && footnoteEn !== "null") {
            parts.push(`\n---\n${footnoteEn}`);
          }

          const text = parts.join("\n");
          const contentHash = hashHadithTranslation(slug, hadithNumber, "en", text);

          return prisma.hadithTranslation.upsert({
            where: {
              bookId_hadithNumber_language: { bookId, hadithNumber, language: "en" },
            },
            create: { bookId, hadithNumber, language: "en", text, contentHash },
            update: { text, contentHash },
          });
        }),
      );

      stats.translations += batch.length;
      if ((i + BATCH_SIZE) % 2000 === 0 || i + BATCH_SIZE >= translationRows.length) {
        console.log(`    Translations: ${Math.min(i + BATCH_SIZE, translationRows.length)}/${translationRows.length}`);
      }
    }
  }

  return stats;
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const flags = {
    collection: args.find((a) => a.startsWith("--collection="))?.split("=")[1],
    all: args.includes("--all"),
    downloadOnly: args.includes("--download-only"),
    importOnly: args.includes("--import-only"),
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
  };

  if (!flags.collection && !flags.all) {
    console.log("Usage:");
    console.log("  --collection=ALIAS   Import a single collection (alias: hakim, ibnhibban, tabarani, etc.)");
    console.log("  --all                Import all 7 target collections");
    console.log("  --download-only      Only download TSV files, don't import");
    console.log("  --import-only        Only import from cached TSV files");
    console.log("  --dry-run            Preview without importing");
    console.log("  --force              Re-download even if cached");
    console.log("\nAvailable collections:");
    for (const col of TARGET_COLLECTIONS) {
      console.log(`  ${col.alias.padEnd(15)} → ${col.slug.padEnd(25)} ${col.nameEnglish}`);
    }
    process.exit(0);
  }

  // Determine which collections to process
  let targets: CollectionDef[];
  if (flags.all) {
    targets = TARGET_COLLECTIONS;
  } else {
    const col = TARGET_COLLECTIONS.find((c) => c.alias === flags.collection);
    if (!col) {
      // Also allow using our slug directly
      const colBySlug = TARGET_COLLECTIONS.find((c) => c.slug === flags.collection);
      if (!colBySlug) {
        console.error(`Unknown collection: ${flags.collection}`);
        console.error(`Valid aliases: ${TARGET_COLLECTIONS.map((c) => c.alias).join(", ")}`);
        process.exit(1);
      }
      targets = [colBySlug];
    } else {
      targets = [col];
    }
  }

  console.log(`\n=== HadithDB Import ===`);
  console.log(`Collections: ${targets.map((c) => c.alias).join(", ")}`);
  console.log(`Mode: ${flags.dryRun ? "DRY RUN" : flags.downloadOnly ? "DOWNLOAD ONLY" : flags.importOnly ? "IMPORT ONLY" : "FULL"}\n`);

  const allStats: Record<string, ImportStats> = {};

  for (const colDef of targets) {
    console.log(`\n--- ${colDef.nameEnglish} (${colDef.alias} → ${colDef.slug}) ---`);

    // Download
    let tsvPath: string;
    if (!flags.importOnly) {
      try {
        tsvPath = await downloadTsv(colDef.alias, flags.force ?? false);
      } catch (err) {
        console.error(`  Failed to download ${colDef.alias}:`, err);
        continue;
      }
    } else {
      tsvPath = path.join(CACHE_DIR, `${colDef.alias}.tsv`);
      if (!fs.existsSync(tsvPath)) {
        console.error(`  No cached TSV for ${colDef.alias}. Run with --download-only first.`);
        continue;
      }
    }

    if (flags.downloadOnly) {
      // Just count rows for summary
      const content = fs.readFileSync(tsvPath, "utf-8");
      const lineCount = content.split("\n").length - 2; // minus header and trailing newline
      console.log(`  ${lineCount} rows in TSV`);
      continue;
    }

    // Parse and import
    console.log(`  Parsing TSV...`);
    const content = fs.readFileSync(tsvPath, "utf-8");
    const rows = parseTsv(content);
    console.log(`  Parsed ${rows.length} rows`);

    const stats = await importCollection(colDef, rows, flags.dryRun ?? false);
    allStats[colDef.slug] = stats;

    console.log(`  Done: ${stats.books} books, ${stats.hadiths} hadiths, ${stats.translations} translations, ${stats.skipped} skipped`);
  }

  // Summary
  console.log(`\n=== Summary ===`);
  let totalHadiths = 0;
  let totalTranslations = 0;
  for (const [slug, stats] of Object.entries(allStats)) {
    console.log(`  ${slug.padEnd(25)} ${String(stats.hadiths).padStart(8)} hadiths  ${String(stats.translations).padStart(8)} translations  ${String(stats.books).padStart(5)} books`);
    totalHadiths += stats.hadiths;
    totalTranslations += stats.translations;
  }
  console.log(`  ${"TOTAL".padEnd(25)} ${String(totalHadiths).padStart(8)} hadiths  ${String(totalTranslations).padStart(8)} translations`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
