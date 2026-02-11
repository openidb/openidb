/**
 * Scrape Turath/Shamela Book Catalog
 *
 * Scrapes all 40 Shamela category pages to collect book IDs that are shared
 * with Turath. Optionally verifies each ID exists on Turath's API.
 *
 * Usage:
 *   bun run pipelines/import/scrape-turath-catalog.ts              # Full scrape + verify
 *   bun run pipelines/import/scrape-turath-catalog.ts --skip-verify # Skip Turath API verification
 */

import { resolve } from "path";
import { writeFileSync, existsSync, readFileSync } from "fs";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(): { skipVerify: boolean } {
  const args = process.argv.slice(2);
  let skipVerify = false;

  for (const arg of args) {
    if (arg === "--skip-verify") {
      skipVerify = true;
    }
  }

  return { skipVerify };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CatalogBook {
  id: number;
  title: string;
  authorId: number | null;
  categoryId: number;
}

interface CatalogOutput {
  scrapedAt: string;
  totalBooks: number;
  books: CatalogBook[];
}

// ---------------------------------------------------------------------------
// Shamela scraper
// ---------------------------------------------------------------------------

const TOTAL_CATEGORIES = 40;
const SCRAPE_DELAY_MS = 1000;
const VERIFY_DELAY_MS = 200;
const VERIFY_BATCH_SIZE = 10;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scrapeCategoryPage(categoryId: number): Promise<Array<{ id: number; title: string }>> {
  const url = `https://shamela.ws/category/${categoryId}`;
  console.log(`  Fetching category ${categoryId}...`);

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; OpenIslamicDB/1.0; book-catalog)",
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    console.warn(`  Warning: Category ${categoryId} returned ${res.status}, skipping`);
    return [];
  }

  const html = await res.text();

  // Extract book links: https://shamela.ws/book/{id} with title from the link text
  // Pattern: <a href="https://shamela.ws/book/123" ...>Book Title</a>
  const books: Array<{ id: number; title: string }> = [];
  const linkRegex = /<a[^>]+href="(?:https?:\/\/shamela\.ws)?\/book\/(\d+)"[^>]*>([^<]+)<\/a>/g;
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const id = parseInt(match[1], 10);
    const title = match[2].trim();
    if (id && title) {
      books.push({ id, title });
    }
  }

  console.log(`  Category ${categoryId}: ${books.length} books found`);
  return books;
}

async function verifyTurathBook(id: number): Promise<{ exists: boolean; authorId: number | null }> {
  try {
    const res = await fetch(`https://api.turath.io/book?id=${id}`, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return { exists: false, authorId: null };
    }

    const data = await res.json() as { meta?: { author_id?: number } };
    return {
      exists: true,
      authorId: data.meta?.author_id ?? null,
    };
  } catch {
    return { exists: false, authorId: null };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { skipVerify } = parseArgs();

  console.log("Turath/Shamela Catalog Scraper");
  console.log("=".repeat(60));
  console.log(`Verification: ${skipVerify ? "SKIPPED" : "enabled (checking Turath API)"}`);
  console.log("=".repeat(60));
  console.log();

  // Phase 1: Scrape all category pages
  console.log("Phase 1: Scraping Shamela category pages...\n");

  const allBooks = new Map<number, { title: string; categoryId: number }>();

  for (let cat = 1; cat <= TOTAL_CATEGORIES; cat++) {
    try {
      const books = await scrapeCategoryPage(cat);
      for (const book of books) {
        if (!allBooks.has(book.id)) {
          allBooks.set(book.id, { title: book.title, categoryId: cat });
        }
      }
    } catch (error) {
      console.warn(`  Error scraping category ${cat}:`, (error as Error).message);
    }

    if (cat < TOTAL_CATEGORIES) {
      await sleep(SCRAPE_DELAY_MS);
    }
  }

  console.log(`\nTotal unique books found: ${allBooks.size}\n`);

  // Phase 2: Verify on Turath API (optional)
  let catalogBooks: CatalogBook[];

  if (skipVerify) {
    console.log("Phase 2: Skipping Turath verification\n");
    catalogBooks = Array.from(allBooks.entries()).map(([id, info]) => ({
      id,
      title: info.title,
      authorId: null,
      categoryId: info.categoryId,
    }));
  } else {
    console.log("Phase 2: Verifying books on Turath API...\n");

    catalogBooks = [];
    const ids = Array.from(allBooks.keys());
    let verified = 0;
    let missing = 0;

    for (let i = 0; i < ids.length; i += VERIFY_BATCH_SIZE) {
      const batch = ids.slice(i, i + VERIFY_BATCH_SIZE);

      const results = await Promise.all(
        batch.map(async (id) => {
          const result = await verifyTurathBook(id);
          return { id, ...result };
        })
      );

      for (const result of results) {
        if (result.exists) {
          const info = allBooks.get(result.id)!;
          catalogBooks.push({
            id: result.id,
            title: info.title,
            authorId: result.authorId,
            categoryId: info.categoryId,
          });
          verified++;
        } else {
          missing++;
        }
      }

      // Progress
      const total = ids.length;
      const processed = Math.min(i + VERIFY_BATCH_SIZE, total);
      const pct = Math.round((processed / total) * 100);
      process.stdout.write(`\r  Progress: ${processed}/${total} checked (${pct}%) — ${verified} verified, ${missing} missing`);

      if (i + VERIFY_BATCH_SIZE < ids.length) {
        await sleep(VERIFY_DELAY_MS);
      }
    }

    console.log(); // newline after progress
    console.log(`\n  Verified on Turath: ${verified}`);
    console.log(`  Not on Turath:      ${missing}`);
  }

  // Sort by ID for deterministic output
  catalogBooks.sort((a, b) => a.id - b.id);

  // Phase 3: Save catalog
  const output: CatalogOutput = {
    scrapedAt: new Date().toISOString(),
    totalBooks: catalogBooks.length,
    books: catalogBooks,
  };

  const outputPath = resolve(import.meta.dir, "turath-catalog.json");
  writeFileSync(outputPath, JSON.stringify(output, null, 2));

  console.log(`\nCatalog saved to: ${outputPath}`);
  console.log(`Total books: ${catalogBooks.length}`);
  console.log("=".repeat(60));
}

main().catch((e) => {
  console.error("\nScrape failed:");
  console.error(e);
  process.exit(1);
});
