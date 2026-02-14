/**
 * Surah-to-sequential ayah mapping.
 *
 * Al Quran Cloud CDN uses sequential numbering (1-6236).
 * Other sources use surah:ayah format (e.g. 2:255).
 */

// Number of ayahs per surah (index 0 = surah 1)
const AYAH_COUNTS = [
  7, 286, 200, 176, 120, 165, 206, 75, 129, 109,
  123, 111, 43, 52, 99, 128, 111, 110, 98, 135,
  112, 78, 118, 64, 77, 227, 93, 88, 69, 60,
  34, 30, 73, 54, 45, 83, 182, 88, 75, 85,
  54, 53, 89, 59, 37, 35, 38, 29, 18, 45,
  60, 49, 62, 55, 78, 96, 29, 22, 24, 13,
  14, 11, 11, 18, 12, 12, 30, 52, 52, 44,
  28, 28, 20, 56, 40, 31, 50, 40, 46, 42,
  29, 19, 36, 25, 22, 17, 19, 26, 30, 20,
  15, 21, 11, 8, 8, 19, 5, 8, 8, 11,
  11, 8, 3, 9, 5, 4, 7, 3, 6, 3,
  5, 4, 5, 6,
];

export const TOTAL_AYAHS = 6236;
export const TOTAL_SURAHS = 114;

// Precompute cumulative offsets for O(1) lookup
const CUMULATIVE: number[] = new Array(TOTAL_SURAHS);
CUMULATIVE[0] = 0;
for (let i = 1; i < TOTAL_SURAHS; i++) {
  CUMULATIVE[i] = CUMULATIVE[i - 1] + AYAH_COUNTS[i - 1];
}

/**
 * Convert surah:ayah to sequential number (1-6236).
 */
export function toSequentialAyah(surah: number, ayah: number): number {
  return CUMULATIVE[surah - 1] + ayah;
}

/**
 * Convert sequential number (1-6236) to surah:ayah.
 */
export function fromSequentialAyah(sequential: number): { surah: number; ayah: number } {
  for (let i = TOTAL_SURAHS - 1; i >= 0; i--) {
    if (sequential > CUMULATIVE[i]) {
      return { surah: i + 1, ayah: sequential - CUMULATIVE[i] };
    }
  }
  return { surah: 1, ayah: 1 };
}

/**
 * Get the number of ayahs in a surah.
 */
export function ayahCountForSurah(surah: number): number {
  return AYAH_COUNTS[surah - 1];
}

/**
 * Iterate all surah:ayah pairs in order.
 */
export function* allAyahs(): Generator<{ surah: number; ayah: number }> {
  for (let s = 1; s <= TOTAL_SURAHS; s++) {
    const count = AYAH_COUNTS[s - 1];
    for (let a = 1; a <= count; a++) {
      yield { surah: s, ayah: a };
    }
  }
}
