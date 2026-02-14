/**
 * Dorar.net Hadith Importer
 *
 * Two modes of operation:
 *
 * 1. API mode (recommended): Calls dorar.net/dorar_api.json directly.
 *    No wrapper needed. Unlimited pagination = 100% coverage.
 *
 * 2. Site mode (legacy): Uses the dorar-hadith-api wrapper for site search.
 *    Limited to 10 pages (300 results) per search term.
 *    Wrapper must be running: cd tools/dorar-hadith-api && node server.js
 *
 * Usage:
 *   # API mode — full coverage, no wrapper needed (recommended)
 *   bun run pipelines/import/scrape-dorar.ts --collection=ibn-hibban --api-mode
 *
 *   # API mode — all collections
 *   bun run pipelines/import/scrape-dorar.ts --all --api-mode
 *
 *   # Discover available book IDs from Dorar (needs wrapper)
 *   bun run pipelines/import/scrape-dorar.ts --discover
 *
 *   # Site mode — legacy (needs wrapper)
 *   bun run pipelines/import/scrape-dorar.ts --collection=ibn-hibban
 *
 *   # Enrich API-cached data with site-mode cache (hadithId, categories)
 *   bun run pipelines/import/scrape-dorar.ts --collection=ibn-hibban --api-mode --enrich
 *
 *   # Resume from a specific page
 *   bun run pipelines/import/scrape-dorar.ts --collection=ibn-hibban --api-mode --page=5
 *
 *   # Dry run — fetch and cache without importing to DB
 *   bun run pipelines/import/scrape-dorar.ts --collection=ibn-hibban --api-mode --dry-run
 *
 *   # Import from already-cached data only (skip API fetching)
 *   bun run pipelines/import/scrape-dorar.ts --collection=ibn-hibban --api-mode --import-only
 */

import "../env";
import { prisma } from "../../src/db";
import { normalizeArabicText } from "../../src/embeddings";
import { hashHadith } from "../../src/utils/content-hash";
import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";

// ============================================================================
// Configuration
// ============================================================================

const DORAR_API_BASE = process.env.DORAR_API_URL || "http://localhost:5050/v1";
const DORAR_DIRECT_API = "https://dorar.net/dorar_api.json"; // Direct API endpoint (no page limit)
const DELAY_BETWEEN_REQUESTS = 200; // 0.2s between API calls
const CACHE_DIR = process.env.DORAR_CACHE_DIR || path.join(import.meta.dir, "dorar-cache");
const RESULTS_PER_PAGE = 30; // Dorar site search returns 30 per page
const API_RESULTS_PER_PAGE = 15; // Direct API returns 15 per page

// Broad search terms to enumerate all hadiths in a book.
// Must use specialist=true to get the specialist tab which has full coverage.
// Multiple terms are searched sequentially to maximize unique hadith coverage.
const BROAD_SEARCH_TERMS = [
  "الله",   // "Allah" — broadest term
  "قال",    // "said" — very common in hadith text
  "رسول",   // "Messenger" — common
  "النبي",  // "the Prophet"
  "الصلاة", // "prayer"
  "كان",    // "was/used to"
  "صلى",    // "prayed" / "peace be upon"
  "يوم",    // "day"
  "أمر",    // "commanded"
  "نهى",    // "prohibited"
];

// Target collections with Dorar book IDs
const TARGET_COLLECTIONS: CollectionDef[] = [
  // High priority
  { slug: "ibn-hibban", nameEnglish: "Sahih Ibn Hibban", nameArabic: "صحيح ابن حبان", dorarBookId: 16582, estHadiths: 7500 },
  { slug: "mustadrak", nameEnglish: "Al-Mustadrak", nameArabic: "المستدرك على الصحيحين", dorarBookId: 16226, estHadiths: 8800 },
  { slug: "daraqutni", nameEnglish: "Sunan al-Daraqutni", nameArabic: "سنن الدارقطني", dorarBookId: 13501, estHadiths: 4580 },
  { slug: "ibn-khuzaymah", nameEnglish: "Sahih Ibn Khuzaymah", nameArabic: "صحيح ابن خزيمة", dorarBookId: 13558, estHadiths: 3080 },

  // Medium priority
  { slug: "mu-jam-awsat", nameEnglish: "Al-Mu'jam al-Awsat", nameArabic: "المعجم الأوسط", dorarBookId: 16584, estHadiths: 9990 },
  { slug: "sunan-kubra-bayhaqi", nameEnglish: "Al-Sunan al-Kubra (Bayhaqi)", nameArabic: "السنن الكبرى للبيهقي", dorarBookId: 13470, estHadiths: 21800 },
  { slug: "shuab-al-iman", nameEnglish: "Shu'ab al-Iman", nameArabic: "شعب الإيمان", dorarBookId: 13433, estHadiths: 10000 },

  // Tier 2 — High priority
  { slug: "sunan-kubra-nasai", nameEnglish: "Al-Sunan al-Kubra (Nasa'i)", nameArabic: "السنن الكبرى للنسائي", dorarBookId: 13469, estHadiths: 12000 },
  { slug: "majma-zawaid", nameEnglish: "Majma' al-Zawa'id", nameArabic: "مجمع الزوائد", dorarBookId: 13380, estHadiths: 18000 },
  { slug: "targhib-tarhib", nameEnglish: "Al-Targhib wa al-Tarhib", nameArabic: "الترغيب والترهيب", dorarBookId: 13430, estHadiths: 5000 },

  // Tier 2 — Medium priority
  { slug: "hilyat-awliya", nameEnglish: "Hilyat al-Awliya'", nameArabic: "حلية الأولياء", dorarBookId: 13432, estHadiths: 10000 },
  { slug: "sharh-maani-athar", nameEnglish: "Sharh Ma'ani al-Athar", nameArabic: "شرح معاني الآثار", dorarBookId: 1022, estHadiths: 7000 },
  { slug: "sharh-mushkil-athar", nameEnglish: "Sharh Mushkil al-Athar", nameArabic: "شرح مشكل الآثار", dorarBookId: 1153, estHadiths: 6000 },
  { slug: "matalib-aliya", nameEnglish: "Al-Matalib al-'Aliya", nameArabic: "المطالب العالية", dorarBookId: 6365, estHadiths: 4500 },
  { slug: "silsilah-sahihah", nameEnglish: "Al-Silsilah al-Sahihah", nameArabic: "السلسلة الصحيحة", dorarBookId: 561, estHadiths: 3500 },

  // Tier 2 — Low priority (large collections)
  // NOTE: Book IDs below need verification via --discover. Use the wrapper to find correct IDs.
  { slug: "musannaf-ibn-abi-shaybah", nameEnglish: "Musannaf Ibn Abi Shaybah", nameArabic: "مصنف ابن أبي شيبة", dorarBookId: 13500, estHadiths: 37900 },
  { slug: "musannaf-abdurrazzaq", nameEnglish: "Musannaf 'Abd al-Razzaq", nameArabic: "مصنف عبد الرزاق", dorarBookId: 13502, estHadiths: 21000 },
  { slug: "mujam-kabir", nameEnglish: "Al-Mu'jam al-Kabir", nameArabic: "المعجم الكبير", dorarBookId: 13503, estHadiths: 25000 },
];

// ============================================================================
// Types
// ============================================================================

interface CollectionDef {
  slug: string;
  nameEnglish: string;
  nameArabic: string;
  dorarBookId: number;
  estHadiths: number;
}

interface DorarHadith {
  hadith: string;
  rawi: string;
  mohdith: string;
  mohdithId?: string;
  book: string;
  bookId?: string;
  numberOrPage: string;
  grade: string;
  explainGrade?: string;
  takhrij?: string;
  hadithId: string;
  categories?: Array<{ id: number; name: string }>;
  hasSimilarHadith?: boolean;
  hasAlternateHadithSahih?: boolean;
  hasUsulHadith?: boolean;
  hasSharhMetadata?: boolean;
  sharhMetadata?: { id: string; urlToGetSharh: string };
}

interface DorarSearchResponse {
  status: number;
  data: DorarHadith[];
  metadata: {
    length: number;
    total: number;
    page: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPrevPage: boolean;
  };
}

interface DorarUsulResponse {
  status: number;
  data: {
    usulHadith?: {
      sources: Array<{ source: string; chain: string; hadithText: string }>;
      count: number;
    };
  };
}

interface DorarSharhResponse {
  status: number;
  data: {
    sharh?: string;
  };
}

interface CachedHadith extends DorarHadith {
  usulData?: Array<{ source: string; chain: string; hadithText: string }>;
  sharhText?: string;
}

/** Hadith from dorar_api.json (fewer fields, no hadithId) */
interface ApiModeHadith {
  hadith: string;
  rawi: string;
  mohdith: string;
  book: string;
  numberOrPage: string;
  grade: string;
}

/** Cached API-mode hadith (may have enriched fields from site-mode cache) */
interface CachedApiHadith extends ApiModeHadith {
  hadithId?: string;
  categories?: Array<{ id: number; name: string }>;
  takhrij?: string;
  explainGrade?: string;
  enrichedFromSiteCache?: boolean;
}

// ============================================================================
// Utilities
// ============================================================================

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJSON<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText} for ${url}`);
  }
  return response.json() as Promise<T>;
}

function ensureCacheDir(slug: string): string {
  const dir = path.join(CACHE_DIR, slug);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getCachePath(slug: string, hadithId: string): string {
  return path.join(CACHE_DIR, slug, `${hadithId}.json`);
}

function isCached(slug: string, hadithId: string): boolean {
  return fs.existsSync(getCachePath(slug, hadithId));
}

function readCached(slug: string, hadithId: string): CachedHadith | null {
  const cachePath = getCachePath(slug, hadithId);
  if (!fs.existsSync(cachePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(cachePath, "utf-8"));
  } catch {
    return null;
  }
}

function writeCached(slug: string, hadithId: string, data: CachedHadith): void {
  const cachePath = getCachePath(slug, hadithId);
  fs.writeFileSync(cachePath, JSON.stringify(data, null, 2), "utf-8");
}

function getApiCachePath(slug: string, numberOrPage: string): string {
  // Sanitize numberOrPage for filename (replace / with _)
  const safe = numberOrPage.replace(/\//g, "_").replace(/\s/g, "_");
  return path.join(CACHE_DIR, slug, `api_${safe}.json`);
}

function isApiCached(slug: string, numberOrPage: string): boolean {
  return fs.existsSync(getApiCachePath(slug, numberOrPage));
}

function writeApiCached(slug: string, numberOrPage: string, data: CachedApiHadith): void {
  const cachePath = getApiCachePath(slug, numberOrPage);
  fs.writeFileSync(cachePath, JSON.stringify(data, null, 2), "utf-8");
}

function readApiCached(slug: string, numberOrPage: string): CachedApiHadith | null {
  const cachePath = getApiCachePath(slug, numberOrPage);
  if (!fs.existsSync(cachePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(cachePath, "utf-8"));
  } catch {
    return null;
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// ============================================================================
// Discovery Mode
// ============================================================================

async function discoverBooks(): Promise<void> {
  console.log("Discovering book IDs from dorar-hadith-api data endpoint...\n");

  try {
    const response = await fetchJSON<{ status: number; data: Array<{ key: string; value: string }> }>(
      `${DORAR_API_BASE}/data/book`
    );

    const books = response.data;
    console.log(`Found ${books.length} books in Dorar registry:\n`);

    // Show target collections with their IDs
    console.log("=== TARGET COLLECTIONS ===\n");
    for (const col of TARGET_COLLECTIONS) {
      const match = books.find((b) => b.key === String(col.dorarBookId));
      console.log(`  [${match ? "FOUND" : "MISSING"}] ${col.slug} (ID: ${col.dorarBookId}) — ${col.nameArabic}`);
    }

    console.log("\n=== ALL BOOKS (sorted by name) ===\n");
    const sorted = [...books].sort((a, b) => a.value.localeCompare(b.value, "ar"));
    for (const book of sorted) {
      if (book.key === "0") continue; // Skip "All" option
      console.log(`  ID: ${book.key.padStart(6)} | ${book.value}`);
    }
  } catch (error) {
    console.error("Failed to fetch book data. Is the dorar-hadith-api wrapper running on port 5000?");
    console.error("Start it with: cd tools/dorar-hadith-api && node server.js");
    console.error(error);
  }
}

// ============================================================================
// Search & Download
// ============================================================================

async function searchWithTerm(
  collection: CollectionDef,
  searchTerm: string,
  startPage: number,
  fetchDetails: boolean,
): Promise<{ fetched: number; newCached: number }> {
  let totalFetched = 0;
  let totalNew = 0;
  let page = startPage;
  let hasMore = true;

  while (hasMore) {
    // Use specialist=true to access the specialist tab with full scholar coverage
    const url = `${DORAR_API_BASE}/site/hadith/search?value=${encodeURIComponent(searchTerm)}&s[]=${collection.dorarBookId}&page=${page}&specialist=true`;

    try {
      process.stdout.write(`    Page ${page}: fetching...`);
      const response = await fetchJSON<DorarSearchResponse>(url);

      if (!response.data || response.data.length === 0) {
        console.log(` no results, stopping.`);
        break;
      }

      const { data, metadata } = response;
      totalFetched += data.length;

      let newOnPage = 0;
      for (const hadith of data) {
        if (!hadith.hadithId) continue;
        if (isCached(collection.slug, hadith.hadithId)) continue;

        const cached: CachedHadith = { ...hadith };

        // Optionally fetch detail endpoints
        if (fetchDetails) {
          if (hadith.hasUsulHadith) {
            try {
              await delay(DELAY_BETWEEN_REQUESTS);
              const usulResp = await fetchJSON<DorarUsulResponse>(
                `${DORAR_API_BASE}/site/hadith/usul/${hadith.hadithId}`
              );
              if (usulResp.data?.usulHadith?.sources) {
                cached.usulData = usulResp.data.usulHadith.sources;
              }
            } catch (err) {
              console.warn(`\n    Failed to fetch usul for ${hadith.hadithId}`);
            }
          }

          if (hadith.hasSharhMetadata && hadith.sharhMetadata?.id) {
            try {
              await delay(DELAY_BETWEEN_REQUESTS);
              const sharhResp = await fetchJSON<DorarSharhResponse>(
                `${DORAR_API_BASE}/site/sharh/${hadith.sharhMetadata.id}`
              );
              if (sharhResp.data?.sharh) {
                cached.sharhText = sharhResp.data.sharh;
              }
            } catch (err) {
              console.warn(`\n    Failed to fetch sharh for ${hadith.hadithId}`);
            }
          }
        }

        writeCached(collection.slug, hadith.hadithId, cached);
        newOnPage++;
        totalNew++;
      }

      console.log(` ${data.length} results, ${newOnPage} new. Total: ${totalFetched}/${metadata.total || "?"}`);

      hasMore = metadata.hasNextPage;
      page++;

      if (hasMore) {
        await delay(DELAY_BETWEEN_REQUESTS);
      }
    } catch (error) {
      console.log(` error, retrying...`);
      await delay(5000);
      try {
        const retryUrl = `${DORAR_API_BASE}/site/hadith/search?value=${encodeURIComponent(searchTerm)}&s[]=${collection.dorarBookId}&page=${page}&specialist=true`;
        const retryResp = await fetchJSON<DorarSearchResponse>(retryUrl);
        if (!retryResp.data || retryResp.data.length === 0) break;
        for (const hadith of retryResp.data) {
          if (!hadith.hadithId || isCached(collection.slug, hadith.hadithId)) continue;
          writeCached(collection.slug, hadith.hadithId, { ...hadith });
          totalNew++;
        }
        totalFetched += retryResp.data.length;
        hasMore = retryResp.metadata.hasNextPage;
        page++;
        if (hasMore) await delay(DELAY_BETWEEN_REQUESTS);
      } catch {
        console.error(`    Retry failed for page ${page}, moving to next term.`);
        break;
      }
    }
  }

  return { fetched: totalFetched, newCached: totalNew };
}

async function searchCollection(
  collection: CollectionDef,
  startPage: number,
  fetchDetails: boolean,
): Promise<number> {
  const cacheDir = ensureCacheDir(collection.slug);
  let grandTotalNew = 0;

  console.log(`\nSearching Dorar for: ${collection.nameArabic} (book ID: ${collection.dorarBookId})`);
  console.log(`Cache directory: ${cacheDir}`);
  console.log(`Using ${BROAD_SEARCH_TERMS.length} search terms with specialist mode\n`);

  for (const term of BROAD_SEARCH_TERMS) {
    // Count cached files before this term
    const cachedBefore = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).filter((f) => f.endsWith(".json")).length : 0;

    console.log(`  Search term: "${term}" (${cachedBefore} cached so far)`);
    const { fetched, newCached } = await searchWithTerm(collection, term, startPage, fetchDetails);
    grandTotalNew += newCached;

    console.log(`    → ${fetched} fetched, ${newCached} new\n`);

    // If a term yields very few new results, remaining terms likely overlap
    if (fetched > 100 && newCached < 5) {
      console.log(`  Diminishing returns, skipping remaining terms.`);
      break;
    }

    await delay(DELAY_BETWEEN_REQUESTS);
  }

  const totalCached = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).filter((f) => f.endsWith(".json")).length : 0;
  console.log(`\nDownload complete for ${collection.nameArabic}: ${totalCached} total cached, ${grandTotalNew} new this session`);
  return grandTotalNew;
}

// ============================================================================
// API Mode — Direct dorar_api.json (unlimited pagination)
// ============================================================================

/**
 * Parse HTML from dorar_api.json response into structured hadith data.
 * The API returns HTML blocks like:
 *   <div class="hadith">1 - HADITH TEXT...</div>
 *   <div class="hadith-info">
 *     <span class="info-subtitle">الراوي:</span> NARRATOR
 *     ...
 *   </div>
 */
function parseApiHtml(html: string): ApiModeHadith[] {
  const $ = cheerio.load(html);
  const results: ApiModeHadith[] = [];

  // Each hadith has a .hadith div followed by a .hadith-info div
  const infoBlocks = $(".hadith-info");

  infoBlocks.each((_, infoEl) => {
    const $info = $(infoEl);

    // Get the hadith text from the preceding .hadith sibling
    const $hadithDiv = $info.prev(".hadith");
    let hadithText = "";
    if ($hadithDiv.length) {
      hadithText = $hadithDiv.text().trim();
      // Strip leading number prefix like "1 - " or "123 - "
      hadithText = hadithText.replace(/^\d+\s*-\s*/, "");
    }

    // Extract metadata from info-subtitle spans
    const fields: Record<string, string> = {};
    $info.find(".info-subtitle").each((_, subtitleEl) => {
      const $sub = $(subtitleEl);
      const label = $sub.text().trim().replace(/:$/, "");
      // Get text content after this subtitle span until the next one
      let value = "";
      let node = subtitleEl.nextSibling;
      while (node) {
        if (node.type === "tag" && $(node).hasClass("info-subtitle")) break;
        if (node.type === "text") {
          value += $(node).text();
        } else if (node.type === "tag") {
          value += $(node).text();
        }
        node = node.nextSibling;
      }
      fields[label] = value.trim();
    });

    if (!hadithText) return;

    results.push({
      hadith: hadithText,
      rawi: fields["الراوي"] || "",
      mohdith: fields["المحدث"] || "",
      book: fields["المصدر"] || "",
      numberOrPage: fields["الصفحة أو الرقم"] || "",
      grade: fields["خلاصة حكم المحدث"] || "",
    });
  });

  return results;
}

/**
 * Fetch a single paginated pass from dorar_api.json with the given search key.
 * Returns the number of new hadiths cached.
 */
async function fetchApiPass(
  collection: CollectionDef,
  cacheDir: string,
  skey: string,
  passLabel: string,
  startPage: number,
): Promise<{ fetched: number; newCached: number }> {
  let totalFetched = 0;
  let totalNew = 0;
  let page = startPage;
  let consecutiveEmpty = 0;

  while (true) {
    const url = `${DORAR_DIRECT_API}?skey=${encodeURIComponent(skey)}&s[]=${collection.dorarBookId}&page=${page}`;

    try {
      process.stdout.write(`    [${passLabel}] p${page}: `);

      const response = await fetch(url, {
        signal: AbortSignal.timeout(30000),
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; OpenIslamicDB/1.0)",
          "Accept": "application/json",
          "Referer": "https://dorar.net/",
        },
      });

      if (!response.ok) {
        await delay(3000);
        page++;
        consecutiveEmpty++;
        if (consecutiveEmpty >= 3) break;
        continue;
      }

      const json = await response.json() as { ahadith?: { result?: string } };

      if (!json.ahadith?.result) {
        console.log(`empty response`);
        consecutiveEmpty++;
        if (consecutiveEmpty >= 3) break;
        page++;
        await delay(DELAY_BETWEEN_REQUESTS);
        continue;
      }

      const hadiths = parseApiHtml(json.ahadith.result);

      if (hadiths.length === 0) {
        console.log(`0 hadiths`);
        consecutiveEmpty++;
        if (consecutiveEmpty >= 3) break;
        page++;
        await delay(DELAY_BETWEEN_REQUESTS);
        continue;
      }

      consecutiveEmpty = 0;
      totalFetched += hadiths.length;

      let newOnPage = 0;
      for (let idx = 0; idx < hadiths.length; idx++) {
        const h = hadiths[idx];
        const key = skey ? `s${passLabel}_p${page}_${idx}` : `p${page}_${idx}`;
        if (!isApiCached(collection.slug, key)) {
          writeApiCached(collection.slug, key, h);
          newOnPage++;
          totalNew++;
        }
      }

      console.log(`${hadiths.length} results, ${newOnPage} new (total: ${totalFetched})`);

      page++;
      await delay(DELAY_BETWEEN_REQUESTS);
    } catch (error) {
      console.log(`error: ${error instanceof Error ? error.message : error}`);
      consecutiveEmpty++;
      if (consecutiveEmpty >= 3) break;
      page++;
      await delay(3000);
    }
  }

  return { fetched: totalFetched, newCached: totalNew };
}

/**
 * Fetch all hadiths for a collection via direct dorar_api.json endpoint.
 *
 * Strategy:
 * 1. Empty skey pass: returns book-ordered hadiths (unlimited pages for well-indexed books)
 * 2. Search term passes: each broad term returns matching hadiths (up to ~35 pages each)
 *    Combined with dedup, this achieves near-100% coverage.
 */
async function fetchAllViaApi(
  collection: CollectionDef,
  startPage: number,
): Promise<{ totalFetched: number; totalNew: number }> {
  const cacheDir = ensureCacheDir(collection.slug);
  let grandTotalFetched = 0;
  let grandTotalNew = 0;

  const existingFiles = fs.existsSync(cacheDir)
    ? fs.readdirSync(cacheDir).filter((f) => f.startsWith("api_") && f.endsWith(".json")).length
    : 0;

  console.log(`\nAPI-mode download for: ${collection.nameArabic} (book ID: ${collection.dorarBookId})`);
  console.log(`Cache directory: ${cacheDir} (${existingFiles} already cached)`);

  // Pass 1: Empty skey (returns all hadiths for well-indexed books)
  console.log(`\n  Pass 1: empty skey (book-ordered)`);
  const pass1 = await fetchApiPass(collection, cacheDir, "", "empty", startPage);
  grandTotalFetched += pass1.fetched;
  grandTotalNew += pass1.newCached;
  console.log(`  → ${pass1.fetched} fetched, ${pass1.newCached} new`);

  // Pass 2+: Search terms (each adds unique hadiths the empty pass missed)
  for (let i = 0; i < BROAD_SEARCH_TERMS.length; i++) {
    const term = BROAD_SEARCH_TERMS[i];
    console.log(`\n  Pass ${i + 2}: skey="${term}"`);
    const pass = await fetchApiPass(collection, cacheDir, term, String(i), 1);
    grandTotalFetched += pass.fetched;
    grandTotalNew += pass.newCached;
    console.log(`  → ${pass.fetched} fetched, ${pass.newCached} new`);

    // If this term yielded very few new results, skip remaining terms
    if (pass.fetched > 100 && pass.newCached < 5) {
      console.log(`  Diminishing returns, stopping search passes.`);
      break;
    }
  }

  const totalCached = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).filter((f) => f.startsWith("api_") && f.endsWith(".json")).length : 0;
  console.log(`\nAPI-mode download complete for ${collection.nameArabic}: ${totalCached} API-cached (${grandTotalNew} new this session)`);
  return { totalFetched: grandTotalFetched, totalNew: grandTotalNew };
}

/**
 * Enrich API-cached hadiths with data from site-mode cache.
 * Matches by numberOrPage to find corresponding site-mode cache entries
 * that have hadithId, categories, takhrij, etc.
 */
function enrichFromSiteCache(collection: CollectionDef): { enriched: number; total: number } {
  const cacheDir = path.join(CACHE_DIR, collection.slug);
  if (!fs.existsSync(cacheDir)) return { enriched: 0, total: 0 };

  // Load all site-mode cached hadiths (files without "api_" prefix, excluding macOS resource forks)
  const siteFiles = fs.readdirSync(cacheDir).filter((f) => f.endsWith(".json") && !f.startsWith("api_") && !f.startsWith("."));
  const siteByNumberOrPage = new Map<string, CachedHadith>();

  for (const f of siteFiles) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(cacheDir, f), "utf-8")) as CachedHadith;
      if (data.numberOrPage) {
        siteByNumberOrPage.set(data.numberOrPage, data);
      }
    } catch {
      // skip corrupt files
    }
  }

  if (siteByNumberOrPage.size === 0) {
    console.log(`  No site-mode cache to enrich from.`);
    return { enriched: 0, total: 0 };
  }

  // Now enrich API-mode cache files
  const apiFiles = fs.readdirSync(cacheDir).filter((f) => f.startsWith("api_") && f.endsWith(".json"));
  let enriched = 0;

  for (const f of apiFiles) {
    try {
      const filePath = path.join(cacheDir, f);
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as CachedApiHadith;
      const needsTextFix = data.hadith && data.hadith.includes("...");
      if (data.enrichedFromSiteCache && !needsTextFix) continue; // Already fully enriched

      const siteMatch = data.numberOrPage ? siteByNumberOrPage.get(data.numberOrPage) : null;
      if (siteMatch) {
        let changed = false;
        // Copy full text if API text was truncated
        if (siteMatch.hadith && needsTextFix) {
          data.hadith = siteMatch.hadith;
          changed = true;
        }
        if (!data.hadithId && siteMatch.hadithId) { data.hadithId = siteMatch.hadithId; changed = true; }
        if (!data.categories && siteMatch.categories) { data.categories = siteMatch.categories; changed = true; }
        if (!data.takhrij && siteMatch.takhrij) { data.takhrij = siteMatch.takhrij; changed = true; }
        if (!data.explainGrade && siteMatch.explainGrade) { data.explainGrade = siteMatch.explainGrade; changed = true; }
        if (changed || !data.enrichedFromSiteCache) {
          data.enrichedFromSiteCache = true;
          fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
          enriched++;
        }
      }
    } catch {
      // skip corrupt files
    }
  }

  console.log(`  Enriched ${enriched}/${apiFiles.length} API-cached hadiths from ${siteByNumberOrPage.size} site-mode entries.`);
  return { enriched, total: apiFiles.length };
}

// ============================================================================
// Database Import
// ============================================================================

async function importCollection(collection: CollectionDef, dryRun: boolean, apiMode: boolean = false): Promise<void> {
  const cacheDir = path.join(CACHE_DIR, collection.slug);
  if (!fs.existsSync(cacheDir)) {
    console.log(`No cache directory for ${collection.slug}, skipping import.`);
    return;
  }

  // In API mode, import api_*.json files; in site mode, import non-api files
  // Filter out macOS resource fork files (._*) and .DS_Store
  const allFiles = fs.readdirSync(cacheDir).filter((f) => f.endsWith(".json") && !f.startsWith("."));
  const files = apiMode
    ? allFiles.filter((f) => f.startsWith("api_"))
    : allFiles.filter((f) => !f.startsWith("api_"));

  console.log(`\nImporting ${files.length} ${apiMode ? "API-mode" : "site-mode"} cached hadiths for ${collection.nameArabic}...`);

  if (files.length === 0) {
    console.log("  No cached files found.");
    return;
  }

  if (dryRun) {
    console.log("  [DRY RUN] Would import the following:");
    const sample = files.slice(0, 5);
    for (const f of sample) {
      const data = JSON.parse(fs.readFileSync(path.join(cacheDir, f), "utf-8"));
      const text = stripHtml(data.hadith).substring(0, 80);
      console.log(`    ${data.hadithId || data.numberOrPage || f}: ${data.rawi} — ${text}...`);
      console.log(`      Grade: ${data.grade} (by ${data.mohdith})`);
    }
    if (files.length > 5) {
      console.log(`    ... and ${files.length - 5} more`);
    }
    return;
  }

  // 1. Ensure HadithCollection exists
  const dbCollection = await prisma.hadithCollection.upsert({
    where: { slug: collection.slug },
    update: { nameEnglish: collection.nameEnglish, nameArabic: collection.nameArabic },
    create: { slug: collection.slug, nameEnglish: collection.nameEnglish, nameArabic: collection.nameArabic },
  });
  console.log(`  Collection: ${dbCollection.slug} (ID: ${dbCollection.id})`);

  // 2. Ensure a single HadithBook exists for this collection
  //    Dorar data doesn't have internal book structure, so we use book 1
  const dbBook = await prisma.hadithBook.upsert({
    where: { collectionId_bookNumber: { collectionId: dbCollection.id, bookNumber: 1 } },
    update: { nameEnglish: collection.nameEnglish, nameArabic: collection.nameArabic },
    create: {
      collectionId: dbCollection.id,
      bookNumber: 1,
      nameEnglish: collection.nameEnglish,
      nameArabic: collection.nameArabic,
    },
  });
  console.log(`  Book: #${dbBook.bookNumber} (ID: ${dbBook.id})`);

  // 3. Get the max existing hadith number for sequential numbering
  const maxExisting = await prisma.hadith.findFirst({
    where: { bookId: dbBook.id },
    orderBy: { hadithNumber: "desc" },
    select: { hadithNumber: true },
  });
  let nextHadithNum = maxExisting ? parseInt(maxExisting.hadithNumber, 10) + 1 : 1;
  if (isNaN(nextHadithNum)) nextHadithNum = 1;

  // 4. Build existing dedup index (numberOrPage → hadith id) for this book
  const existingByNumberOrPage = new Map<string, number>();
  const existingByContentHash = new Set<string>();

  if (apiMode) {
    const existingHadiths = await prisma.hadith.findMany({
      where: { bookId: dbBook.id },
      select: { id: true, numberOrPage: true, contentHash: true },
    });
    for (const h of existingHadiths) {
      if (h.numberOrPage) existingByNumberOrPage.set(h.numberOrPage, h.id);
      if (h.contentHash) existingByContentHash.add(h.contentHash);
    }
    console.log(`  Existing dedup index: ${existingByNumberOrPage.size} by numberOrPage, ${existingByContentHash.size} by hash`);
  }

  // 5. Import hadiths in batches
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  // Sort files for deterministic ordering
  const sortedFiles = files.sort();

  const BATCH_SIZE = 100;
  for (let i = 0; i < sortedFiles.length; i += BATCH_SIZE) {
    const batch = sortedFiles.slice(i, i + BATCH_SIZE);

    for (const file of batch) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(cacheDir, file), "utf-8"));

        if (!data.hadith) {
          skipped++;
          continue;
        }

        const textArabic = stripHtml(data.hadith);
        if (!textArabic || textArabic.length < 5) {
          skipped++;
          continue;
        }

        const textPlain = normalizeArabicText(textArabic);
        const dorarId: string | null = data.hadithId || null;
        const numberOrPage: string | null = data.numberOrPage || null;

        if (apiMode) {
          // API-mode dedup: by numberOrPage within this book, then by content hash
          const contentHash = hashHadith(collection.slug, numberOrPage || file, textArabic);

          // Check if already exists by numberOrPage
          const existingId = numberOrPage ? existingByNumberOrPage.get(numberOrPage) : undefined;
          // Check by content hash as fallback
          const hashExists = existingByContentHash.has(contentHash);

          if (existingId) {
            // Skip if this was just added in this import run (placeholder id)
            if (existingId < 0) {
              skipped++;
            } else {
              // Update existing record with any enriched fields
              await prisma.hadith.update({
                where: { id: existingId },
                data: {
                  textArabic,
                  textPlain,
                  contentHash,
                  ...(dorarId ? { dorarId } : {}),
                  narratorName: data.rawi || null,
                  grade: data.grade || null,
                  gradeExplanation: data.explainGrade || null,
                  graderName: data.mohdith || null,
                  sourceBookName: data.book || null,
                  sourceBookDorarId: collection.dorarBookId,
                  numberOrPage,
                  ...(data.takhrij ? { takhrij: data.takhrij } : {}),
                  ...(data.categories?.length ? { categories: data.categories } : {}),
                },
              });
              updated++;
            }
          } else if (hashExists) {
            // Duplicate by content — skip
            skipped++;
          } else {
            // New hadith
            await prisma.hadith.create({
              data: {
                bookId: dbBook.id,
                hadithNumber: String(nextHadithNum),
                textArabic,
                textPlain,
                contentHash,
                ...(dorarId ? { dorarId } : {}),
                narratorName: data.rawi || null,
                grade: data.grade || null,
                gradeExplanation: data.explainGrade || null,
                graderName: data.mohdith || null,
                sourceBookName: data.book || null,
                sourceBookDorarId: collection.dorarBookId,
                numberOrPage,
                ...(data.takhrij ? { takhrij: data.takhrij } : {}),
                ...(data.categories?.length ? { categories: data.categories } : {}),
              },
            });
            nextHadithNum++;
            imported++;
            // Update dedup index
            if (numberOrPage) existingByNumberOrPage.set(numberOrPage, -1); // placeholder id
            existingByContentHash.add(contentHash);
          }
        } else {
          // Site-mode: dedup by dorarId (original logic)
          if (!dorarId) {
            skipped++;
            continue;
          }

          const existing = await prisma.hadith.findUnique({
            where: { dorarId },
            select: { id: true, bookId: true },
          });

          const hadithNumber = existing
            ? undefined
            : String(nextHadithNum);

          const contentHash = hashHadith(collection.slug, hadithNumber || dorarId, textArabic);

          const hadithData = {
            textArabic,
            textPlain,
            contentHash,
            dorarId,
            narratorName: data.rawi || null,
            grade: data.grade || null,
            gradeExplanation: data.explainGrade || null,
            graderName: data.mohdith || null,
            graderDorarId: data.mohdithId ? parseInt(data.mohdithId, 10) || null : null,
            sourceBookName: data.book || null,
            sourceBookDorarId: data.bookId ? parseInt(data.bookId, 10) || null : null,
            numberOrPage,
            takhrij: data.takhrij || null,
            categories: data.categories?.length ? data.categories : undefined,
            hasSimilar: data.hasSimilarHadith || false,
            hasAlternate: data.hasAlternateHadithSahih || false,
            hasUsul: data.hasUsulHadith || false,
            sharhText: data.sharhText || null,
            usulData: data.usulData?.length ? data.usulData : undefined,
          };

          if (existing) {
            await prisma.hadith.update({
              where: { dorarId },
              data: hadithData,
            });
            updated++;
          } else {
            await prisma.hadith.create({
              data: {
                bookId: dbBook.id,
                hadithNumber: String(nextHadithNum),
                ...hadithData,
              },
            });
            nextHadithNum++;
            imported++;
          }
        }
      } catch (error) {
        errors++;
        if (errors <= 5) {
          console.error(`  Error importing ${file}:`, error);
        }
      }
    }

    const progress = Math.min(i + BATCH_SIZE, sortedFiles.length);
    process.stdout.write(`\r  Progress: ${progress}/${sortedFiles.length} (${imported} new, ${updated} updated, ${skipped} skipped, ${errors} errors)`);
  }

  console.log(`\n  Import complete: ${imported} new, ${updated} updated, ${skipped} skipped, ${errors} errors`);
}

// ============================================================================
// CLI
// ============================================================================

const args = process.argv.slice(2);
const discoverFlag = args.includes("--discover");
const allFlag = args.includes("--all");
const dryRunFlag = args.includes("--dry-run");
const fetchDetailsFlag = args.includes("--fetch-details");
const importOnlyFlag = args.includes("--import-only");
const apiModeFlag = args.includes("--api-mode");
const enrichFlag = args.includes("--enrich");
const fetchFullTextFlag = args.includes("--fetch-full-text");
const parallelFlag = args.includes("--parallel");
const concurrencyArg = args.find((arg) => arg.startsWith("--concurrency="))?.split("=")[1];
const concurrency = concurrencyArg ? parseInt(concurrencyArg, 10) : 4;
const collectionArg = args.find((arg) => arg.startsWith("--collection="))?.split("=")[1];
const pageArg = args.find((arg) => arg.startsWith("--page="))?.split("=")[1];
const startPage = pageArg ? parseInt(pageArg, 10) : 1;

async function main(): Promise<void> {
  console.log("=== Dorar.net Hadith Importer ===\n");

  // In API mode, no wrapper needed — calls dorar.net directly
  if (fetchFullTextFlag || (!apiModeFlag && !importOnlyFlag && !discoverFlag)) {
    // Check wrapper health for site-mode or fetch-full-text mode
    try {
      await fetchJSON(`${DORAR_API_BASE}/data/book`);
      console.log("dorar-hadith-api wrapper is running.\n");
    } catch {
      console.error("ERROR: dorar-hadith-api wrapper is not running.");
      console.error("Either start it with: cd tools/dorar-hadith-api && node server.js");
      console.error("Or use --api-mode to call dorar.net directly (recommended, no wrapper needed).");
      process.exit(1);
    }
  } else if (apiModeFlag) {
    console.log("API mode: calling dorar.net/dorar_api.json directly (no wrapper needed)\n");
  }

  if (discoverFlag) {
    await discoverBooks();
    return;
  }

  if (!collectionArg && !allFlag) {
    console.error("Usage:");
    console.error("  --discover                  List all Dorar book IDs");
    console.error("  --collection=SLUG           Import a specific collection");
    console.error("  --all                       Import all target collections");
    console.error("  --api-mode                  Use direct dorar_api.json (unlimited pages, no wrapper)");
    console.error("  --parallel                  Download collections in parallel (use with --all)");
    console.error("  --concurrency=N             Max parallel downloads (default: 4)");
    console.error("  --enrich                    Cross-reference site-mode cache for hadithId/categories/full text");
    console.error("  --fetch-full-text           Run wrapper site searches to get full text + hadithIds, then enrich");
    console.error("  --fetch-details             Also fetch usul + sharh per hadith (site-mode only)");
    console.error("  --page=N                    Start from page N");
    console.error("  --dry-run                   Print without importing to DB");
    console.error("  --import-only               Import from cache only (skip API)");
    console.error("\nAvailable collections:");
    for (const col of TARGET_COLLECTIONS) {
      console.error(`  ${col.slug.padEnd(30)} ${col.nameArabic} (est. ${col.estHadiths})`);
    }
    process.exit(1);
  }

  const collections = allFlag
    ? TARGET_COLLECTIONS
    : TARGET_COLLECTIONS.filter((c) => c.slug === collectionArg);

  if (collections.length === 0) {
    console.error(`Unknown collection: ${collectionArg}`);
    console.error("Available collections:");
    for (const col of TARGET_COLLECTIONS) {
      console.error(`  ${col.slug}`);
    }
    process.exit(1);
  }

  // Phase 1: Download from API (parallel or sequential)
  if (!importOnlyFlag && !fetchFullTextFlag) {
    if (parallelFlag && apiModeFlag && collections.length > 1) {
      console.log(`\nDownloading ${collections.length} collections in parallel (concurrency: ${concurrency})...\n`);

      // Process in batches of `concurrency`
      for (let i = 0; i < collections.length; i += concurrency) {
        const batch = collections.slice(i, i + concurrency);
        console.log(`\n--- Batch ${Math.floor(i / concurrency) + 1}: ${batch.map((c) => c.slug).join(", ")} ---\n`);
        await Promise.all(
          batch.map((collection) => fetchAllViaApi(collection, startPage))
        );
      }
    } else {
      for (const collection of collections) {
        console.log(`\n${"=".repeat(60)}`);
        console.log(`Downloading: ${collection.nameEnglish} (${collection.nameArabic})`);
        console.log(`${"=".repeat(60)}`);

        if (apiModeFlag) {
          await fetchAllViaApi(collection, startPage);
        } else {
          await searchCollection(collection, startPage, fetchDetailsFlag);
        }
      }
    }
  }

  // Phase 1.5: Fetch full text via wrapper site search (builds site-mode cache)
  if (fetchFullTextFlag) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Fetching full text via site search (wrapper on ${DORAR_API_BASE})`);
    console.log(`${"=".repeat(60)}\n`);

    for (const collection of collections) {
      console.log(`\n--- ${collection.nameEnglish} (${collection.nameArabic}) ---`);
      await searchCollection(collection, startPage, fetchDetailsFlag);
    }
  }

  // Phase 2: Enrich + Import (always sequential for DB safety)
  for (const collection of collections) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Importing: ${collection.nameEnglish} (${collection.nameArabic})`);
    console.log(`${"=".repeat(60)}`);

    // Enrich API-cached hadiths with site-mode data (full text + hadithId)
    if (enrichFlag || fetchFullTextFlag || (apiModeFlag && !importOnlyFlag)) {
      enrichFromSiteCache(collection);
    }

    await importCollection(collection, dryRunFlag, apiModeFlag);
  }

  console.log("\n=== Done ===");
}

main()
  .catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  })
  .finally(() => {
    prisma.$disconnect();
  });
