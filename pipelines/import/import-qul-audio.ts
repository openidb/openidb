#!/usr/bin/env bun
/**
 * QUL (Quranic Universal Library) Audio Import
 *
 * Two modes:
 *   --mode=ayah  (default) — reads ayah-recitation JSON files, downloads per-ayah MP3s
 *   --mode=surah           — reads surah-recitation-* directories, downloads per-surah MP3s
 *
 * Usage:
 *   bun run pipelines/import/import-qul-audio.ts [options]
 *
 * Options:
 *   --mode=ayah|surah   Import mode (default: ayah)
 *   --concurrency=10    Parallel downloads (default: 10)
 *   --force             Re-download existing files
 *   --dry-run           Show what would be downloaded
 */

import { mkdir, stat, readdir, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { prisma } from "../../src/db";
import { getAudioBasePath } from "../../src/utils/audio-storage";
import { TOTAL_AYAHS } from "../../src/utils/ayah-numbering";

// ============================================================================
// Config
// ============================================================================

const TOTAL_SURAHS = 114;
const QUL_DOWNLOADS_DIR = join(process.env.HOME!, "Downloads");
const AUDIO_BASE = getAudioBasePath();
const TARTEEL_AYAH_DIR = join(AUDIO_BASE, "tarteel");
const TARTEEL_SURAH_DIR = join(AUDIO_BASE, "tarteel-surah");

const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg?.split("=")[1];
}
function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

const MODE = (getArg("mode") || "ayah") as "ayah" | "surah";
const CONCURRENCY = parseInt(getArg("concurrency") || "10", 10);
const FORCE = hasFlag("force");
const DRY_RUN = hasFlag("dry-run");

const DOWNLOAD_TIMEOUT = 120_000; // 120s for surah-level files (can be large)
const MAX_RETRIES = 3;
const INTER_BATCH_DELAY = 100;

// ============================================================================
// Types
// ============================================================================

interface AyahEntry {
  surah_number: number;
  ayah_number: number;
  audio_url: string;
  duration: number | null;
  segments: [number, number, number][] | null; // [word_id, start_ms, end_ms]
}

interface AyahReciterInfo {
  filename: string;
  slug: string;          // "tarteel/alafasy"
  nameEnglish: string;
  cdnFolder: string;     // "alafasy"
  ayahs: Record<string, AyahEntry>;
  hasSegments: boolean;
}

interface SurahEntry {
  surah_number: number;
  audio_url: string;
  duration: number | null;
}

interface SurahReciterInfo {
  dirName: string;       // "surah-recitation-mishari-al-afasy"
  slug: string;          // "tarteel-surah/mishari-al-afasy"
  nameEnglish: string;
  surahs: Record<string, SurahEntry>;
  segmentsData: Record<string, unknown> | null;
  surahCount: number;
}

// ============================================================================
// Helpers
// ============================================================================

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function downloadFile(
  url: string,
  destPath: string,
  retries = MAX_RETRIES
): Promise<{ ok: boolean; size: number }> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (res.status === 404) return { ok: false, size: 0 };
      if (res.status === 429 || res.status >= 500) {
        if (attempt < retries) {
          await sleep(Math.pow(2, attempt) * 1000);
          continue;
        }
        return { ok: false, size: 0 };
      }
      if (!res.ok) return { ok: false, size: 0 };

      const buffer = Buffer.from(await res.arrayBuffer());
      await writeFile(destPath, buffer);
      return { ok: true, size: buffer.length };
    } catch (err: unknown) {
      if (attempt < retries) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`  [ERR] Retry ${attempt}/${retries}: ${msg}`);
        await sleep(Math.pow(2, attempt) * 1000);
        continue;
      }
      return { ok: false, size: 0 };
    }
  }
  return { ok: false, size: 0 };
}

function prettifySlug(slug: string): string {
  return slug
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bAl /g, "al-")
    .replace(/\bAbd /g, "Abd ")
    .replace(/\bIbn /g, "ibn ")
    .replace(/\bAsh /g, "ash-")
    .replace(/\bAr /g, "ar-")
    .replace(/\bAd /g, "ad-")
    .replace(/\bAs /g, "as-");
}

// ============================================================================
// Map filenames to friendly names (ayah mode)
// ============================================================================

const NAME_MAP: Record<string, string> = {
  alafasy: "Mishari Rashid al-Afasy",
  abdulBasitMurattal: "Abdul Basit (Murattal)",
  abdulBasitMujawwad: "Abdul Basit (Mujawwad)",
  abdulrahmanAlSudais: "Abdur-Rahman as-Sudais",
  abuBakrAlShatri: "Abu Bakr al-Shatri",
  ghamadi: "Saad al-Ghamdi",
  husary: "Mahmoud Khalil al-Husary",
  husaryMuallim: "Mahmoud Khalil al-Husary (Muallim)",
  husaryMujawwad: "Mahmoud Khalil al-Husary (Mujawwad)",
  khalifaAlTunaiji: "Khalifa al-Tunaiji",
  maherAlMuaiqly: "Maher al-Muaiqly",
  minshawyMurattal: "Muhammad Siddiq al-Minshawi (Murattal)",
  saudAlShuraim: "Sa'ud ash-Shuraym",
  yasserAlDosari: "Yasser al-Dosari",
  alnufais: "Nabil ar-Rifai (Al-Nufais)",
  Rifai: "Hani ar-Rifai",
  Sudais: "Abdur-Rahman as-Sudais",
};

// ============================================================================
// Ayah Mode — parse ayah-recitation JSON files
// ============================================================================

async function loadAyahReciters(): Promise<AyahReciterInfo[]> {
  const files = await readdir(QUL_DOWNLOADS_DIR);
  const ayahFiles = files.filter((f) => f.startsWith("ayah-recitation") && f.endsWith(".json"));

  const reciters: AyahReciterInfo[] = [];

  for (const filename of ayahFiles) {
    const raw = await Bun.file(join(QUL_DOWNLOADS_DIR, filename)).text();
    const data: Record<string, AyahEntry> = JSON.parse(raw);

    const firstEntry = data["1:1"];
    if (!firstEntry) continue;

    // Skip EveryAyah mirrors — we already have those
    if (firstEntry.audio_url.includes("mirrors.quranicaudio.com")) {
      continue;
    }

    // Extract CDN folder name from URL
    const tartMatch = firstEntry.audio_url.match(/tarteel\.ai\/quran\/([^/]+)\//);
    const qcdnMatch = firstEntry.audio_url.match(/qurancdn\.com\/([^/]+)\//);
    const cdnFolder = tartMatch?.[1] || qcdnMatch?.[1] || "unknown";

    const slug = `tarteel/${cdnFolder.toLowerCase()}`;
    const nameEnglish = NAME_MAP[cdnFolder] || cdnFolder;
    const hasSegments = firstEntry.segments !== null && firstEntry.segments.length > 0;

    reciters.push({ filename, slug, nameEnglish, cdnFolder, ayahs: data, hasSegments });
  }

  return reciters;
}

async function importAyahReciter(reciter: AyahReciterInfo): Promise<{
  downloaded: number;
  skipped: number;
  failed: number;
  totalBytes: number;
}> {
  const reciterDir = join(TARTEEL_AYAH_DIR, reciter.cdnFolder.toLowerCase());
  await mkdir(reciterDir, { recursive: true });

  let existingCount = 0;
  try {
    const files = await readdir(reciterDir);
    existingCount = files.filter((f) => f.endsWith(".mp3")).length;
  } catch { /* empty */ }

  if (!FORCE && existingCount >= TOTAL_AYAHS) {
    console.log(`  Skipping ${reciter.slug} — already complete (${existingCount} files)`);
    return { downloaded: 0, skipped: existingCount, failed: 0, totalBytes: 0 };
  }

  console.log(`  Downloading ${reciter.slug} (${existingCount}/${TOTAL_AYAHS} existing)...`);

  let downloaded = 0, skipped = 0, failed = 0, totalBytes = 0;
  const entries = Object.values(reciter.ayahs);

  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const batch = entries.slice(i, i + CONCURRENCY);

    const results = await Promise.all(
      batch.map(async (entry) => {
        const filename = `${pad3(entry.surah_number)}${pad3(entry.ayah_number)}.mp3`;
        const filePath = join(reciterDir, filename);

        if (!FORCE) {
          try {
            await stat(filePath);
            return { status: "skipped" as const, size: 0 };
          } catch { /* proceed */ }
        }

        const result = await downloadFile(entry.audio_url, filePath);
        return result.ok
          ? { status: "downloaded" as const, size: result.size }
          : { status: "failed" as const, size: 0 };
      })
    );

    for (const r of results) {
      if (r.status === "downloaded") { downloaded++; totalBytes += r.size; }
      else if (r.status === "skipped") { skipped++; }
      else { failed++; }
    }

    const processed = i + batch.length;
    if (processed % 500 === 0 || processed === entries.length) {
      console.log(`    Progress: ${processed}/${TOTAL_AYAHS} (${downloaded} new, ${skipped} existing, ${failed} failed)`);
    }

    if (i + CONCURRENCY < entries.length) await sleep(INTER_BATCH_DELAY);
  }

  // Save segment data
  if (reciter.hasSegments) {
    const segments: Record<string, { segments: [number, number, number][]; duration: number | null }> = {};
    for (const [key, entry] of Object.entries(reciter.ayahs)) {
      if (entry.segments) {
        segments[key] = { segments: entry.segments, duration: entry.duration };
      }
    }
    const segmentPath = join(reciterDir, "_segments.json");
    await writeFile(segmentPath, JSON.stringify(segments));
    console.log(`  Saved segment data to _segments.json`);
  }

  // Update DB
  const finalCount = await readdir(reciterDir).then((f) => f.filter((x) => x.endsWith(".mp3")).length);
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

  await prisma.quranReciter.upsert({
    where: { slug: reciter.slug },
    update: { totalAyahs: finalCount, sizeBytes: finalSizeBytes },
    create: {
      slug: reciter.slug,
      nameEnglish: reciter.nameEnglish,
      source: "tarteel",
      sourceUrl: "https://qul.tarteel.ai",
      bitrate: 192,
      language: "ar",
      totalAyahs: finalCount,
      sizeBytes: finalSizeBytes,
    },
  });

  return { downloaded, skipped, failed, totalBytes };
}

// ============================================================================
// Surah Mode — parse surah-recitation-* directories
// ============================================================================

async function loadSurahReciters(): Promise<SurahReciterInfo[]> {
  const allDirs = await readdir(QUL_DOWNLOADS_DIR);
  const surahDirs = allDirs
    .filter((d) => d.startsWith("surah-recitation-"))
    .sort();

  const reciters: SurahReciterInfo[] = [];

  for (const dirName of surahDirs) {
    const dirPath = join(QUL_DOWNLOADS_DIR, dirName);
    const surahPath = join(dirPath, "surah.json");
    const segmentsPath = join(dirPath, "segments.json");

    let surahData: Record<string, SurahEntry>;
    try {
      const raw = await readFile(surahPath, "utf-8");
      surahData = JSON.parse(raw);
    } catch {
      console.warn(`  Skipping ${dirName} — cannot read surah.json`);
      continue;
    }

    let segmentsData: Record<string, unknown> | null = null;
    try {
      const raw = await readFile(segmentsPath, "utf-8");
      segmentsData = JSON.parse(raw);
    } catch { /* no segments */ }

    const reciterSlug = dirName.replace("surah-recitation-", "");
    const slug = `tarteel-surah/${reciterSlug}`;
    const nameEnglish = prettifySlug(reciterSlug);
    const surahCount = Object.keys(surahData).length;

    reciters.push({ dirName, slug, nameEnglish, surahs: surahData, segmentsData, surahCount });
  }

  return reciters;
}

async function importSurahReciter(reciter: SurahReciterInfo): Promise<{
  downloaded: number;
  skipped: number;
  failed: number;
  totalBytes: number;
}> {
  const reciterSlug = reciter.slug.replace("tarteel-surah/", "");
  const reciterDir = join(TARTEEL_SURAH_DIR, reciterSlug);
  await mkdir(reciterDir, { recursive: true });

  let existingCount = 0;
  try {
    const files = await readdir(reciterDir);
    existingCount = files.filter((f) => f.endsWith(".mp3")).length;
  } catch { /* empty */ }

  if (!FORCE && existingCount >= reciter.surahCount) {
    console.log(`  Skipping ${reciter.slug} — already complete (${existingCount} files)`);
    return { downloaded: 0, skipped: existingCount, failed: 0, totalBytes: 0 };
  }

  console.log(`  Downloading ${reciter.slug} (${existingCount}/${reciter.surahCount} existing)...`);

  let downloaded = 0, skipped = 0, failed = 0, totalBytes = 0;

  // Build entries list from surah data (keys are "1"-"114", possibly "0" for bismillah)
  const entries: { surahNum: number; url: string }[] = [];
  for (const [key, entry] of Object.entries(reciter.surahs)) {
    entries.push({ surahNum: entry.surah_number || parseInt(key, 10), url: entry.audio_url });
  }
  entries.sort((a, b) => a.surahNum - b.surahNum);

  // Download in batches (surah files are larger, so lower effective concurrency is fine)
  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const batch = entries.slice(i, i + CONCURRENCY);

    const results = await Promise.all(
      batch.map(async (entry) => {
        const filename = `${pad3(entry.surahNum)}.mp3`;
        const filePath = join(reciterDir, filename);

        if (!FORCE) {
          try {
            await stat(filePath);
            return { status: "skipped" as const, size: 0 };
          } catch { /* proceed */ }
        }

        const result = await downloadFile(entry.url, filePath);
        return result.ok
          ? { status: "downloaded" as const, size: result.size }
          : { status: "failed" as const, size: 0 };
      })
    );

    for (const r of results) {
      if (r.status === "downloaded") { downloaded++; totalBytes += r.size; }
      else if (r.status === "skipped") { skipped++; }
      else { failed++; }
    }
  }

  console.log(`    Downloaded: ${downloaded}, Skipped: ${skipped}, Failed: ${failed}`);

  // Save segment data (word-level timing within surah files)
  if (reciter.segmentsData) {
    const segmentPath = join(reciterDir, "_segments.json");
    await writeFile(segmentPath, JSON.stringify(reciter.segmentsData));
    console.log(`  Saved segment data to _segments.json (${Object.keys(reciter.segmentsData).length} ayahs)`);
  }

  // Update DB
  const finalCount = await readdir(reciterDir).then((f) => f.filter((x) => x.endsWith(".mp3")).length);
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

  // Detect language from slug (translations have "translation" in their name)
  const isTranslation = reciter.slug.includes("translation");
  const lang = isTranslation ? "en" : "ar";

  await prisma.quranReciter.upsert({
    where: { slug: reciter.slug },
    update: { totalAyahs: finalCount, sizeBytes: finalSizeBytes },
    create: {
      slug: reciter.slug,
      nameEnglish: reciter.nameEnglish,
      source: "tarteel",
      sourceUrl: "https://qul.tarteel.ai",
      bitrate: 192,
      language: lang,
      totalAyahs: finalCount,
      sizeBytes: finalSizeBytes,
    },
  });

  return { downloaded, skipped, failed, totalBytes };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const isAyahMode = MODE === "ayah";
  const baseDir = isAyahMode ? TARTEEL_AYAH_DIR : TARTEEL_SURAH_DIR;

  console.log(`QUL Audio Import Pipeline — ${MODE.toUpperCase()} mode`);
  console.log("========================");
  console.log(`Audio path: ${baseDir}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  if (FORCE) console.log("Force: enabled");
  if (DRY_RUN) console.log("Dry run: enabled");
  console.log();

  if (isAyahMode) {
    const reciters = await loadAyahReciters();
    console.log(`Found ${reciters.length} ayah-level reciters\n`);

    if (DRY_RUN) {
      for (const r of reciters) {
        const firstUrl = r.ayahs["1:1"].audio_url;
        console.log(`  ${r.slug} — ${r.nameEnglish} (segments: ${r.hasSegments ? "yes" : "no"})`);
        console.log(`    URL: ${firstUrl}`);
      }
      console.log(`\nTotal: ${reciters.length} reciters × ${TOTAL_AYAHS} ayahs = ${(reciters.length * TOTAL_AYAHS).toLocaleString()} files`);
      await prisma.$disconnect();
      return;
    }

    let totalDownloaded = 0, totalSkipped = 0, totalFailed = 0, totalBytes = 0;
    for (let i = 0; i < reciters.length; i++) {
      const r = reciters[i];
      console.log(`[${i + 1}/${reciters.length}] ${r.nameEnglish} (${r.slug})`);
      const result = await importAyahReciter(r);
      totalDownloaded += result.downloaded;
      totalSkipped += result.skipped;
      totalFailed += result.failed;
      totalBytes += result.totalBytes;
      console.log(`  Done: ${result.downloaded} downloaded, ${result.skipped} skipped, ${result.failed} failed\n`);
    }

    console.log("========================");
    console.log("Import Complete (ayah mode)");
    console.log(`  Reciters: ${reciters.length}`);
    console.log(`  Downloaded: ${totalDownloaded.toLocaleString()} files (${(totalBytes / 1024 / 1024 / 1024).toFixed(2)} GB)`);
    console.log(`  Skipped: ${totalSkipped.toLocaleString()} files`);
    console.log(`  Failed: ${totalFailed.toLocaleString()} files`);
  } else {
    const reciters = await loadSurahReciters();
    console.log(`Found ${reciters.length} surah-level reciters\n`);

    if (DRY_RUN) {
      for (const r of reciters) {
        const firstUrl = r.surahs["1"]?.audio_url || "N/A";
        const hasSegs = r.segmentsData ? "yes" : "no";
        console.log(`  ${r.slug} — ${r.nameEnglish} (${r.surahCount} surahs, segments: ${hasSegs})`);
        console.log(`    URL: ${firstUrl}`);
      }
      console.log(`\nTotal: ${reciters.length} reciters × ~114 surahs = ${(reciters.length * 114).toLocaleString()} files`);
      await prisma.$disconnect();
      return;
    }

    let totalDownloaded = 0, totalSkipped = 0, totalFailed = 0, totalBytes = 0;
    for (let i = 0; i < reciters.length; i++) {
      const r = reciters[i];
      console.log(`[${i + 1}/${reciters.length}] ${r.nameEnglish} (${r.slug})`);
      const result = await importSurahReciter(r);
      totalDownloaded += result.downloaded;
      totalSkipped += result.skipped;
      totalFailed += result.failed;
      totalBytes += result.totalBytes;
      console.log(`  Done: ${result.downloaded} downloaded, ${result.skipped} skipped, ${result.failed} failed\n`);
    }

    console.log("========================");
    console.log("Import Complete (surah mode)");
    console.log(`  Reciters: ${reciters.length}`);
    console.log(`  Downloaded: ${totalDownloaded.toLocaleString()} files (${(totalBytes / 1024 / 1024 / 1024).toFixed(2)} GB)`);
    console.log(`  Skipped: ${totalSkipped.toLocaleString()} files`);
    console.log(`  Failed: ${totalFailed.toLocaleString()} files`);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
