/**
 * LLM-based Isnad/Matn Splitting
 *
 * Uses Claude Haiku 4.5 via OpenRouter to split ALL hadiths into isnad
 * (narrator chain) and matn (reported content).
 *
 * The parsers now store full text in matn with empty isnad. This script
 * queries all such hadiths, batches them, sends to the LLM to determine
 * the split point, and updates the DB.
 *
 * Usage:
 *   bun run pipelines/import/split-isnad-matn-llm.ts --dry-run                    # Show counts
 *   bun run pipelines/import/split-isnad-matn-llm.ts --export                      # Export batches
 *   bun run pipelines/import/split-isnad-matn-llm.ts --export --collection=bukhari  # Single collection
 *   bun run pipelines/import/split-isnad-matn-llm.ts --process                     # Run LLM on batches
 *   bun run pipelines/import/split-isnad-matn-llm.ts --apply                       # Apply results to DB
 *   bun run pipelines/import/split-isnad-matn-llm.ts --verify                      # Verify reconstructions
 *   bun run pipelines/import/split-isnad-matn-llm.ts --force                       # Export + process + apply
 *   bun run pipelines/import/split-isnad-matn-llm.ts --resplit --dry-run           # Show short-isnad counts
 *   bun run pipelines/import/split-isnad-matn-llm.ts --resplit --export --process --apply  # Full resplit
 */

import "../env";
import { prisma } from "../../src/db";
import * as fs from "fs";
import * as path from "path";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "anthropic/claude-haiku-4.5";
const TIMEOUT_MS = 120_000;

const BATCH_DIR = path.resolve(import.meta.dir, "isnad-matn-batches");
const BATCH_SIZE = 20;
const MAX_CONCURRENT = 20;

// ─── Types ───────────────────────────────────────────────────────────────────

interface HadithForSplit {
  id: number;
  hadithNumber: string;
  collectionSlug: string;
  textArabic: string;
  isChainVariation: boolean;
}

interface BatchItem {
  id: number;
  hadithNumber: string;
  collectionSlug: string;
  fullText: string;
}

interface SplitResult {
  id: number;
  splitWord: number;
}

// ─── Deterministic Pre-Filter ────────────────────────────────────────────────

const TRANSMISSION_VERBS_RE =
  /(?:حدثنا|أخبرنا|عن|سمعت|أنبأنا|حدثني|أخبرني|ثنا\b|أنا\b)/;

/**
 * Detects hadiths that are obviously matn-only (no isnad).
 * Returns true if the text clearly has no narrator chain,
 * allowing us to skip the LLM call and set splitWord: 0 directly.
 */
function detectObviousMatnOnly(text: string): boolean {
  // Strip footnote markers like (١) (٢) before analysis
  const cleaned = text.replace(/\([\u0660-\u0669\u0030-\u0039]+\)/g, "").trim();
  const words = cleaned.split(/\s+/);

  // Very short text with no transmission verbs
  if (words.length < 5 && !TRANSMISSION_VERBS_RE.test(cleaned)) {
    return true;
  }

  // No transmission verbs at all in the entire text
  if (!TRANSMISSION_VERBS_RE.test(cleaned)) {
    return true;
  }

  return false;
}

// ─── Step 1: Query Hadiths ──────────────────────────────────────────────────

async function queryHadiths(collectionSlug?: string): Promise<HadithForSplit[]> {
  const whereClause = collectionSlug
    ? `AND c.slug = '${collectionSlug}'`
    : "";

  const hadiths = await prisma.$queryRawUnsafe<HadithForSplit[]>(`
    SELECT h.id, h."hadith_number" as "hadithNumber",
           h."text_arabic" as "textArabic",
           h."is_chain_variation" as "isChainVariation",
           c.slug as "collectionSlug"
    FROM hadiths h
    JOIN hadith_books hb ON h."book_id" = hb.id
    JOIN hadith_collections c ON hb."collection_id" = c.id
    WHERE h."is_chain_variation" = false
    ${whereClause}
    ORDER BY c.slug, h.id
  `);

  return hadiths;
}

async function queryResplitHadiths(collectionSlug?: string): Promise<HadithForSplit[]> {
  const whereClause = collectionSlug
    ? `AND c.slug = '${collectionSlug}'`
    : "";

  const hadiths = await prisma.$queryRawUnsafe<HadithForSplit[]>(`
    SELECT h.id, h."hadith_number" as "hadithNumber",
           h."text_arabic" as "textArabic",
           h."is_chain_variation" as "isChainVariation",
           c.slug as "collectionSlug"
    FROM hadiths h
    JOIN hadith_books hb ON h."book_id" = hb.id
    JOIN hadith_collections c ON hb."collection_id" = c.id
    WHERE h."is_chain_variation" = false
      AND h.isnad IS NOT NULL AND h.isnad != ''
      AND array_length(string_to_array(h.isnad, ' '), 1) < 5
    ${whereClause}
    ORDER BY c.slug, h.id
  `);

  return hadiths;
}

// ─── Step 2: Export Batches ─────────────────────────────────────────────────

async function exportBatches(
  hadiths: HadithForSplit[],
  usePreFilter = false
): Promise<number> {
  fs.mkdirSync(BATCH_DIR, { recursive: true });

  // Group by collection for stats
  const byCollection = new Map<string, number>();
  for (const h of hadiths) {
    byCollection.set(
      h.collectionSlug,
      (byCollection.get(h.collectionSlug) || 0) + 1
    );
  }

  console.log("\nDistribution by collection:");
  for (const [slug, count] of [...byCollection.entries()].sort(
    (a, b) => b[1] - a[1]
  )) {
    console.log(`  ${slug}: ${count}`);
  }

  // Apply pre-filter: obvious matn-only texts get result files directly
  let preFiltered = 0;
  const needsLlm: HadithForSplit[] = [];

  if (usePreFilter) {
    const preFilterResults: SplitResult[] = [];
    for (const h of hadiths) {
      if (detectObviousMatnOnly(h.textArabic)) {
        preFilterResults.push({ id: h.id, splitWord: 0 });
        preFiltered++;
      } else {
        needsLlm.push(h);
      }
    }

    if (preFilterResults.length > 0) {
      // Write pre-filtered results directly as a result file
      const resultPath = path.join(BATCH_DIR, "batch-prefilter.result.json");
      fs.writeFileSync(resultPath, JSON.stringify(preFilterResults, null, 2));
      // Also write a batch file so apply can find the fullText
      const preFilterBatch: BatchItem[] = hadiths
        .filter((h) => preFilterResults.some((r) => r.id === h.id))
        .map((h) => ({
          id: h.id,
          hadithNumber: h.hadithNumber,
          collectionSlug: h.collectionSlug,
          fullText: h.textArabic,
        }));
      fs.writeFileSync(
        path.join(BATCH_DIR, "batch-prefilter.json"),
        JSON.stringify(preFilterBatch, null, 2)
      );
      console.log(
        `\nPre-filter: ${preFiltered} hadiths have no transmission verbs → splitWord: 0`
      );
    }
  } else {
    needsLlm.push(...hadiths);
  }

  // Build batch items for LLM processing
  const batchItems: BatchItem[] = needsLlm.map((h) => ({
    id: h.id,
    hadithNumber: h.hadithNumber,
    collectionSlug: h.collectionSlug,
    fullText: h.textArabic,
  }));

  // Write batches
  const totalBatches = Math.ceil(batchItems.length / BATCH_SIZE);
  for (let i = 0; i < totalBatches; i++) {
    const batch = batchItems.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
    const batchNum = String(i + 1).padStart(5, "0");
    const filePath = path.join(BATCH_DIR, `batch-${batchNum}.json`);
    fs.writeFileSync(filePath, JSON.stringify(batch, null, 2));
  }

  console.log(
    `\nExported ${batchItems.length} hadiths into ${totalBatches} batches for LLM`
  );
  if (preFiltered > 0) {
    console.log(`Pre-filtered: ${preFiltered} (total: ${hadiths.length})`);
  }
  return totalBatches;
}

// ─── Step 3: Process Batches with LLM ───────────────────────────────────────

const LLM_PROMPT = `You are an Arabic hadith scholar. For each hadith, determine where the isnad (narrator chain) ends and the matn (reported content) begins.

CRITICAL RULES:
1. An isnad is a chain of NARRATORS connected by transmission verbs (حدثنا، أخبرنا، عن، سمعت، أنبأنا، أخبرني، حدثني، قال، ثنا، نا). It contains PROPER NAMES of narrators.
2. If the text has NO narrator chain — no transmission verbs followed by narrator names — return splitWord: 0 (entire text is matn).
3. Words like لَوْلا، مَنْ، إذا، كان، إنّ، لا، ما، أَوتروا، تَعَلَّمُوا، صَلُّوا are NOT chain starters. They begin prophetic content (matn).
4. Footnote markers like (١) (٢) (٣) are NOT part of the chain. Ignore them.
5. Include "قال:" / "قالت:" / "يقول:" at END of isnad (these transition words belong to isnad).
6. Include "أنّ" / "أنّه" / "أنّها" at START of matn.
7. For multi-chain hadiths (with ح separator or multiple حدثنا chains), isnad includes ALL chains.
8. If the entire text is a chain variation with no matn, return splitWord: -1.

Return JSON: [{"id": N, "splitWord": W}]
- splitWord: 0-based word index where matn begins
- Words are split by whitespace

Return ONLY a JSON array, no other text.`;

async function processBatches(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("OPENROUTER_API_KEY not set in environment");
    process.exit(1);
  }

  const files = fs
    .readdirSync(BATCH_DIR)
    .filter((f) => f.match(/^batch-\d{5}\.json$/))
    .sort();

  if (files.length === 0) {
    console.error("No batch files found. Run --export first.");
    process.exit(1);
  }

  // Find unprocessed batches
  const unprocessed = files.filter((f) => {
    const resultFile = f.replace(".json", ".result.json");
    return !fs.existsSync(path.join(BATCH_DIR, resultFile));
  });

  console.log(
    `Found ${files.length} batches, ${unprocessed.length} unprocessed`
  );

  if (unprocessed.length === 0) {
    console.log("All batches already processed.");
    return;
  }

  // Process in waves of MAX_CONCURRENT
  let totalProcessed = 0;
  for (let i = 0; i < unprocessed.length; i += MAX_CONCURRENT) {
    const wave = unprocessed.slice(i, i + MAX_CONCURRENT);
    const waveNum = Math.floor(i / MAX_CONCURRENT) + 1;
    const totalWaves = Math.ceil(unprocessed.length / MAX_CONCURRENT);
    console.log(
      `\nWave ${waveNum}/${totalWaves} (${wave.length} batches, ${totalProcessed}/${unprocessed.length} done)`
    );

    const promises = wave.map((file) => processSingleBatch(apiKey, file));
    const results = await Promise.allSettled(promises);

    let succeeded = 0;
    let failed = 0;
    for (const r of results) {
      if (r.status === "fulfilled") succeeded++;
      else {
        failed++;
        console.error(`  Failed: ${r.reason}`);
      }
    }
    totalProcessed += succeeded;
    console.log(`  Wave done: ${succeeded} succeeded, ${failed} failed`);
  }
}

async function processSingleBatch(
  apiKey: string,
  file: string,
  maxRetries = 2
): Promise<void> {
  const filePath = path.join(BATCH_DIR, file);
  const batch: BatchItem[] = JSON.parse(fs.readFileSync(filePath, "utf-8"));

  // Build user message with each hadith
  const userContent = batch
    .map(
      (item, idx) =>
        `--- Hadith ${idx + 1} (id: ${item.id}, ${item.collectionSlug} #${item.hadithNumber}) ---
${item.fullText}
`
    )
    .join("\n");

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        const response = await fetch(OPENROUTER_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: MODEL,
            messages: [
              { role: "system", content: LLM_PROMPT },
              { role: "user", content: userContent },
            ],
            temperature: 0,
            max_tokens: 4096,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(
            `OpenRouter API error ${response.status}: ${errText}`
          );
        }

        const data = await response.json();
        const text: string = data.choices?.[0]?.message?.content || "";

        // Parse JSON from response (handle markdown code blocks)
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
          throw new Error(
            `${file}: No JSON array found in response: ${text.slice(0, 200)}`
          );
        }

        const results: SplitResult[] = JSON.parse(jsonMatch[0]);

        // Validate result count
        if (results.length !== batch.length) {
          console.warn(
            `  ${file}: Expected ${batch.length} results, got ${results.length}`
          );
        }

        // Validate all IDs match
        const batchIds = new Set(batch.map((b) => b.id));
        for (const r of results) {
          if (!batchIds.has(r.id)) {
            console.warn(`  ${file}: Unknown hadith ID ${r.id} in results`);
          }
        }

        // Write results
        const resultPath = path.join(
          BATCH_DIR,
          file.replace(".json", ".result.json")
        );
        fs.writeFileSync(resultPath, JSON.stringify(results, null, 2));
        console.log(`  ${file} -> ${results.length} results`);
        return;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err: any) {
      if (attempt < maxRetries) {
        const delay = 2000 * (attempt + 1);
        console.warn(
          `  ${file}: Attempt ${attempt + 1} failed (${err.message}), retrying in ${delay}ms...`
        );
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

// ─── Step 4: Apply Results ──────────────────────────────────────────────────

async function applyResults(): Promise<void> {
  const resultFiles = fs
    .readdirSync(BATCH_DIR)
    .filter((f) => f.endsWith(".result.json"))
    .sort();

  if (resultFiles.length === 0) {
    console.error("No result files found. Run --process first.");
    process.exit(1);
  }

  // Load all results
  const allResults: SplitResult[] = [];
  for (const file of resultFiles) {
    const data: SplitResult[] = JSON.parse(
      fs.readFileSync(path.join(BATCH_DIR, file), "utf-8")
    );
    allResults.push(...data);
  }

  console.log(
    `Loaded ${allResults.length} results from ${resultFiles.length} files`
  );

  // Load corresponding batch data for fullText
  const batchData = new Map<number, BatchItem>();
  const batchFiles = fs
    .readdirSync(BATCH_DIR)
    .filter((f) => f.match(/^batch-(\d{5}|prefilter)\.json$/))
    .sort();

  for (const file of batchFiles) {
    const items: BatchItem[] = JSON.parse(
      fs.readFileSync(path.join(BATCH_DIR, file), "utf-8")
    );
    for (const item of items) {
      batchData.set(item.id, item);
    }
  }

  // Fetch current DB state
  const hadithIds = allResults.map((r) => r.id);

  // Query in chunks to avoid parameter limits
  const dbMap = new Map<
    number,
    { id: number; textArabic: string; isnad: string | null; matn: string | null }
  >();

  const ID_CHUNK = 5000;
  for (let i = 0; i < hadithIds.length; i += ID_CHUNK) {
    const chunk = hadithIds.slice(i, i + ID_CHUNK);
    const rows = await prisma.hadith.findMany({
      where: { id: { in: chunk } },
      select: { id: true, textArabic: true, isnad: true, matn: true },
    });
    for (const r of rows) {
      dbMap.set(r.id, r);
    }
  }

  let applied = 0;
  let skippedNotFound = 0;
  let skippedAllIsnad = 0;
  let skippedAllMatn = 0;
  let errors = 0;
  let unchanged = 0;
  const updates: { id: number; isnad: string; matn: string }[] = [];
  const longIsnadIds: number[] = []; // isnad > 90% of text

  for (const result of allResults) {
    const dbHadith = dbMap.get(result.id);
    if (!dbHadith) {
      skippedNotFound++;
      continue;
    }

    const fullText = dbHadith.textArabic;
    const words = fullText.split(/\s+/);

    if (result.splitWord === -1) {
      // Entire text is isnad (chain variation)
      skippedAllIsnad++;
      updates.push({ id: result.id, isnad: fullText, matn: "" });
      applied++;
      continue;
    }

    if (result.splitWord === 0) {
      // Entire text is matn (no isnad)
      skippedAllMatn++;
      // isnad already empty, matn already fullText — check if unchanged
      if ((dbHadith.isnad || "") === "" && dbHadith.matn === fullText) {
        unchanged++;
        continue;
      }
      updates.push({ id: result.id, isnad: "", matn: fullText });
      applied++;
      continue;
    }

    if (result.splitWord < 0 || result.splitWord >= words.length) {
      console.warn(
        `  Hadith ${result.id}: splitWord ${result.splitWord} out of range (0-${words.length - 1}), skipping`
      );
      errors++;
      continue;
    }

    const newIsnad = words.slice(0, result.splitWord).join(" ");
    const newMatn = words.slice(result.splitWord).join(" ");

    // Validate: reconstruction matches original (whitespace-normalized)
    const originalNorm = fullText.replace(/\s+/g, " ").trim();
    const reconstructedNorm = (newIsnad + " " + newMatn)
      .replace(/\s+/g, " ")
      .trim();
    if (reconstructedNorm !== originalNorm) {
      console.warn(`  Hadith ${result.id}: reconstruction mismatch, skipping`);
      errors++;
      continue;
    }

    // Flag if isnad > 90% of text
    if (newIsnad.length > fullText.length * 0.9) {
      longIsnadIds.push(result.id);
    }

    // Check if actually changed
    if (newIsnad === (dbHadith.isnad || "") && newMatn === (dbHadith.matn || "")) {
      unchanged++;
      continue;
    }

    updates.push({ id: result.id, isnad: newIsnad, matn: newMatn });
    applied++;
  }

  console.log(`\nResults summary:`);
  console.log(`  To apply:        ${applied}`);
  console.log(`  Unchanged:       ${unchanged}`);
  console.log(`  Not found in DB: ${skippedNotFound}`);
  console.log(`  All-isnad (-1):  ${skippedAllIsnad}`);
  console.log(`  All-matn (0):    ${skippedAllMatn}`);
  console.log(`  Errors:          ${errors}`);
  console.log(`  Long isnad (>90%): ${longIsnadIds.length}`);

  if (longIsnadIds.length > 0 && longIsnadIds.length <= 20) {
    console.log(`  Long isnad IDs: ${longIsnadIds.join(", ")}`);
  }

  if (updates.length === 0) {
    console.log("Nothing to apply.");
    return;
  }

  // Apply in transaction batches
  const TX_BATCH = 100;
  for (let i = 0; i < updates.length; i += TX_BATCH) {
    const batch = updates.slice(i, i + TX_BATCH);
    await prisma.$transaction(
      batch.map((u) =>
        prisma.hadith.update({
          where: { id: u.id },
          data: { isnad: u.isnad, matn: u.matn },
        })
      )
    );

    if ((i + TX_BATCH) % 5000 === 0 || i + TX_BATCH >= updates.length) {
      console.log(
        `  Progress: ${Math.min(i + TX_BATCH, updates.length)}/${updates.length}`
      );
    }
  }

  console.log(`\nDone! Applied ${updates.length} splits.`);

  // Sample 10 for spot checking
  console.log("\n── Sample Splits ──");
  const samples = updates.slice(0, 10);
  for (const s of samples) {
    console.log(`\nHadith ${s.id}:`);
    console.log(`  Isnad (last 80 chars): ...${s.isnad.slice(-80)}`);
    console.log(`  Matn  (first 80 chars): ${s.matn.slice(0, 80)}...`);
  }
}

// ─── Step 5: Verify Reconstructions ─────────────────────────────────────────

async function verifyReconstructions(collectionSlug?: string): Promise<void> {
  const whereClause = collectionSlug
    ? `AND c.slug = '${collectionSlug}'`
    : "";

  const hadiths = await prisma.$queryRawUnsafe<
    Array<{
      id: number;
      hadithNumber: string;
      collectionSlug: string;
      textArabic: string;
      isnad: string | null;
      matn: string | null;
    }>
  >(`
    SELECT h.id, h."hadith_number" as "hadithNumber",
           h."text_arabic" as "textArabic",
           h.isnad, h.matn,
           c.slug as "collectionSlug"
    FROM hadiths h
    JOIN hadith_books hb ON h."book_id" = hb.id
    JOIN hadith_collections c ON hb."collection_id" = c.id
    WHERE h.isnad IS NOT NULL AND h.isnad != ''
    ${whereClause}
    ORDER BY c.slug, h.id
  `);

  console.log(`Verifying ${hadiths.length} hadiths with isnad splits...`);

  let ok = 0;
  let mismatches = 0;

  for (const h of hadiths) {
    const originalNorm = h.textArabic.replace(/\s+/g, " ").trim();
    const reconstructedNorm = ((h.isnad || "") + " " + (h.matn || ""))
      .replace(/\s+/g, " ")
      .trim();

    if (reconstructedNorm === originalNorm) {
      ok++;
    } else {
      mismatches++;
      if (mismatches <= 10) {
        console.warn(`  MISMATCH: ${h.collectionSlug} #${h.hadithNumber} (id ${h.id})`);
        console.warn(`    textArabic: ${h.textArabic.slice(0, 80)}...`);
        console.warn(`    isnad+matn: ${(h.isnad || "").slice(0, 40)}... + ${(h.matn || "").slice(0, 40)}...`);
      }
    }
  }

  console.log(`\nVerification: ${ok} OK, ${mismatches} mismatches out of ${hadiths.length}`);
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const doExport = args.includes("--export");
  const doProcess = args.includes("--process");
  const doApply = args.includes("--apply");
  const doVerify = args.includes("--verify");
  const force = args.includes("--force");
  const resplit = args.includes("--resplit");

  const collectionArg = args.find((a) => a.startsWith("--collection="));
  const collectionSlug = collectionArg ? collectionArg.slice(13) : undefined;

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: bun run pipelines/import/split-isnad-matn-llm.ts [OPTIONS]

Options:
  --dry-run              Show counts, don't export/process
  --export               Export batches from DB
  --process              Run LLM on existing batches
  --apply                Apply result files to DB (with validation)
  --verify               Verify isnad+matn reconstructs textArabic
  --force                Export + process + apply all at once
  --resplit              Re-split hadiths with short isnad (< 5 words)
  --collection=SLUG      Filter to a single collection
  --help, -h             Show this help

Resplit mode:
  --resplit --dry-run                    Show counts of short-isnad hadiths
  --resplit --export                     Export only short-isnad hadiths (with pre-filter)
  --resplit --export --process --apply   Full resplit pipeline`);
    process.exit(0);
  }

  if (!dryRun && !doExport && !doProcess && !doApply && !doVerify && !force && !resplit) {
    console.error(
      "ERROR: Must specify --dry-run, --export, --process, --apply, --verify, --resplit, or --force"
    );
    process.exit(1);
  }

  // Resplit mode: target hadiths with short isnad (< 5 words)
  if (resplit) {
    console.log(
      `Querying hadiths with short isnad${collectionSlug ? ` for ${collectionSlug}` : ""}...`
    );
    const hadiths = await queryResplitHadiths(collectionSlug);
    console.log(`Found ${hadiths.length} hadiths with isnad < 5 words`);

    if (hadiths.length === 0) {
      console.log("No hadiths to resplit.");
      return;
    }

    // Distribution
    const byCollection = new Map<string, number>();
    for (const h of hadiths) {
      byCollection.set(
        h.collectionSlug,
        (byCollection.get(h.collectionSlug) || 0) + 1
      );
    }
    console.log("\nBy collection:");
    for (const [slug, count] of [...byCollection.entries()].sort(
      (a, b) => b[1] - a[1]
    )) {
      console.log(`  ${slug}: ${count}`);
    }

    if (dryRun || (!doExport && !doProcess && !doApply && !doVerify && !force)) {
      // Show what the pre-filter would catch
      let preFilterCount = 0;
      for (const h of hadiths) {
        if (detectObviousMatnOnly(h.textArabic)) preFilterCount++;
      }
      const llmCount = hadiths.length - preFilterCount;
      const batches = Math.ceil(llmCount / BATCH_SIZE);
      const waves = Math.ceil(batches / MAX_CONCURRENT);
      console.log(`\nPre-filter would handle: ${preFilterCount} (no transmission verbs)`);
      console.log(`LLM needed: ${llmCount} (${batches} batches, ${waves} waves)`);
      return;
    }

    if (doExport || force) {
      await exportBatches(hadiths, true);
    }

    if (doProcess || force) {
      console.log("\nProcessing batches with Claude Haiku 4.5...");
      await processBatches();
    }

    if (doApply || force) {
      console.log("\nApplying splits...");
      await applyResults();
    }

    if (doVerify) {
      await verifyReconstructions(collectionSlug);
    }

    return;
  }

  // Export phase (normal mode)
  if (dryRun || doExport || force) {
    console.log(
      `Querying hadiths${collectionSlug ? ` for ${collectionSlug}` : ""}...`
    );
    const hadiths = await queryHadiths(collectionSlug);
    console.log(`Found ${hadiths.length} non-chain-variation hadiths`);

    if (hadiths.length === 0) {
      console.log("No hadiths to process.");
      return;
    }

    if (dryRun) {
      const batches = Math.ceil(hadiths.length / BATCH_SIZE);
      const waves = Math.ceil(batches / MAX_CONCURRENT);
      console.log(`\nWould create ${batches} batches (${waves} waves)`);

      // Distribution
      const byCollection = new Map<string, number>();
      for (const h of hadiths) {
        byCollection.set(
          h.collectionSlug,
          (byCollection.get(h.collectionSlug) || 0) + 1
        );
      }
      console.log("\nBy collection:");
      for (const [slug, count] of [...byCollection.entries()].sort(
        (a, b) => b[1] - a[1]
      )) {
        console.log(`  ${slug}: ${count}`);
      }
      return;
    }

    await exportBatches(hadiths);
  }

  // Process phase
  if (doProcess || force) {
    console.log("\nProcessing batches with Claude Haiku 4.5...");
    await processBatches();
  }

  // Apply phase
  if (doApply || force) {
    console.log("\nApplying splits...");
    await applyResults();
  }

  // Verify phase
  if (doVerify) {
    await verifyReconstructions(collectionSlug);
  }
}

main()
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
