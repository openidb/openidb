/**
 * Populate Hadiths — Qdrant (Gemini 3072d) + Elasticsearch
 *
 * Embeds all 187K hadiths using kitab + bab + matn (fallback: kitab + bab + isnad).
 * Indexes all metadata (except translations) into Elasticsearch for BM25 keyword search.
 *
 * Usage:
 *   bun run pipelines/embed/populate-hadiths.ts [options]
 *
 * Options:
 *   --qdrant-only       Only populate Qdrant (skip Elasticsearch)
 *   --es-only           Only populate Elasticsearch (skip Qdrant)
 *   --collection=SLUG   Only process specific collection(s), comma-separated
 *   --batch-size=N      Embedding batch size (default: 50)
 *   --force             Re-embed even if points already exist in Qdrant
 */

import "../env";
import crypto from "crypto";
import { prisma } from "../../src/db";
import { qdrant, QDRANT_HADITH_COLLECTION } from "../../src/qdrant";
import { EMBEDDING_DIMENSIONS } from "../../src/constants";
import { generateEmbeddings } from "../../src/embeddings";
import { normalizeArabicText, truncateForEmbedding } from "../../src/embeddings/gemini";
import { generateHadithSourceUrl } from "../../src/utils/source-urls";
import {
  elasticsearch,
  ES_HADITHS_INDEX,
} from "../../src/search/elasticsearch";
import { hadithsIndexConfig } from "../../src/search/elasticsearch-indices";

// --- CLI flags ---
const args = process.argv.slice(2);
const qdrantOnly = args.includes("--qdrant-only");
const esOnly = args.includes("--es-only");
const forceFlag = args.includes("--force");
const batchSizeArg = args.find((a) => a.startsWith("--batch-size="));
const BATCH_SIZE = batchSizeArg ? parseInt(batchSizeArg.split("=")[1], 10) : 50;
const concurrencyArg = args.find((a) => a.startsWith("--concurrency="));
const CONCURRENCY = concurrencyArg ? parseInt(concurrencyArg.split("=")[1], 10) : 10;
const collectionArg = args.find((a) => a.startsWith("--collection="));
const collectionFilter = collectionArg
  ? collectionArg.split("=")[1].split(",").filter(Boolean)
  : null;

// ES bulk batch size (larger than embedding batch since no API call)
const ES_BATCH_SIZE = 1000;

// DB pre-fetch size: load many rows at once, then split into CONCURRENCY parallel embedding batches
const DB_FETCH_SIZE = BATCH_SIZE * CONCURRENCY;

// --- Helpers ---

function generateHadithPointId(collectionSlug: string, hadithNumber: string): string {
  const input = `hadith_${collectionSlug}_${hadithNumber}`;
  return crypto.createHash("md5").update(input).digest("hex");
}

/**
 * Build embedding text: kitab + bab + matn (or kitab + bab + isnad).
 * Falls back to textPlain if neither matn nor isnad is available.
 */
function buildEmbeddingText(
  kitabArabic: string | null,
  chapterArabic: string | null,
  matn: string | null,
  isnad: string | null,
  textPlain: string,
  slug: string,
): string {
  // Build metadata prefix from kitab (كتاب) and bab (باب)
  const prefixParts: string[] = [];
  if (kitabArabic) prefixParts.push(kitabArabic);
  if (chapterArabic) prefixParts.push(chapterArabic);

  // Choose body text: matn > isnad > textPlain
  let bodyText: string;
  if (matn) {
    bodyText = normalizeArabicText(matn);
  } else if (isnad) {
    bodyText = normalizeArabicText(isnad);
  } else {
    bodyText = textPlain; // textPlain is already normalized (no diacritics)
  }

  // For Hisn al-Muslim: short duas benefit from chapter context in the body
  if (slug === "hisn" && chapterArabic) {
    bodyText = `${normalizeArabicText(chapterArabic)}، ${bodyText}`;
  }

  if (prefixParts.length > 0) {
    const prefix = `${prefixParts.join("، ")}:`;
    return truncateForEmbedding(`${prefix}\n${bodyText}`);
  }

  return truncateForEmbedding(bodyText);
}

// The DB select clause used by both Qdrant and ES population
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

// --- Qdrant Population ---

async function initializeQdrantCollection(): Promise<void> {
  const collections = await qdrant.getCollections();
  const exists = collections.collections.some((c) => c.name === QDRANT_HADITH_COLLECTION);

  if (exists && forceFlag) {
    console.log(`Deleting existing collection: ${QDRANT_HADITH_COLLECTION}`);
    await qdrant.deleteCollection(QDRANT_HADITH_COLLECTION);
  }

  if (!exists || forceFlag) {
    console.log(`Creating collection: ${QDRANT_HADITH_COLLECTION}`);
    await qdrant.createCollection(QDRANT_HADITH_COLLECTION, {
      vectors: { size: EMBEDDING_DIMENSIONS, distance: "Cosine" },
      optimizers_config: { indexing_threshold: 10000 },
    });

    // Create payload indexes for filtering
    await qdrant.createPayloadIndex(QDRANT_HADITH_COLLECTION, {
      field_name: "collectionSlug",
      field_schema: "keyword",
    });
    await qdrant.createPayloadIndex(QDRANT_HADITH_COLLECTION, {
      field_name: "bookNumber",
      field_schema: "integer",
    });
    await qdrant.createPayloadIndex(QDRANT_HADITH_COLLECTION, {
      field_name: "hadithNumber",
      field_schema: "keyword",
    });

    console.log("Collection created with payload indexes");
  } else {
    console.log(`Collection exists: ${QDRANT_HADITH_COLLECTION}`);
  }
}

async function getExistingPointIds(): Promise<Set<string>> {
  if (forceFlag) return new Set();

  const existingIds = new Set<string>();
  try {
    let offset: string | undefined;
    while (true) {
      const result = await qdrant.scroll(QDRANT_HADITH_COLLECTION, {
        limit: 1000,
        with_payload: false,
        with_vector: false,
        offset,
      });
      for (const point of result.points) {
        existingIds.add(String(point.id));
      }
      if (!result.next_page_offset) break;
      offset = result.next_page_offset as string;
    }
  } catch {
    // Collection might be empty
  }
  return existingIds;
}

async function processQdrantBatch(hadiths: HadithRow[]): Promise<number> {
  const texts = hadiths.map((h) =>
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

  const points = hadiths.map((h, i) => {
    const slug = h.book.collection.slug;

    // For Hisn al-Muslim, enrich the stored textPlain with chapter context
    const enrichedTextPlain =
      slug === "hisn" && h.chapterArabic
        ? `${h.chapterArabic}، ${h.textPlain}`
        : h.textPlain;

    return {
      id: generateHadithPointId(slug, h.hadithNumber),
      vector: embeddings[i],
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
  return points.length;
}

async function populateQdrant(): Promise<void> {
  console.log("\n" + "=".repeat(60));
  console.log("QDRANT — Hadith Embeddings (Gemini 3072d)");
  console.log("=".repeat(60));
  console.log(`Collection: ${QDRANT_HADITH_COLLECTION}`);
  console.log(`Batch size: ${BATCH_SIZE}, Concurrency: ${CONCURRENCY}`);
  console.log(`Embedding text: kitab + bab + matn (fallback: isnad)`);
  if (collectionFilter) console.log(`Filter: ${collectionFilter.join(", ")}`);
  console.log();

  await initializeQdrantCollection();

  console.log("Checking for existing embeddings...");
  const existingIds = await getExistingPointIds();
  console.log(`Found ${existingIds.size} existing points`);

  const whereClause = collectionFilter
    ? { book: { collection: { slug: { in: collectionFilter } } } }
    : {};
  const totalCount = await prisma.hadith.count({ where: whereClause });
  console.log(`Total hadiths to process: ${totalCount}\n`);

  if (totalCount === 0) {
    console.log("No hadiths found.");
    return;
  }

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  let offset = 0;
  const startTime = Date.now();

  while (offset < totalCount) {
    // Pre-fetch a large chunk from DB
    const hadiths = await prisma.hadith.findMany({
      where: whereClause,
      skip: offset,
      take: DB_FETCH_SIZE,
      orderBy: [{ bookId: "asc" }, { hadithNumber: "asc" }],
      select: HADITH_SELECT,
    });

    if (hadiths.length === 0) break;

    // Filter out already embedded hadiths
    const toProcess = hadiths.filter((h) => {
      const pointId = generateHadithPointId(h.book.collection.slug, h.hadithNumber);
      if (existingIds.has(pointId)) {
        skipped++;
        return false;
      }
      return true;
    });

    // Split into batches of BATCH_SIZE and run CONCURRENCY in parallel
    const batches: HadithRow[][] = [];
    for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
      batches.push(toProcess.slice(i, i + BATCH_SIZE));
    }

    // Process batches in parallel waves of CONCURRENCY
    for (let w = 0; w < batches.length; w += CONCURRENCY) {
      const wave = batches.slice(w, w + CONCURRENCY);
      const results = await Promise.allSettled(wave.map((b) => processQdrantBatch(b)));

      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        if (r.status === "fulfilled") {
          processed += r.value;
        } else {
          console.error(`\nBatch failed:`, r.reason);
          failed += wave[j].length;
        }
      }

      const pct = (((processed + skipped) / totalCount) * 100).toFixed(1);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const rate = processed > 0 ? ((processed / (Date.now() - startTime)) * 1000).toFixed(0) : "0";
      process.stdout.write(
        `\r[Qdrant] ${processed + skipped}/${totalCount} (${pct}%) — embedded: ${processed}, skipped: ${skipped}, failed: ${failed} — ${elapsed}s (${rate}/s)`
      );
    }

    offset += hadiths.length;
  }

  console.log("\n");

  // Verify
  try {
    const info = await qdrant.getCollection(QDRANT_HADITH_COLLECTION);
    console.log(`Qdrant collection points: ${info.points_count}`);
  } catch (error) {
    console.error("Could not get collection info:", error);
  }

  console.log(`Processed: ${processed}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Failed: ${failed}`);
}

// --- Elasticsearch Population ---

async function populateElasticsearch(): Promise<void> {
  console.log("\n" + "=".repeat(60));
  console.log("ELASTICSEARCH — Hadith Index");
  console.log("=".repeat(60));

  // Check ES connection
  try {
    const health = await elasticsearch.cluster.health();
    console.log(`Cluster health: ${health.status}`);
  } catch (error) {
    console.error("Failed to connect to Elasticsearch:", error);
    return;
  }

  // Create index if it doesn't exist
  const indexExists = await elasticsearch.indices.exists({ index: ES_HADITHS_INDEX });
  if (indexExists) {
    if (forceFlag) {
      console.log(`Deleting existing index: ${ES_HADITHS_INDEX}`);
      await elasticsearch.indices.delete({ index: ES_HADITHS_INDEX });
    } else {
      console.log(`Index ${ES_HADITHS_INDEX} already exists. Use --force to recreate.`);
    }
  }

  if (!indexExists || forceFlag) {
    console.log(`Creating index: ${ES_HADITHS_INDEX}`);
    await elasticsearch.indices.create(hadithsIndexConfig);
    console.log("Index created with Arabic analyzer + expanded field mapping");
  }

  // Sync hadiths
  const whereClause = collectionFilter
    ? { book: { collection: { slug: { in: collectionFilter } } } }
    : {};
  const totalCount = await prisma.hadith.count({ where: whereClause });
  console.log(`\nTotal hadiths to index: ${totalCount}`);

  let processed = 0;
  let offset = 0;
  const startTime = Date.now();

  while (offset < totalCount) {
    const hadiths = await prisma.hadith.findMany({
      where: whereClause,
      skip: offset,
      take: ES_BATCH_SIZE,
      select: HADITH_SELECT,
    });

    if (hadiths.length === 0) break;

    interface BulkOp { index: { _index: string; _id: string } }
    const bulkBody: (BulkOp | Record<string, unknown>)[] = [];

    for (const h of hadiths) {
      // Build comprehensive text_searchable for BM25 keyword search
      const searchableParts = [h.book.collection.nameArabic];
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
        collection_slug: h.book.collection.slug,
        collection_name_arabic: h.book.collection.nameArabic,
        collection_name_english: h.book.collection.nameEnglish,
      });
    }

    const result = await elasticsearch.bulk({ body: bulkBody, refresh: false });

    if (result.errors) {
      const errorItems = result.items.filter((item) => item.index?.error);
      console.error(`Bulk errors: ${errorItems.length}`);
      if (errorItems.length > 0) {
        console.error("First error:", JSON.stringify(errorItems[0].index?.error, null, 2));
      }
    }

    processed += hadiths.length;
    offset += ES_BATCH_SIZE;

    const pct = ((processed / totalCount) * 100).toFixed(1);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    process.stdout.write(`\r[ES] Indexed: ${processed}/${totalCount} (${pct}%) — ${elapsed}s`);
  }

  // Refresh index
  await elasticsearch.indices.refresh({ index: ES_HADITHS_INDEX });

  // Verify
  const esCount = await elasticsearch.count({ index: ES_HADITHS_INDEX });
  console.log(`\nElasticsearch hadiths count: ${esCount.count}`);
}

// --- Main ---

async function main() {
  console.log("Hadith Population — Qdrant + Elasticsearch");
  console.log("=".repeat(60));
  console.log(`Mode: ${esOnly ? "ES only" : qdrantOnly ? "Qdrant only" : "Both"}`);
  if (collectionFilter) console.log(`Collections: ${collectionFilter.join(", ")}`);
  if (forceFlag) console.log("Force: ON (re-process existing data)");
  console.log();

  const startTime = Date.now();

  if (!esOnly) {
    await populateQdrant();
  }

  if (!qdrantOnly) {
    await populateElasticsearch();
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Done in ${totalTime}s`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Population failed:", err);
  process.exit(1);
});
