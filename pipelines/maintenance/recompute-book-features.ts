/**
 * Recompute pre-computed feature columns on the books table.
 *
 * Sets:
 *   - has_pdf:              true if the book has at least one page with a pdf_url
 *   - translated_languages: array of language codes where ALL pages are translated
 *
 * Usage:
 *   bun run pipelines/maintenance/recompute-book-features.ts
 */

import { prisma } from "../../src/db";

async function main() {
  console.log("Recomputing book feature columns...\n");

  // 1. has_pdf — true if book has any page with pdf_url
  console.log("1/2  Recomputing has_pdf...");
  const pdfResult = await prisma.$executeRawUnsafe(`
    UPDATE books SET has_pdf = EXISTS (
      SELECT 1 FROM pages p
      WHERE p.book_id = books.id
        AND p.pdf_url IS NOT NULL
        AND p.pdf_url != ''
    )
  `);
  console.log(`     Updated ${pdfResult} books`);

  // Count
  const pdfCount = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT COUNT(*)::bigint AS count FROM books WHERE has_pdf = true`
  );
  console.log(`     Books with PDF: ${pdfCount[0]?.count ?? 0}`);

  // 2. translated_languages — languages where ALL pages of the book are translated
  console.log("2/2  Recomputing translated_languages...");
  const tlResult = await prisma.$executeRawUnsafe(`
    UPDATE books b SET translated_languages = COALESCE(
      (
        SELECT ARRAY_AGG(lang ORDER BY lang)
        FROM (
          SELECT pt.language AS lang
          FROM page_translations pt
          JOIN pages p ON p.id = pt.page_id
          WHERE p.book_id = b.id AND p.page_number > 0
          GROUP BY pt.language
          HAVING COUNT(*) = b.total_pages
        ) fully_translated
      ),
      '{}'::text[]
    )
  `);
  console.log(`     Updated ${tlResult} books`);

  // Count per language
  const langCounts = await prisma.$queryRawUnsafe<{ lang: string; count: bigint }[]>(`
    SELECT unnest(translated_languages) AS lang, COUNT(*)::bigint AS count
    FROM books
    WHERE array_length(translated_languages, 1) > 0
    GROUP BY lang
    ORDER BY count DESC
  `);
  if (langCounts.length > 0) {
    console.log("     Fully translated books per language:");
    for (const { lang, count } of langCounts) {
      console.log(`       ${lang}: ${count}`);
    }
  } else {
    console.log("     No fully translated books found");
  }

  console.log("\nDone.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
