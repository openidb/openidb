/**
 * Update Qdrant hadith payload text fields WITHOUT re-embedding.
 *
 * Scrolls through Qdrant to get existing vectors, fetches updated text from DB,
 * and upserts back with same vectors + updated payload. No embedding API calls.
 *
 * Usage:
 *   bun run pipelines/embed/update-qdrant-payload.ts
 *   bun run pipelines/embed/update-qdrant-payload.ts --dry-run
 */

import "../env";
import crypto from "crypto";
import { prisma } from "../../src/db";
import { qdrant, QDRANT_HADITH_COLLECTION } from "../../src/qdrant";
import { generateHadithSourceUrl } from "../../src/utils/source-urls";

const dryRun = process.argv.includes("--dry-run");
const SCROLL_BATCH = 100;

function generateHadithPointId(collectionSlug: string, hadithNumber: string): string {
  const input = `hadith_${collectionSlug}_${hadithNumber}`;
  const hex = crypto.createHash("md5").update(input).digest("hex");
  // Format as UUID: 8-4-4-4-12
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function main() {
  // Build a map of point ID → hadith data from DB
  console.log("Loading all hadiths from DB...");
  const pointMap = new Map<string, {
    textArabic: string;
    textPlain: string;
    chapterArabic: string | null;
    chapterEnglish: string | null;
    slug: string;
    hadithNumber: string;
    bookNumber: number;
    numberInCollection: number | null;
    sourceBookId: number | null;
    sourcePageStart: number | null;
    bookNameArabic: string | null;
    bookNameEnglish: string | null;
    collectionNameArabic: string;
    collectionNameEnglish: string | null;
    bookId: number;
  }>();

  let cursor: number | undefined;
  const DB_BATCH = 5000;

  while (true) {
    const hadiths = await prisma.hadith.findMany({
      take: DB_BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
      select: {
        id: true,
        bookId: true,
        hadithNumber: true,
        numberInCollection: true,
        textArabic: true,
        textPlain: true,
        chapterArabic: true,
        chapterEnglish: true,
        sourceBookId: true,
        sourcePageStart: true,
        book: {
          select: {
            bookNumber: true,
            nameArabic: true,
            nameEnglish: true,
            collection: {
              select: { slug: true, nameArabic: true, nameEnglish: true },
            },
          },
        },
      },
    });

    if (hadiths.length === 0) break;
    cursor = hadiths[hadiths.length - 1].id;

    for (const h of hadiths) {
      const slug = h.book.collection.slug;
      const pointId = generateHadithPointId(slug, h.hadithNumber);
      pointMap.set(pointId, {
        textArabic: h.textArabic,
        textPlain: h.textPlain,
        chapterArabic: h.chapterArabic,
        chapterEnglish: h.chapterEnglish,
        slug,
        hadithNumber: h.hadithNumber,
        bookNumber: h.book.bookNumber,
        numberInCollection: h.numberInCollection,
        sourceBookId: h.sourceBookId,
        sourcePageStart: h.sourcePageStart,
        bookNameArabic: h.book.nameArabic,
        bookNameEnglish: h.book.nameEnglish,
        collectionNameArabic: h.book.collection.nameArabic,
        collectionNameEnglish: h.book.collection.nameEnglish,
        bookId: h.bookId,
      });
    }

    console.log(`  Loaded ${pointMap.size} hadiths...`);
  }

  console.log(`Total hadiths in DB: ${pointMap.size}`);

  if (dryRun) {
    console.log("Dry run — no changes will be made.");
    return;
  }

  // Scroll through Qdrant, get vectors, upsert with updated payload
  console.log(`\nScrolling Qdrant collection '${QDRANT_HADITH_COLLECTION}'...`);
  let offset: string | number | undefined = undefined;
  let updated = 0;
  let notFound = 0;

  while (true) {
    const scrollResult = await qdrant.scroll(QDRANT_HADITH_COLLECTION, {
      limit: SCROLL_BATCH,
      offset,
      with_vector: true,
      with_payload: true,
    });

    const points = scrollResult.points;
    if (points.length === 0) break;

    const upsertPoints: any[] = [];

    for (const point of points) {
      const pointId = String(point.id);
      const dbData = pointMap.get(pointId);

      if (!dbData) {
        notFound++;
        continue;
      }

      const enrichedTextPlain =
        dbData.slug === "hisn" && dbData.chapterArabic
          ? `${dbData.chapterArabic}، ${dbData.textPlain}`
          : dbData.textPlain;

      // Keep existing payload fields, update text fields
      const existingPayload = point.payload || {};
      upsertPoints.push({
        id: pointId,
        vector: point.vector,
        payload: {
          ...existingPayload,
          text: dbData.textArabic,
          textPlain: enrichedTextPlain,
          chapterArabic: dbData.chapterArabic,
          chapterEnglish: dbData.chapterEnglish,
          sourceUrl: generateHadithSourceUrl(
            dbData.slug, dbData.hadithNumber, dbData.bookNumber,
            dbData.numberInCollection, dbData.sourceBookId, dbData.sourcePageStart,
          ),
        },
      });
    }

    if (upsertPoints.length > 0) {
      await qdrant.upsert(QDRANT_HADITH_COLLECTION, {
        wait: true,
        points: upsertPoints,
      });
    }

    updated += upsertPoints.length;
    offset = scrollResult.next_page_offset;

    if (updated % 1000 < SCROLL_BATCH || !offset) {
      console.log(`  Updated: ${updated} (not found in DB: ${notFound})`);
    }

    if (!offset) break;
  }

  console.log(`\nDone! Updated ${updated} Qdrant payload entries. Not found in DB: ${notFound}.`);
}

main()
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
