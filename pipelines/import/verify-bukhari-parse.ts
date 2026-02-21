/**
 * Verify Bukhari Parse Results
 *
 * Runs diagnostics on the imported Bukhari hadith data:
 * - Count comparison (parsed vs DB)
 * - Coverage (% enriched with source page refs)
 * - Isnad/matn separation stats
 * - Hadith number gap analysis
 * - Random spot-checks with full field display
 * - Sample URL generation
 *
 * Usage:
 *   bun run pipelines/import/verify-bukhari-parse.ts
 */

import "../env";
import { prisma } from "../../src/db";
import { generatePageReferenceUrl } from "../../src/utils/source-urls";

const COLLECTION_SLUG = "bukhari";
const SOURCE_BOOK_ID = "1681";

async function main() {
  console.log("=== Bukhari Parse Verification ===\n");

  // 1. Count comparison
  const totalHadiths = await prisma.hadith.count({
    where: { book: { collection: { slug: COLLECTION_SLUG } } },
  });

  const enrichedHadiths = await prisma.hadith.count({
    where: {
      book: { collection: { slug: COLLECTION_SLUG } },
      sourceBookId: SOURCE_BOOK_ID,
    },
  });

  console.log("1. Count Comparison");
  console.log(`   Total Bukhari hadiths in DB:  ${totalHadiths}`);
  console.log(`   Enriched with page refs:      ${enrichedHadiths}`);
  console.log(`   Coverage:                     ${((enrichedHadiths / totalHadiths) * 100).toFixed(1)}%`);
  console.log(`   Missing:                      ${totalHadiths - enrichedHadiths}`);

  // 2. Isnad/matn separation
  const withIsnad = await prisma.hadith.count({
    where: {
      book: { collection: { slug: COLLECTION_SLUG } },
      isnad: { not: null },
    },
  });

  const withMatn = await prisma.hadith.count({
    where: {
      book: { collection: { slug: COLLECTION_SLUG } },
      matn: { not: null },
    },
  });

  const withFootnotes = await prisma.hadith.count({
    where: {
      book: { collection: { slug: COLLECTION_SLUG } },
      footnotes: { not: null },
    },
  });

  const withKitab = await prisma.hadith.count({
    where: {
      book: { collection: { slug: COLLECTION_SLUG } },
      kitabArabic: { not: null },
    },
  });

  const chainVariations = await prisma.hadith.count({
    where: {
      book: { collection: { slug: COLLECTION_SLUG } },
      isChainVariation: true,
    },
  });

  console.log("\n2. Field Coverage");
  console.log(`   With isnad:          ${withIsnad} (${((withIsnad / totalHadiths) * 100).toFixed(1)}%)`);
  console.log(`   With matn:           ${withMatn} (${((withMatn / totalHadiths) * 100).toFixed(1)}%)`);
  console.log(`   With footnotes:      ${withFootnotes} (${((withFootnotes / totalHadiths) * 100).toFixed(1)}%)`);
  console.log(`   With kitab:          ${withKitab} (${((withKitab / totalHadiths) * 100).toFixed(1)}%)`);
  console.log(`   Chain variations:    ${chainVariations}`);

  // 3. Hadith number gap analysis
  const allNumbers = await prisma.hadith.findMany({
    where: { book: { collection: { slug: COLLECTION_SLUG } } },
    select: { hadithNumber: true },
    orderBy: { hadithNumber: "asc" },
  });

  const numericNumbers = allNumbers
    .map((h) => parseInt(h.hadithNumber.replace(/[^0-9]/g, ""), 10))
    .filter((n) => !isNaN(n))
    .sort((a, b) => a - b);

  const gaps: Array<{ from: number; to: number }> = [];
  for (let i = 1; i < numericNumbers.length; i++) {
    const diff = numericNumbers[i] - numericNumbers[i - 1];
    if (diff > 1) {
      gaps.push({ from: numericNumbers[i - 1] + 1, to: numericNumbers[i] - 1 });
    }
  }

  console.log("\n3. Number Gap Analysis");
  console.log(`   Range: ${numericNumbers[0]} – ${numericNumbers[numericNumbers.length - 1]}`);
  console.log(`   Total unique numbers: ${numericNumbers.length}`);
  if (gaps.length === 0) {
    console.log("   No gaps found!");
  } else {
    console.log(`   Gaps found: ${gaps.length}`);
    for (const gap of gaps.slice(0, 10)) {
      const size = gap.to - gap.from + 1;
      console.log(`     ${gap.from}–${gap.to} (${size} missing)`);
    }
    if (gaps.length > 10) {
      console.log(`     ... and ${gaps.length - 10} more gaps`);
    }
  }

  // 4. Random spot-check
  const spotCheck = await prisma.hadith.findMany({
    where: {
      book: { collection: { slug: COLLECTION_SLUG } },
      sourceBookId: SOURCE_BOOK_ID,
    },
    select: {
      hadithNumber: true,
      isnad: true,
      matn: true,
      kitabArabic: true,
      chapterArabic: true,
      footnotes: true,
      sourcePageStart: true,
      sourcePageEnd: true,
      sourceVolumeNumber: true,
      sourcePrintedPage: true,
      isChainVariation: true,
    },
    take: 10,
    orderBy: { id: "asc" },
  });

  console.log("\n4. Spot Check (first 10 enriched hadiths)");
  for (const h of spotCheck) {
    console.log(`\n   --- Hadith #${h.hadithNumber} ---`);
    console.log(`   Kitab: ${h.kitabArabic || "(none)"}`);
    console.log(`   Bab:   ${h.chapterArabic || "(none)"}`);
    console.log(`   Isnad: ${h.isnad?.slice(0, 80) || "(none)"}${h.isnad && h.isnad.length > 80 ? "..." : ""}`);
    console.log(`   Matn:  ${h.matn?.slice(0, 80) || "(none)"}${h.matn && h.matn.length > 80 ? "..." : ""}`);
    console.log(`   Pages: ${h.sourcePageStart}–${h.sourcePageEnd} (vol ${h.sourceVolumeNumber}, printed p.${h.sourcePrintedPage})`);
    console.log(`   Footnotes: ${h.footnotes ? "yes (" + h.footnotes.length + " chars)" : "no"}`);
    console.log(`   Chain variation: ${h.isChainVariation}`);
  }

  // 5. Sample URLs
  console.log("\n5. Sample Source URLs");
  for (const h of spotCheck.slice(0, 5)) {
    if (h.sourcePageStart) {
      const url = generatePageReferenceUrl(SOURCE_BOOK_ID, h.sourcePageStart);
      console.log(`   Hadith #${h.hadithNumber}: ${url}`);
    }
  }

  // 6. Volume distribution
  const volumeDist = await prisma.$queryRawUnsafe<Array<{ source_volume_number: number; count: bigint }>>(
    `SELECT source_volume_number, COUNT(*) as count
     FROM hadiths h
     JOIN hadith_books hb ON h.book_id = hb.id
     JOIN hadith_collections hc ON hb.collection_id = hc.id
     WHERE hc.slug = $1 AND h.source_book_id = $2
     GROUP BY source_volume_number
     ORDER BY source_volume_number`,
    COLLECTION_SLUG,
    SOURCE_BOOK_ID,
  );

  console.log("\n6. Volume Distribution");
  for (const row of volumeDist) {
    console.log(`   Volume ${row.source_volume_number}: ${row.count} hadiths`);
  }

  console.log("\n=== Verification Complete ===");
}

main()
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
