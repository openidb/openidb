#!/usr/bin/env bun
/**
 * Quran Audio Import Pipeline
 *
 * Downloads per-ayah MP3 recitations from EveryAyah, Al Quran Cloud, and Quran Foundation.
 * Files are stored at {QURAN_AUDIO_PATH}/{slug}/{SSS}{AAA}.mp3
 *
 * Usage:
 *   bun run pipelines/import/import-quran-audio.ts [options]
 *
 * Options:
 *   --source=everyayah|alquran-cloud|quran-foundation|all  (default: all)
 *   --reciter=<slug>        Import single reciter by slug (without source prefix)
 *   --force                 Re-download existing files
 *   --validate-only         HEAD-check URLs without downloading
 *   --concurrency=5         Parallel downloads per reciter (default: 5)
 *   --dry-run               Show what would be imported
 */

import { mkdir, stat, readdir, writeFile } from "fs/promises";
import { join } from "path";
import { prisma } from "../../src/db";
import { getAudioBasePath } from "../../src/utils/audio-storage";
import { allAyahs, TOTAL_AYAHS } from "../../src/utils/ayah-numbering";
import {
  buildAllReciters,
  syncReciterMetadata,
  type AudioSourceReciter,
} from "./quran-audio-resources";

// ============================================================================
// CLI Argument Parsing
// ============================================================================

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg?.split("=")[1];
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

const SOURCE_FILTER = getArg("source") || "all";
const RECITER_FILTER = getArg("reciter");
const FORCE = hasFlag("force");
const VALIDATE_ONLY = hasFlag("validate-only");
const CONCURRENCY = parseInt(getArg("concurrency") || "5", 10);
const DRY_RUN = hasFlag("dry-run");

// ============================================================================
// Download Helpers
// ============================================================================

const DOWNLOAD_TIMEOUT = 60_000; // 60s per file
const INTER_FILE_DELAY = 200;    // 200ms between files to avoid throttling
const MAX_RETRIES = 3;

async function downloadFile(
  url: string,
  destPath: string,
  retries = MAX_RETRIES
): Promise<{ ok: boolean; size: number; status: number }> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT);

      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (res.status === 404) {
        return { ok: false, size: 0, status: 404 };
      }

      if (res.status === 429 || res.status >= 500) {
        if (attempt < retries) {
          const delay = Math.pow(2, attempt) * 1000; // exponential backoff
          console.warn(`  [${res.status}] Retry ${attempt}/${retries} in ${delay}ms: ${url}`);
          await sleep(delay);
          continue;
        }
        return { ok: false, size: 0, status: res.status };
      }

      if (!res.ok) {
        return { ok: false, size: 0, status: res.status };
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      await writeFile(destPath, buffer);
      return { ok: true, size: buffer.length, status: 200 };
    } catch (err: unknown) {
      if (attempt < retries) {
        const delay = Math.pow(2, attempt) * 1000;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`  [ERR] Retry ${attempt}/${retries} in ${delay}ms: ${msg}`);
        await sleep(delay);
        continue;
      }
      return { ok: false, size: 0, status: 0 };
    }
  }
  return { ok: false, size: 0, status: 0 };
}

async function headCheck(url: string): Promise<{ ok: boolean; status: number }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(url, { method: "HEAD", signal: controller.signal });
    clearTimeout(timeout);
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

// ============================================================================
// Import Logic
// ============================================================================

async function countExistingFiles(dir: string): Promise<number> {
  try {
    const files = await readdir(dir);
    return files.filter((f) => f.endsWith(".mp3")).length;
  } catch {
    return 0;
  }
}

async function importReciter(reciter: AudioSourceReciter): Promise<{
  downloaded: number;
  skipped: number;
  failed: number;
  totalBytes: number;
}> {
  const audioBase = getAudioBasePath();
  const reciterDir = join(audioBase, reciter.slug);

  // Create directory
  await mkdir(reciterDir, { recursive: true });

  // Count existing files
  const existingCount = await countExistingFiles(reciterDir);

  if (!FORCE && existingCount >= TOTAL_AYAHS) {
    console.log(`  Skipping ${reciter.slug} — already complete (${existingCount} files)`);
    return { downloaded: 0, skipped: existingCount, failed: 0, totalBytes: 0 };
  }

  console.log(`  Importing ${reciter.slug} (${existingCount}/${TOTAL_AYAHS} existing)...`);

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;
  let totalBytes = 0;

  // Build ayah list
  const ayahList = [...allAyahs()];

  // Process in batches of CONCURRENCY
  for (let i = 0; i < ayahList.length; i += CONCURRENCY) {
    const batch = ayahList.slice(i, i + CONCURRENCY);

    const results = await Promise.all(
      batch.map(async ({ surah, ayah }) => {
        const filename = `${pad3(surah)}${pad3(ayah)}.mp3`;
        const filePath = join(reciterDir, filename);

        // Skip existing files unless --force
        if (!FORCE) {
          try {
            await stat(filePath);
            return { status: "skipped" as const, size: 0 };
          } catch {
            // File doesn't exist, proceed to download
          }
        }

        if (VALIDATE_ONLY) {
          const url = reciter.getAudioUrl(surah, ayah);
          const result = await headCheck(url);
          return { status: result.ok ? "valid" as const : "invalid" as const, size: 0 };
        }

        const url = reciter.getAudioUrl(surah, ayah);
        const result = await downloadFile(url, filePath);

        if (result.ok) {
          return { status: "downloaded" as const, size: result.size };
        }
        return { status: "failed" as const, size: 0 };
      })
    );

    for (const r of results) {
      switch (r.status) {
        case "downloaded":
        case "valid":
          downloaded++;
          totalBytes += r.size;
          break;
        case "skipped":
          skipped++;
          break;
        case "failed":
        case "invalid":
          failed++;
          break;
      }
    }

    // Progress logging every 500 ayahs
    const processed = i + batch.length;
    if (processed % 500 === 0 || processed === ayahList.length) {
      console.log(`    Progress: ${processed}/${TOTAL_AYAHS} (${downloaded} new, ${skipped} existing, ${failed} failed)`);
    }

    // Delay between batches
    if (i + CONCURRENCY < ayahList.length) {
      await sleep(INTER_FILE_DELAY);
    }
  }

  // Update DB record
  const finalCount = await countExistingFiles(reciterDir);
  let finalSizeBytes = BigInt(0);
  try {
    const files = await readdir(reciterDir);
    for (const f of files) {
      if (f.endsWith(".mp3")) {
        const s = await stat(join(reciterDir, f));
        finalSizeBytes += BigInt(s.size);
      }
    }
  } catch { /* ignore */ }

  await prisma.quranReciter.update({
    where: { slug: reciter.slug },
    data: { totalAyahs: finalCount, sizeBytes: finalSizeBytes },
  });

  return { downloaded, skipped, failed, totalBytes };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("Quran Audio Import Pipeline");
  console.log("===========================");
  console.log(`Audio path: ${getAudioBasePath()}`);
  console.log(`Source: ${SOURCE_FILTER}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  if (RECITER_FILTER) console.log(`Reciter filter: ${RECITER_FILTER}`);
  if (FORCE) console.log("Force: enabled");
  if (VALIDATE_ONLY) console.log("Validate only: enabled");
  if (DRY_RUN) console.log("Dry run: enabled");
  console.log();

  // Build reciter list
  console.log("Fetching reciter registries...");
  const allReciters = await buildAllReciters();
  console.log(`Found ${allReciters.length} reciters total`);

  // Filter by source
  let filtered = allReciters;
  if (SOURCE_FILTER !== "all") {
    filtered = filtered.filter((r) => r.source === SOURCE_FILTER);
  }

  // Filter by reciter slug
  if (RECITER_FILTER) {
    filtered = filtered.filter((r) => r.slug.includes(RECITER_FILTER));
  }

  console.log(`Selected ${filtered.length} reciters for import\n`);

  if (DRY_RUN) {
    console.log("Reciters to import:");
    for (const r of filtered) {
      console.log(`  ${r.slug} — ${r.nameEnglish} (${r.bitrate}kbps, ${r.source})`);
      console.log(`    Sample URL: ${r.getAudioUrl(1, 1)}`);
    }
    console.log(`\nTotal: ${filtered.length} reciters × ${TOTAL_AYAHS} ayahs = ${(filtered.length * TOTAL_AYAHS).toLocaleString()} files`);
    await prisma.$disconnect();
    return;
  }

  // Sync metadata to DB
  console.log("Syncing reciter metadata to database...");
  const synced = await syncReciterMetadata(filtered);
  console.log(`Synced ${synced} reciter records\n`);

  // Import each reciter
  let totalDownloaded = 0;
  let totalSkipped = 0;
  let totalFailed = 0;
  let totalBytes = 0;

  for (let i = 0; i < filtered.length; i++) {
    const reciter = filtered[i];
    console.log(`[${i + 1}/${filtered.length}] ${reciter.nameEnglish} (${reciter.slug})`);

    const result = await importReciter(reciter);
    totalDownloaded += result.downloaded;
    totalSkipped += result.skipped;
    totalFailed += result.failed;
    totalBytes += result.totalBytes;

    console.log(`  Done: ${result.downloaded} downloaded, ${result.skipped} skipped, ${result.failed} failed\n`);
  }

  // Summary
  console.log("===========================");
  console.log("Import Complete");
  console.log(`  Reciters: ${filtered.length}`);
  console.log(`  Downloaded: ${totalDownloaded.toLocaleString()} files (${(totalBytes / 1024 / 1024 / 1024).toFixed(2)} GB)`);
  console.log(`  Skipped: ${totalSkipped.toLocaleString()} files`);
  console.log(`  Failed: ${totalFailed.toLocaleString()} files`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
