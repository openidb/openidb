/**
 * LLM-Based Dictionary Definition Extraction
 *
 * Sends dictionary page batches to Claude 3.5 Haiku via OpenRouter
 * to extract headword:definition pairs with proper diacritics.
 *
 * Usage:
 *   bun run pipelines/import/dictionary/extract-definitions.ts --slug=muhit
 *   bun run pipelines/import/dictionary/extract-definitions.ts --slug=muhit --batch=066
 *   bun run pipelines/import/dictionary/extract-definitions.ts --slug=muhit --concurrency=3
 *   bun run pipelines/import/dictionary/extract-definitions.ts --slug=muhit --dry-run
 */

import "../../env";
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const BATCH_DIR = resolve(import.meta.dir, "extraction-batches");
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "anthropic/claude-3.5-haiku";
const TIMEOUT_MS = 60_000;

const SYSTEM_PROMPT = `You are an Arabic dictionary parser. Extract headword:definition pairs from the following dictionary pages.

## Headword Rules
- A headword is a SINGLE Arabic word or short phrase (1-5 words, max 40 chars)
- Preserve ALL diacritics (tashkeel) exactly as they appear
- Strip leading و (conjunction) — if headword starts with "و" followed by a space or Arabic word, remove the و
- Strip leading ف/ب/ك/ل (single-letter prepositions) only when clearly a conjunction prefix, not part of the word
- Strip footnote markers (^N) or (^١٢) from headwords
- Strip Quranic brackets ﴿ ﴾ from headwords
- Do NOT use these as headwords:
  - Numbers (١٢, 16, etc.)
  - Footnote references: (^N), (^١٢), في ك, etc.
  - Section headers: كتاب, باب, فصل, حرف + letter name
  - Root group headers: الخاء والراء والميم (letter combination patterns)
  - Page/manuscript references: في م, في ك, في الأصل, etc.
  - Editorial commentary about sources or manuscripts
  - Table of contents entries or publisher/editor information

## Definition Rules
- Include the full definition text
- Clean footnote markers (^N) from definitions
- Skip definitions that are ONLY page numbers, cross-references, or manuscript notes
- Minimum meaningful content: at least a few Arabic words

## Output Format
Return ONLY a JSON array:
[
  {
    "headword": "الكَلِمَة",
    "definition": "المَعنى...",
    "pageNumber": 42
  }
]

Note: Do NOT include a "root" field — root extraction will be done programmatically.

## Pages to Skip
- Page 0 or introductory pages with publisher info, editor names, table of contents
- Pages containing only section headers without definitions`;

interface BatchFile {
  slug: string;
  sourceId: number;
  bookId: string;
  dictionaryName: string;
  totalChunks: number;
  chunks: Array<{
    chunkId: number;
    startPage: number;
    endPage: number;
    volumeNumber: number;
    pages: Array<{ pageNumber: number; contentPlain: string }>;
  }>;
  extracted?: Array<{
    chunkId: number;
    definitions: Array<{
      headword: string;
      root: string;
      rootNormalized: string;
      definition: string;
      pageNumber: number;
    }>;
  }>;
}

interface ExtractedDef {
  headword: string;
  root: string;
  definition: string;
  pageNumber: number;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const params: Record<string, string> = {};

  for (const arg of args) {
    const [key, value] = arg.split("=");
    if (value) params[key] = value;
    else params[arg] = "true";
  }

  const slug = params["--slug"];
  if (!slug) {
    console.error(
      "Usage: bun run extract-definitions.ts --slug=<slug> [--batch=NNN] [--concurrency=N] [--dry-run]",
    );
    process.exit(1);
  }

  return {
    slug,
    batch: params["--batch"] ?? "",
    concurrency: parseInt(params["--concurrency"] ?? "1", 10),
    dryRun: params["--dry-run"] === "true",
  };
}

/**
 * Robustly extract a JSON array from LLM response text.
 * Handles: markdown code blocks, leading/trailing text, nested objects.
 */
function extractJsonArray(text: string): any[] | null {
  const strategies = [
    () => {
      // Strip markdown code blocks and try direct parse
      let clean = text
        .trim()
        .replace(/^```(?:json)?\s*\n?/m, "")
        .replace(/\n?\s*```\s*$/m, "");
      const parsed = JSON.parse(clean);
      return Array.isArray(parsed) ? parsed : null;
    },
    () => {
      // Extract content between first [ and last ]
      const start = text.indexOf("[");
      const end = text.lastIndexOf("]");
      if (start < 0 || end <= start) return null;

      const candidate = text.slice(start, end + 1);
      const parsed = JSON.parse(candidate);
      return Array.isArray(parsed) ? parsed : null;
    },
    () => {
      // Fix trailing commas and retry
      const start = text.indexOf("[");
      const end = text.lastIndexOf("]");
      if (start < 0 || end <= start) return null;

      const fixed = text.slice(start, end + 1).replace(/,\s*[\]}]/g, "$&");
      const parsed = JSON.parse(fixed);
      return Array.isArray(parsed) ? parsed : null;
    },
  ];

  for (const strategy of strategies) {
    try {
      const result = strategy();
      if (result) return result;
    } catch {}
  }

  return null;
}

async function callLLM(
  pages: Array<{ pageNumber: number; contentPlain: string }>,
): Promise<ExtractedDef[]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");

  // Build page content as user message
  const pageText = pages
    .map((p) => `--- Page ${p.pageNumber} ---\n${p.contentPlain}`)
    .join("\n\n");

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
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Extract all headword:definition pairs from these dictionary pages:\n\n${pageText}`,
          },
        ],
        temperature: 0,
        max_tokens: 16384,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenRouter API error ${response.status}: ${text}`);
    }

    const data = await response.json();
    const content: string = data.choices?.[0]?.message?.content || "";

    // Check if LLM explicitly says no entries found
    const lower = content.toLowerCase();
    if (
      lower.includes("no clear headword") ||
      lower.includes("no headword:definition") ||
      lower.includes("no dictionary entries") ||
      lower.includes("there are no clear") ||
      lower.includes("no entries to extract") ||
      content.trim() === "[]"
    ) {
      return [];
    }

    // Robustly extract JSON array from LLM response
    const parsed = extractJsonArray(content);
    if (!parsed) {
      throw new Error(
        `Failed to parse JSON from LLM response (${content.length} chars): ${content.slice(0, 200)}`,
      );
    }

    return parsed.filter(
      (d: any) =>
        d.headword && d.definition && typeof d.pageNumber === "number",
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

async function processChunk(
  chunk: BatchFile["chunks"][number],
  maxRetries = 2,
): Promise<{ chunkId: number; definitions: ExtractedDef[] }> {
  const pages = chunk.pages.filter((p) => p.contentPlain.trim().length > 10);
  if (pages.length === 0) {
    return { chunkId: chunk.chunkId, definitions: [] };
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const defs = await callLLM(pages);
      return { chunkId: chunk.chunkId, definitions: defs };
    } catch (err: any) {
      if (attempt < maxRetries) {
        const delay = 2000 * (attempt + 1);
        console.warn(
          `  Chunk ${chunk.chunkId} attempt ${attempt + 1} failed: ${err.message}. Retrying in ${delay}ms...`,
        );
        await new Promise((r) => setTimeout(r, delay));
      } else {
        console.error(
          `  Chunk ${chunk.chunkId} FAILED after ${maxRetries + 1} attempts: ${err.message}`,
        );
      }
    }
  }
  return { chunkId: chunk.chunkId, definitions: [] };
}

async function processBatch(
  filePath: string,
  dryRun: boolean,
): Promise<number> {
  const batch: BatchFile = JSON.parse(readFileSync(filePath, "utf-8"));
  const fileName = filePath.split("/").pop();

  // Check if already extracted
  if (batch.extracted?.length) {
    const count = batch.extracted.reduce(
      (sum, c) => sum + c.definitions.length,
      0,
    );
    console.log(`  ${fileName}: already extracted (${count} defs), skipping`);
    return 0;
  }

  if (!batch.chunks?.length) {
    console.log(`  ${fileName}: no chunks, skipping`);
    return 0;
  }

  // Preview mode: just process first chunk
  if (dryRun) {
    console.log(`  ${fileName}: ${batch.chunks.length} chunks, would extract`);
    const result = await processChunk(batch.chunks[0]);
    console.log(
      `    Preview: chunk 1 → ${result.definitions.length} definitions`,
    );
    result.definitions.slice(0, 5).forEach((d) => {
      const preview =
        d.definition.length > 60
          ? d.definition.slice(0, 60) + "..."
          : d.definition;
      console.log(
        `      p${d.pageNumber} ${d.headword} [${d.root}]: ${preview}`,
      );
    });
    return result.definitions.length;
  }

  // Process all chunks
  const extracted: BatchFile["extracted"] = [];
  for (const chunk of batch.chunks) {
    const result = await processChunk(chunk);
    extracted.push({
      chunkId: result.chunkId,
      definitions: result.definitions.map((d) => ({
        ...d,
        rootNormalized: d.root?.trim() || "",
      })),
    });

    const totalDefs = extracted.reduce(
      (sum, c) => sum + c.definitions.length,
      0,
    );
    process.stdout.write(
      `\r  ${fileName}: ${extracted.length}/${batch.chunks.length} chunks, ${totalDefs} defs`,
    );
  }

  console.log();
  batch.extracted = extracted;
  writeFileSync(filePath, JSON.stringify(batch, null, 2));

  return extracted.reduce((sum, c) => sum + c.definitions.length, 0);
}

async function main() {
  const { slug, batch, concurrency, dryRun } = parseArgs();

  const slugDir = resolve(BATCH_DIR, slug);
  let files: string[];
  try {
    files = readdirSync(slugDir)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    console.error(`No batch directory found at ${slugDir}`);
    process.exit(1);
  }

  // Filter to specific batch if requested
  if (batch) {
    files = files.filter((f) => f.includes(batch));
    if (files.length === 0) {
      console.error(`No batch file matching "${batch}" found in ${slugDir}`);
      process.exit(1);
    }
  }

  console.log(
    `Processing ${files.length} batch files for "${slug}" (concurrency: ${concurrency})${dryRun ? " [DRY RUN]" : ""}`,
  );
  console.log();

  const filePaths = files.map((f) => resolve(slugDir, f));
  const results =
    concurrency <= 1
      ? await processSequentially(
          filePaths.slice(0, dryRun ? 1 : undefined),
          dryRun,
        )
      : await processWithConcurrency(filePaths, concurrency, dryRun);

  const totalDefs = results.reduce((sum, r) => sum + r, 0);
  console.log(
    `\nDone. Processed ${results.length} batch files, extracted ${totalDefs} total definitions.`,
  );
}

async function processSequentially(
  filePaths: string[],
  dryRun: boolean,
): Promise<number[]> {
  const results: number[] = [];
  for (const filePath of filePaths) {
    results.push(await processBatch(filePath, dryRun));
  }
  return results;
}

async function processWithConcurrency(
  filePaths: string[],
  concurrency: number,
  dryRun: boolean,
): Promise<number[]> {
  const results: number[] = [];
  const queue = [...filePaths];

  const workers = Array.from({ length: concurrency }, async () => {
    let filePath: string | undefined;
    while ((filePath = queue.shift()) !== undefined) {
      const defs = await processBatch(filePath, dryRun);
      results.push(defs);
    }
  });

  await Promise.all(workers);
  return results;
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
