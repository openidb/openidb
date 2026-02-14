import { join } from "path";
import { stat } from "fs/promises";

const AUDIO_BASE = process.env.QURAN_AUDIO_PATH || "/Volumes/KIOXIA/quran-audio";

/**
 * Compute the absolute file path for a reciter's ayah audio.
 * e.g. /Volumes/KIOXIA/quran-audio/everyayah/alafasy-128kbps/001001.mp3
 */
export function audioFilePath(slug: string, surah: number, ayah: number): string {
  const filename = `${String(surah).padStart(3, "0")}${String(ayah).padStart(3, "0")}.mp3`;
  return join(AUDIO_BASE, slug, filename);
}

/**
 * Check if an audio file exists on disk.
 */
export async function audioFileExists(slug: string, surah: number, ayah: number): Promise<boolean> {
  try {
    await stat(audioFilePath(slug, surah, ayah));
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the base directory for all audio files.
 */
export function getAudioBasePath(): string {
  return AUDIO_BASE;
}
