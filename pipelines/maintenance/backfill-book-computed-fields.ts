/**
 * Backfill pre-computed fields on the books table.
 *
 * Sets:
 *   - max_printed_page:        highest printed page number across all pages
 *   - volume_start_pages:      {volumeNumber: firstPageNumber} for each volume (excl. vol 0)
 *   - volume_max_printed_pages: {volumeNumber: maxPrintedPage} for each volume (excl. vol 0)
 *   - volume_min_printed_pages: {volumeNumber: minPrintedPage} for each volume (excl. vol 0)
 *
 * Usage:
 *   bun run pipelines/maintenance/backfill-book-computed-fields.ts
 */

import { prisma } from "../../src/db";

async function main() {
  console.log("Backfilling pre-computed book fields...\n");

  // 1. max_printed_page — highest printed page number for each book
  console.log("1/4  Computing max_printed_page...");
  const maxPageResult = await prisma.$executeRawUnsafe(`
    UPDATE books b SET max_printed_page = sub.max_pp
    FROM (
      SELECT book_id, MAX(printed_page_number) AS max_pp
      FROM pages
      WHERE printed_page_number IS NOT NULL
      GROUP BY book_id
    ) sub
    WHERE b.id = sub.book_id
  `);
  console.log(`     Updated ${maxPageResult} books`);

  // 2. volume_start_pages — {vol: first page number} excluding volume 0
  console.log("2/4  Computing volume_start_pages...");
  const volStartResult = await prisma.$executeRawUnsafe(`
    UPDATE books b SET volume_start_pages = sub.vol_map
    FROM (
      SELECT book_id,
        jsonb_object_agg(volume_number::text, min_page ORDER BY volume_number) AS vol_map
      FROM (
        SELECT book_id, volume_number, MIN(page_number) AS min_page
        FROM pages
        WHERE volume_number > 0
        GROUP BY book_id, volume_number
      ) vol_data
      GROUP BY book_id
    ) sub
    WHERE b.id = sub.book_id
  `);
  console.log(`     Updated ${volStartResult} books`);

  // 3. volume_max_printed_pages — {vol: max printed page} excluding volume 0
  console.log("3/4  Computing volume_max_printed_pages...");
  const volMaxResult = await prisma.$executeRawUnsafe(`
    UPDATE books b SET volume_max_printed_pages = sub.vol_map
    FROM (
      SELECT book_id,
        jsonb_object_agg(volume_number::text, max_pp ORDER BY volume_number) AS vol_map
      FROM (
        SELECT book_id, volume_number, MAX(printed_page_number) AS max_pp
        FROM pages
        WHERE volume_number > 0 AND printed_page_number IS NOT NULL
        GROUP BY book_id, volume_number
      ) vol_data
      GROUP BY book_id
    ) sub
    WHERE b.id = sub.book_id
  `);
  console.log(`     Updated ${volMaxResult} books`);

  // 4. volume_min_printed_pages — {vol: min printed page} excluding volume 0
  console.log("4/4  Computing volume_min_printed_pages...");
  const volMinResult = await prisma.$executeRawUnsafe(`
    UPDATE books b SET volume_min_printed_pages = sub.vol_map
    FROM (
      SELECT book_id,
        jsonb_object_agg(volume_number::text, min_pp ORDER BY volume_number) AS vol_map
      FROM (
        SELECT book_id, volume_number, MIN(printed_page_number) AS min_pp
        FROM pages
        WHERE volume_number > 0 AND printed_page_number IS NOT NULL
        GROUP BY book_id, volume_number
      ) vol_data
      GROUP BY book_id
    ) sub
    WHERE b.id = sub.book_id
  `);
  console.log(`     Updated ${volMinResult} books`);

  // Also update totalVolumes to reflect real volume count (excluding vol 0)
  console.log("\n     Updating total_volumes from actual page data...");
  const volCountResult = await prisma.$executeRawUnsafe(`
    UPDATE books b SET total_volumes = sub.real_vols
    FROM (
      SELECT book_id, COUNT(DISTINCT volume_number) AS real_vols
      FROM pages
      WHERE volume_number > 0
      GROUP BY book_id
    ) sub
    WHERE b.id = sub.book_id AND b.total_volumes != sub.real_vols
  `);
  console.log(`     Corrected total_volumes on ${volCountResult} books`);

  // Summary
  const stats = await prisma.$queryRawUnsafe<{ total: bigint; with_max: bigint; with_vols: bigint }[]>(`
    SELECT
      COUNT(*)::bigint AS total,
      COUNT(max_printed_page)::bigint AS with_max,
      COUNT(volume_start_pages)::bigint AS with_vols
    FROM books
  `);
  const s = stats[0];
  console.log(`\nSummary: ${s?.total} total books, ${s?.with_max} with max_printed_page, ${s?.with_vols} with volume maps`);
  console.log("Done.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
