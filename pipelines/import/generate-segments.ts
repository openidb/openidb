#!/usr/bin/env bun
/**
 * Generate _segments.json for reciters using the qurancdn.com API.
 *
 * The API provides word-level timestamps within surah-level audio.
 * We fetch these and convert them to per-ayah timestamps (offset from 0)
 * suitable for our player's word-highlighting system.
 *
 * Usage:
 *   bun run pipelines/import/generate-segments.ts --reciter=97 --slug=tarteel/dossary --out=/path/to/dir
 *   bun run pipelines/import/generate-segments.ts --reciter=97 --slug=tarteel/dossary  # writes to QURAN_AUDIO_PATH
 */

import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { getAudioBasePath } from "../../src/utils/audio-storage";

const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg?.split("=")[1];
}

const RECITER_ID = getArg("reciter");
const SLUG = getArg("slug");
const OUT_DIR = getArg("out");

if (!RECITER_ID || !SLUG) {
  console.error("Usage: --reciter=<qurancdn_id> --slug=<tarteel/name> [--out=<dir>]");
  process.exit(1);
}

const TOTAL_SURAHS = 114;
const API_BASE = "https://api.qurancdn.com/api/qdc/audio/reciters";

interface VerseTiming {
  verse_key: string;
  timestamp_from: number;
  timestamp_to: number;
  duration: number;
  segments: [number, number, number][]; // [word_position, start_ms, end_ms]
}

interface AudioFile {
  chapter_id: number;
  verse_timings: VerseTiming[];
}

interface APIResponse {
  audio_files: AudioFile[];
}

async function fetchChapterSegments(reciterId: string, chapter: number): Promise<VerseTiming[]> {
  const url = `${API_BASE}/${reciterId}/audio_files?chapter=${chapter}&segments=true`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`  [WARN] Chapter ${chapter}: HTTP ${res.status}`);
    return [];
  }
  const data: APIResponse = await res.json();
  if (!data.audio_files?.[0]?.verse_timings) return [];
  return data.audio_files[0].verse_timings;
}

async function main() {
  const outputDir = OUT_DIR || join(getAudioBasePath(), SLUG!);
  await mkdir(outputDir, { recursive: true });

  console.log(`Generating segments for reciter ${RECITER_ID} (${SLUG})`);
  console.log(`Output: ${outputDir}/_segments.json`);
  console.log();

  const allSegments: Record<string, { segments: [number, number, number][]; duration: number | null }> = {};
  let totalAyahs = 0;

  for (let ch = 1; ch <= TOTAL_SURAHS; ch++) {
    const timings = await fetchChapterSegments(RECITER_ID!, ch);
    if (timings.length === 0) {
      console.warn(`  Chapter ${ch}: no timings found`);
      continue;
    }

    for (const vt of timings) {
      // vt.segments has timestamps relative to the surah file.
      // For per-ayah playback, we need timestamps relative to 0.
      // The offset is the verse's timestamp_from.
      const ayahStart = vt.timestamp_from;
      const adjustedSegments: [number, number, number][] = vt.segments.map(([pos, startMs, endMs]) => [
        pos - 1, // Convert 1-indexed to 0-indexed word position
        startMs - ayahStart,
        endMs - ayahStart,
      ]);

      allSegments[vt.verse_key] = {
        segments: adjustedSegments,
        duration: vt.duration,
      };
      totalAyahs++;
    }

    if (ch % 10 === 0) {
      console.log(`  Progress: ${ch}/${TOTAL_SURAHS} surahs (${totalAyahs} ayahs)`);
    }

    // Small delay to be polite to the API
    await new Promise((r) => setTimeout(r, 50));
  }

  const outputPath = join(outputDir, "_segments.json");
  await writeFile(outputPath, JSON.stringify(allSegments));
  console.log(`\nDone! ${totalAyahs} ayahs written to ${outputPath}`);
  console.log(`File size: ${(Buffer.byteLength(JSON.stringify(allSegments)) / 1024 / 1024).toFixed(2)} MB`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
