/**
 * Remove failed book indices from batch-progress.json so they get retried on --resume.
 */
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const PROGRESS_PATH = resolve(import.meta.dir, "batch-progress.json");
const CATALOG_PATH = resolve(import.meta.dir, "turath-catalog.json");

const p = JSON.parse(readFileSync(PROGRESS_PATH, "utf-8"));
const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf-8"));

// Build bookId → catalog index map
const bookIdToIndex = new Map<number, number>();
catalog.books.forEach((b: { id: number }, i: number) => {
  bookIdToIndex.set(b.id, i);
});

// Find indices of failed books
const failedIndices = new Set(
  (p.failedIds as number[])
    .map((id) => bookIdToIndex.get(id))
    .filter((i): i is number => i !== undefined)
);

const before = p.processedIndices.length;
p.processedIndices = (p.processedIndices as number[]).filter((i) => !failedIndices.has(i));

console.log(`Before: ${before} processed, ${p.failedIds.length} failed`);
console.log(`Removed ${failedIndices.size} failed indices`);
console.log(`After: ${p.processedIndices.length} processed indices remain`);

p.failedIds = [];
p.failed = 0;
p.lastIndex = p.processedIndices.length > 0 ? Math.max(...p.processedIndices) : -1;

writeFileSync(PROGRESS_PATH, JSON.stringify(p, null, 2));
console.log("Progress file updated — failed books will be retried on --resume");
