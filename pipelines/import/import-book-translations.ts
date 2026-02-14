/**
 * Import Book Title Translations
 *
 * Reads *.translated.json batch files produced by Claude subagents and
 * upserts translations into the BookTitleTranslation table.
 * Also updates Book.titleLatin (transliteration) if currently null.
 *
 * Usage:
 *   bun run pipelines/import/import-book-translations.ts [--dry-run] [--force-transliteration] [--batch=NNN]
 */

import "../env";
import { prisma } from "../../src/db";
import { readdirSync, readFileSync } from "fs";
import { resolve } from "path";

const BATCH_DIR = resolve(import.meta.dir, "book-title-batches");
const LANGUAGES = ["en", "fr", "id", "ur", "es", "zh", "pt", "ru", "ja", "ko", "it", "bn"] as const;
const ARABIC_RE = /[\u0600-\u06FF]/;
const TX_BATCH_SIZE = 100;

interface TranslatedBook {
  id: string;
  titleLatin: string;
  translations: Record<string, string>;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let dryRun = false;
  let forceTransliteration = false;
  let batchFilter: string | null = null;

  for (const arg of args) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--force-transliteration") forceTransliteration = true;
    else if (arg.startsWith("--batch=")) batchFilter = arg.slice(8).padStart(3, "0");
  }

  return { dryRun, forceTransliteration, batchFilter };
}

function validateTranslatedBook(book: TranslatedBook): string[] {
  const errors: string[] = [];

  if (!book.id) errors.push("missing id");
  if (!book.titleLatin || book.titleLatin.trim().length === 0) {
    errors.push("missing titleLatin");
  } else if (ARABIC_RE.test(book.titleLatin)) {
    errors.push(`titleLatin contains Arabic: "${book.titleLatin.slice(0, 50)}"`);
  }

  if (!book.translations || typeof book.translations !== "object") {
    errors.push("missing translations object");
  } else {
    for (const lang of LANGUAGES) {
      if (!book.translations[lang] || book.translations[lang].trim().length === 0) {
        errors.push(`missing ${lang} translation`);
      }
    }
  }

  return errors;
}

async function main() {
  const { dryRun, forceTransliteration, batchFilter } = parseArgs();

  let files: string[];
  try {
    files = readdirSync(BATCH_DIR)
      .filter((f) => f.endsWith(".translated.json"))
      .sort();
  } catch {
    console.error(`No batch directory found at ${BATCH_DIR}`);
    process.exit(1);
  }

  if (batchFilter) {
    files = files.filter((f) => f.includes(`batch-${batchFilter}`));
  }

  if (files.length === 0) {
    console.error(`No .translated.json files found in ${BATCH_DIR}`);
    process.exit(1);
  }

  console.log(`Found ${files.length} translated batch files.`);

  // Collect all valid translations
  const allBooks: TranslatedBook[] = [];
  let validationErrors = 0;
  const errorSamples: string[] = [];

  for (const file of files) {
    let data: TranslatedBook[];
    try {
      data = JSON.parse(readFileSync(resolve(BATCH_DIR, file), "utf-8"));
    } catch (err) {
      console.error(`  Failed to parse ${file}: ${err}`);
      continue;
    }

    if (!Array.isArray(data)) {
      console.error(`  ${file}: expected array, got ${typeof data}`);
      continue;
    }

    for (const book of data) {
      // Coerce ID to string (some subagents output numbers)
      book.id = String(book.id);
      const errors = validateTranslatedBook(book);
      if (errors.length > 0) {
        validationErrors++;
        if (errorSamples.length < 10) {
          errorSamples.push(`  ${book.id}: ${errors.join(", ")}`);
        }
        continue;
      }
      allBooks.push(book);
    }
  }

  console.log(`Valid books: ${allBooks.length}, validation errors: ${validationErrors}`);
  if (errorSamples.length > 0) {
    console.log("Sample errors:");
    errorSamples.forEach((s) => console.log(s));
  }

  if (allBooks.length === 0) {
    console.log("No valid translations to import.");
    return;
  }

  // Deduplicate by book ID (last one wins)
  const bookMap = new Map<string, TranslatedBook>();
  for (const book of allBooks) {
    bookMap.set(book.id, book);
  }
  const dedupBooks = [...bookMap.values()];
  const dupes = allBooks.length - dedupBooks.length;
  if (dupes > 0) {
    console.log(`Deduplicated: ${dupes} duplicate book IDs removed, ${dedupBooks.length} unique books.`);
  }

  if (dryRun) {
    console.log("\n--- DRY RUN ---");
    console.log(`Would upsert ${dedupBooks.length * LANGUAGES.length} translations (${dedupBooks.length} books × ${LANGUAGES.length} languages)`);
    console.log(`Would update up to ${dedupBooks.length} Book.titleLatin values`);

    // Show sample
    console.log("\nSample translations (first 5 books):");
    for (const book of dedupBooks.slice(0, 5)) {
      console.log(`\n  Book ${book.id}:`);
      console.log(`    titleLatin: ${book.titleLatin}`);
      for (const lang of LANGUAGES) {
        const t = book.translations[lang];
        console.log(`    ${lang}: ${t ? t.slice(0, 80) : "(missing)"}`);
      }
    }

    // Stats
    const langCounts = new Map<string, number>();
    for (const book of dedupBooks) {
      for (const lang of LANGUAGES) {
        if (book.translations[lang]) {
          langCounts.set(lang, (langCounts.get(lang) || 0) + 1);
        }
      }
    }
    console.log("\nLanguage coverage:");
    for (const lang of LANGUAGES) {
      console.log(`  ${lang}: ${langCounts.get(lang) || 0}/${dedupBooks.length}`);
    }
    return;
  }

  // Verify book IDs exist (batch lookups to avoid query size limits)
  const bookIds = dedupBooks.map((b) => b.id);
  const existingBookMap = new Map<string, string | null>();
  const ID_BATCH = 500;
  for (let i = 0; i < bookIds.length; i += ID_BATCH) {
    const chunk = bookIds.slice(i, i + ID_BATCH);
    const existingBooks = await prisma.book.findMany({
      where: { id: { in: chunk } },
      select: { id: true, titleLatin: true },
    });
    for (const b of existingBooks) {
      existingBookMap.set(b.id, b.titleLatin);
    }
  }

  const missingIds = bookIds.filter((id) => !existingBookMap.has(id));
  if (missingIds.length > 0) {
    console.log(`Warning: ${missingIds.length} book IDs not found in database, skipping them.`);
  }

  const validBooks = dedupBooks.filter((b) => existingBookMap.has(b.id));
  console.log(`Processing ${validBooks.length} books...`);

  let translationsUpserted = 0;
  let titleLatinUpdated = 0;

  // Process in transaction batches
  for (let i = 0; i < validBooks.length; i += TX_BATCH_SIZE) {
    const batch = validBooks.slice(i, i + TX_BATCH_SIZE);

    await prisma.$transaction(async (tx) => {
      for (const book of batch) {
        // Upsert translations for each language
        for (const lang of LANGUAGES) {
          const title = book.translations[lang]?.trim();
          if (!title) continue;

          await tx.bookTitleTranslation.upsert({
            where: { bookId_language: { bookId: book.id, language: lang } },
            create: { bookId: book.id, language: lang, title },
            update: { title },
          });
          translationsUpserted++;
        }

        // Update titleLatin if null or forced
        const currentLatin = existingBookMap.get(book.id);
        if (book.titleLatin && (forceTransliteration || !currentLatin)) {
          await tx.book.update({
            where: { id: book.id },
            data: { titleLatin: book.titleLatin },
          });
          titleLatinUpdated++;
        }
      }
    });

    const processed = Math.min(i + TX_BATCH_SIZE, validBooks.length);
    if (processed % 500 === 0 || processed === validBooks.length) {
      console.log(`  Processed ${processed}/${validBooks.length} books`);
    }
  }

  console.log(`\nDone.`);
  console.log(`  Translations upserted: ${translationsUpserted}`);
  console.log(`  Book.titleLatin updated: ${titleLatinUpdated}`);
}

main()
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
