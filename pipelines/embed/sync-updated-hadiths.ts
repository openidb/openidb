/**
 * Targeted Hadith Sync — Update specific hadith IDs in Qdrant + Elasticsearch
 *
 * Used after isnad/matn resplit to update only affected hadiths without
 * re-embedding the entire collection.
 *
 * Usage:
 *   bun run pipelines/embed/sync-updated-hadiths.ts --ids-from=FILE    # File with one ID per line
 *   bun run pipelines/embed/sync-updated-hadiths.ts --ids=1,2,3        # Comma-separated IDs
 *   bun run pipelines/embed/sync-updated-hadiths.ts --from-resplit      # Auto-detect from resplit result files
 *   bun run pipelines/embed/sync-updated-hadiths.ts --es-only           # Only update Elasticsearch
 *   bun run pipelines/embed/sync-updated-hadiths.ts --qdrant-only       # Only update Qdrant
 *   bun run pipelines/embed/sync-updated-hadiths.ts --dry-run           # Show counts only
 */

import "../env";
import crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { prisma } from "../../src/db";
import { qdrant, QDRANT_HADITH_COLLECTION } from "../../src/qdrant";
import { generateEmbeddings } from "../../src/embeddings";
import { normalizeArabicText, truncateForEmbedding } from "../../src/embeddings/gemini";
import { generateHadithSourceUrl } from "../../src/utils/source-urls";
import {
  elasticsearch,
  ES_HADITHS_INDEX,
} from "../../src/search/elasticsearch";

// --- CLI ---
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const esOnly = args.includes("--es-only");
const qdrantOnly = args.includes("--qdrant-only");
const fromResplit = args.includes("--from-resplit");
const idsArg = args.find((a) => a.startsWith("--ids="));
const idsFileArg = args.find((a) => a.startsWith("--ids-from="));
const batchSizeArg = args.find((a) => a.startsWith("--batch-size="));
const BATCH_SIZE = batchSizeArg ? parseInt(batchSizeArg.split("=")[1], 10) : 50;

// --- Helpers ---

function generateHadithPointId(collectionSlug: string, hadithNumber: string): string {
  const input = `hadith_${collectionSlug}_${hadithNumber}`;
  return crypto.createHash("md5").update(input).digest("hex");
}

function buildEmbeddingText(
  kitabArabic: string | null,
  chapterArabic: string | null,
  matn: string | null,
  isnad: string | null,
  textPlain: string,
  slug: string,
): string {
  const prefixParts: string[] = [];
  if (kitabArabic) prefixParts.push(kitabArabic);
  if (chapterArabic) prefixParts.push(chapterArabic);

  let bodyText: string;
  if (matn) {
    bodyText = normalizeArabicText(matn);
  } else if (isnad) {
    bodyText = normalizeArabicText(isnad);
  } else {
    bodyText = textPlain;
  }

  if (slug === "hisn" && chapterArabic) {
    bodyText = `${normalizeArabicText(chapterArabic)}، ${bodyText}`;
  }

  if (prefixParts.length > 0) {
    const prefix = `${prefixParts.join("، ")}:`;
    return truncateForEmbedding(`${prefix}\n${bodyText}`);
  }

  return truncateForEmbedding(bodyText);
}

const HADITH_SELECT = {
  id: true,
  bookId: true,
  hadithNumber: true,
  numberInCollection: true,
  textArabic: true,
  textPlain: true,
  chapterArabic: true,
  chapterEnglish: true,
  isChainVariation: true,
  kitabArabic: true,
  isnad: true,
  matn: true,
  grade: true,
  gradeText: true,
  gradeExplanation: true,
  graderName: true,
  sourceBookId: true,
  sourceBookName: true,
  sourcePageStart: true,
  sourcePageEnd: true,
  sourceVolumeNumber: true,
  sourcePrintedPage: true,
  footnotes: true,
  book: {
    select: {
      bookNumber: true,
      nameArabic: true,
      nameEnglish: true,
      collection: {
        select: {
          slug: true,
          nameArabic: true,
          nameEnglish: true,
        },
      },
    },
  },
} as const;

type HadithRow = Awaited<ReturnType<typeof prisma.hadith.findMany<{ select: typeof HADITH_SELECT }>>>[number];

// --- Collect IDs ---

function collectIds(): number[] {
  if (fromResplit) {
    const batchDir = path.resolve(import.meta.dir, "../import/isnad-matn-batches");
    const resultFiles = fs.readdirSync(batchDir).filter((f) => f.endsWith(".result.json")).sort();
    const ids = new Set<number>();
    for (const file of resultFiles) {
      const data: Array<{ id: number; splitWord: number }> = JSON.parse(
        fs.readFileSync(path.join(batchDir, file), "utf-8")
      );
      for (const r of data) ids.add(r.id);
    }
    return [...ids];
  }

  if (idsArg) {
    return idsArg.split("=")[1].split(",").map(Number).filter(Boolean);
  }

  if (idsFileArg) {
    const filePath = idsFileArg.split("=")[1];
    const content = fs.readFileSync(filePath, "utf-8");
    return content.split("\n").map((l) => parseInt(l.trim(), 10)).filter(Boolean);
  }

  console.error("Must specify --from-resplit, --ids=, or --ids-from=");
  process.exit(1);
}

// --- Qdrant Update ---

async function updateQdrant(hadiths: HadithRow[]): Promise<number> {
  let updated = 0;

  for (let i = 0; i < hadiths.length; i += BATCH_SIZE) {
    const batch = hadiths.slice(i, i + BATCH_SIZE);

    const texts = batch.map((h) =>
      buildEmbeddingText(
        h.kitabArabic,
        h.chapterArabic,
        h.matn,
        h.isnad,
        h.textPlain,
        h.book.collection.slug,
      )
    );

    const embeddings = await generateEmbeddings(texts);

    const points = batch.map((h, j) => {
      const slug = h.book.collection.slug;
      const enrichedTextPlain =
        slug === "hisn" && h.chapterArabic
          ? `${h.chapterArabic}، ${h.textPlain}`
          : h.textPlain;

      return {
        id: generateHadithPointId(slug, h.hadithNumber),
        vector: embeddings[j],
        payload: {
          collectionSlug: slug,
          collectionNameArabic: h.book.collection.nameArabic,
          collectionNameEnglish: h.book.collection.nameEnglish,
          bookId: h.bookId,
          bookNumber: h.book.bookNumber,
          bookNameArabic: h.book.nameArabic,
          bookNameEnglish: h.book.nameEnglish,
          hadithNumber: h.hadithNumber,
          text: h.textArabic,
          textPlain: enrichedTextPlain,
          chapterArabic: h.chapterArabic,
          chapterEnglish: h.chapterEnglish,
          sourceUrl: generateHadithSourceUrl(
            slug, h.hadithNumber, h.book.bookNumber,
            h.numberInCollection, h.sourceBookId, h.sourcePageStart,
          ),
          embeddingTechnique: "kitab-bab-matn",
        },
      };
    });

    await qdrant.upsert(QDRANT_HADITH_COLLECTION, { wait: true, points });
    updated += points.length;
    console.log(`  Qdrant: ${updated}/${hadiths.length}`);
  }

  return updated;
}

// --- Elasticsearch Update ---

async function updateElasticsearch(hadiths: HadithRow[]): Promise<number> {
  let updated = 0;
  const ES_BATCH = 1000;

  for (let i = 0; i < hadiths.length; i += ES_BATCH) {
    const batch = hadiths.slice(i, i + ES_BATCH);
    const bulkBody: any[] = [];

    for (const h of batch) {
      const searchableParts: string[] = [];
      const slug = h.book.collection.slug;
      searchableParts.push(h.book.collection.nameArabic);
      if (h.book.nameArabic) searchableParts.push(h.book.nameArabic);
      if (h.kitabArabic) searchableParts.push(h.kitabArabic);
      if (h.chapterArabic) searchableParts.push(h.chapterArabic);
      searchableParts.push(h.textPlain);
      if (h.graderName) searchableParts.push(h.graderName);
      const textSearchable = searchableParts.join(" ");

      bulkBody.push({
        index: { _index: ES_HADITHS_INDEX, _id: String(h.id) },
      });
      bulkBody.push({
        id: h.id,
        book_id: h.bookId,
        hadith_number: h.hadithNumber,
        number_in_collection: h.numberInCollection,
        text_arabic: h.textArabic,
        text_plain: h.textPlain,
        text_searchable: textSearchable,
        kitab_arabic: h.kitabArabic,
        chapter_arabic: h.chapterArabic,
        chapter_english: h.chapterEnglish,
        isnad: h.isnad,
        matn: h.matn,
        grade: h.grade,
        grade_text: h.gradeText,
        grader_name: h.graderName,
        source_book_id: h.sourceBookId,
        source_page_start: h.sourcePageStart,
        source_volume_number: h.sourceVolumeNumber,
        source_printed_page: h.sourcePrintedPage,
        footnotes: h.footnotes,
        is_chain_variation: h.isChainVariation,
        book_number: h.book.bookNumber,
        book_name_arabic: h.book.nameArabic,
        book_name_english: h.book.nameEnglish,
        collection_slug: slug,
        collection_name_arabic: h.book.collection.nameArabic,
        collection_name_english: h.book.collection.nameEnglish,
      });
    }

    const result = await elasticsearch.bulk({ body: bulkBody, refresh: false });
    if (result.errors) {
      const errorItems = result.items.filter((item: any) => item.index?.error);
      console.error(`  ES bulk errors: ${errorItems.length}`);
      if (errorItems.length > 0) {
        console.error("  First error:", JSON.stringify(errorItems[0].index?.error, null, 2));
      }
    }

    updated += batch.length;
    console.log(`  Elasticsearch: ${updated}/${hadiths.length}`);
  }

  return updated;
}

// --- Main ---

async function main() {
  const ids = collectIds();
  console.log(`Collected ${ids.length} hadith IDs to sync`);

  if (ids.length === 0) {
    console.log("Nothing to sync.");
    return;
  }

  if (dryRun) {
    console.log("Dry run — no changes will be made.");
    console.log(`Would update ${ids.length} hadiths in ${esOnly ? "ES" : qdrantOnly ? "Qdrant" : "ES + Qdrant"}`);
    return;
  }

  // Fetch hadith data from DB
  console.log("Fetching hadith data from DB...");
  const hadiths: HadithRow[] = [];
  const CHUNK = 5000;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rows = await prisma.hadith.findMany({
      where: { id: { in: chunk } },
      select: HADITH_SELECT,
    });
    hadiths.push(...rows);
  }
  console.log(`Fetched ${hadiths.length} hadiths from DB`);

  if (!esOnly) {
    console.log(`\nUpdating Qdrant (${QDRANT_HADITH_COLLECTION})...`);
    const qdrantCount = await updateQdrant(hadiths);
    console.log(`Qdrant: ${qdrantCount} points upserted`);
  }

  if (!qdrantOnly) {
    console.log(`\nUpdating Elasticsearch (${ES_HADITHS_INDEX})...`);
    const esCount = await updateElasticsearch(hadiths);
    console.log(`Elasticsearch: ${esCount} documents indexed`);
  }

  console.log("\nDone!");
}

main()
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
