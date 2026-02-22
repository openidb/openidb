/**
 * Source URL Generation Utilities
 *
 * Centralized URL generation for all external data sources.
 * Used by both API routes (for attribution) and pipelines (for embedding payloads).
 */

export const SOURCES = {
  turath: [{ name: "Turath Library", url: "https://turath.io", type: "api" }],
  quranCloud: [{ name: "Al Quran Cloud API", url: "https://api.alquran.cloud", type: "api" }],
  tafsir: [
    { name: "spa5k/tafsir_api", url: "https://github.com/spa5k/tafsir_api", type: "api" },
    { name: "quran-tafseer.com", url: "http://api.quran-tafseer.com", type: "api" },
  ],
  qul: [{ name: "QUL (Tarteel AI)", url: "https://qul.tarteel.ai", type: "api" }],
  quranTranslation: [{ name: "fawazahmed0/quran-api", url: "https://github.com/fawazahmed0/quran-api", type: "api" }],
  wordTranslation: [{ name: "Quran.com API", url: "https://quran.com", type: "api" }],
  quranAudio: [
    { name: "EveryAyah", url: "https://everyayah.com", type: "cdn" },
    { name: "Al Quran Cloud CDN", url: "https://cdn.islamic.network", type: "cdn" },
    { name: "Quran Foundation", url: "https://quran.com", type: "api" },
    { name: "MP3Quran.net", url: "https://mp3quran.net", type: "api" },
    { name: "Tarteel AI / QUL", url: "https://qul.tarteel.ai", type: "cdn" },
  ],
} as const;

/**
 * Generate the correct source URL for any hadith.
 * All hadiths now come from Turath book editions — links to internal reader pages.
 */
export function generateHadithSourceUrl(
  collectionSlug: string,
  hadithNumber: string,
  bookNumber: number,
  numberInCollection?: string | null,
  sourceBookId?: string | null,
  sourcePageStart?: number | null,
): string {
  if (sourceBookId && sourcePageStart) {
    return generatePageReferenceUrl(sourceBookId, sourcePageStart);
  }
  return "";
}

/**
 * Generate a quran.com URL for a specific ayah.
 */
export function generateQuranUrl(surahNumber: number, ayahNumber: number): string {
  return `https://quran.com/${surahNumber}?startingVerse=${ayahNumber}`;
}

/**
 * Generate a turath.io URL for a book.
 */
export function generateBookReferenceUrl(bookId: string): string {
  return `https://app.turath.io/book/${bookId}`;
}

/**
 * Generate an internal reader URL for a specific page in a book.
 */
export function generatePageReferenceUrl(bookId: string, pageNumber: number): string {
  return `/reader/${bookId}?pn=${pageNumber}`;
}

/**
 * Generate a source URL for a tafsir entry.
 * Accepts editionId (e.g. "ar-tafsir-ibn-kathir", "qul-14") or legacy source slug.
 */
export function generateTafsirSourceUrl(
  editionIdOrSource: string,
  surahNumber: number
): string {
  // QUL tafsir editions
  if (editionIdOrSource.startsWith("qul-")) {
    const resourceId = parseInt(editionIdOrSource.slice(4), 10);
    return generateQulTafsirSourceUrl(resourceId, surahNumber);
  }
  // Legacy source values
  if (editionIdOrSource === "jalalayn") {
    return `https://cdn.jsdelivr.net/gh/spa5k/tafsir_api@main/tafsir/ar-jalalayn/${surahNumber}.json`;
  }
  if (editionIdOrSource === "ibn_kathir") {
    return `https://cdn.jsdelivr.net/gh/spa5k/tafsir_api@main/tafsir/ar-tafsir-ibn-kathir/${surahNumber}.json`;
  }
  // Edition ID — direct CDN URL
  return `https://cdn.jsdelivr.net/gh/spa5k/tafsir_api@main/tafsir/${editionIdOrSource}/${surahNumber}.json`;
}

/**
 * Generate a source URL for a Quran translation edition.
 */
export function generateTranslationSourceUrl(editionId: string): string {
  if (editionId.startsWith("qul-")) {
    const resourceId = editionId.slice(4);
    return `https://qul.tarteel.ai/api/v1/translations/${resourceId}/by_range?from=1:1&to=1:7`;
  }
  return `https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1/editions/${editionId}.json`;
}

/**
 * Generate a source URL for a QUL tafsir edition.
 */
function generateQulTafsirSourceUrl(resourceId: number, surahNumber: number): string {
  return `https://qul.tarteel.ai/api/v1/tafsirs/${resourceId}/by_range?from=${surahNumber}:1&to=${surahNumber}:7`;
}
