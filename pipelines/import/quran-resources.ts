/**
 * Quran Resource Registry
 *
 * Fetches and normalizes available editions from upstream sources:
 * - fawazahmed0/quran-api — Quran translations (500+ editions)
 * - spa5k/tafsir_api — Quran tafsirs (27 editions)
 * - QUL (Tarteel AI) — Quran translations (193) + tafsirs (114)
 *
 * Provides metadata sync to populate QuranTranslation and QuranTafsir tables.
 */

import { prisma } from "../../src/db";

// CDN base URLs
const TRANSLATIONS_EDITIONS_URL =
  "https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1/editions.json";
const TAFSIRS_EDITIONS_URL =
  "https://cdn.jsdelivr.net/gh/spa5k/tafsir_api@main/tafsir/editions.json";
const TRANSLATION_CDN_BASE =
  "https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1/editions";
const TAFSIR_CDN_BASE =
  "https://cdn.jsdelivr.net/gh/spa5k/tafsir_api@main/tafsir";

// QUL (Tarteel AI) API
const QUL_API_BASE = "https://qul.tarteel.ai/api/v1";
const QUL_TRANSLATIONS_URL = `${QUL_API_BASE}/resources/translations`;
const QUL_TAFSIRS_URL = `${QUL_API_BASE}/resources/tafsirs`;

// Map full language names from fawazahmed0 / QUL editions to ISO 639-1 codes
const LANGUAGE_TO_ISO: Record<string, string> = {
  afar: "aa", albanian: "sq", amharic: "am", amazigh: "zgh", arabic: "ar",
  azerbaijani: "az", bengali: "bn", berber: "ber", bosnian: "bs",
  bulgarian: "bg", burmese: "my", chechen: "ce", chinese: "zh", czech: "cs",
  dari: "prs", divehi: "dv", dutch: "nl",
  english: "en", filipino: "fil", french: "fr", georgian: "ka", german: "de",
  gujarati: "gu", hausa: "ha", hebrew: "he", hindi: "hi",
  hungarian: "hu", igbo: "ig", indonesian: "id", italian: "it",
  japanese: "ja", javanese: "jv", kannada: "kn", kazakh: "kk",
  khmer: "km", korean: "ko", kurdish: "ku",
  kyrgyz: "ky", malay: "ms", malayalam: "ml", marathi: "mr",
  nepali: "ne", norwegian: "no", oromo: "om",
  pashto: "ps", persian: "fa", polish: "pl", portuguese: "pt",
  romanian: "ro", russian: "ru", serbian: "sr", sindhi: "sd",
  sinhala: "si", sinhalese: "si", somali: "so", spanish: "es",
  swahili: "sw", swedish: "sv", tajik: "tg", tamil: "ta", tatar: "tt",
  telugu: "te", thai: "th", turkish: "tr",
  uighur: "ug", uyghur: "ug", ukrainian: "uk", urdu: "ur",
  uzbek: "uz", vietnamese: "vi", yoruba: "yo",
};

function normalizeLanguageCode(lang: string): string {
  const lower = lang.toLowerCase();
  return LANGUAGE_TO_ISO[lower] || lower.slice(0, 2).toLowerCase();
}

// RTL languages
const RTL_LANGUAGES = new Set(["ar", "ur", "fa", "he", "ps", "sd", "dv", "ku", "ug"]);

// ============================================================================
// Translation Editions
// ============================================================================

export interface TranslationEdition {
  id: string;       // "eng-mustafakhattaba"
  language: string;  // ISO code: "en"
  name: string;      // Author/display name
  author: string | null;
  direction: "ltr" | "rtl";
  cdnUrl: string;
}

interface FawazEdition {
  name: string;
  author: string;
  language: string;
  direction: "ltr" | "rtl";
  source: string;
  comments: string;
  link?: string;
  linkmin?: string;
}

export async function fetchTranslationEditions(): Promise<TranslationEdition[]> {
  const response = await fetch(TRANSLATIONS_EDITIONS_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch translation editions: ${response.status}`);
  }

  const data: Record<string, FawazEdition> = await response.json();
  const editions: TranslationEdition[] = [];

  for (const [, edition] of Object.entries(data)) {
    const id = edition.name; // e.g. "eng-mustafakhattaba"
    const isoLang = normalizeLanguageCode(edition.language);
    editions.push({
      id,
      language: isoLang,
      name: edition.author || edition.name,
      author: edition.author || null,
      direction: RTL_LANGUAGES.has(isoLang) ? "rtl" : "ltr",
      cdnUrl: `${TRANSLATION_CDN_BASE}/${id}.json`,
    });
  }

  return editions;
}

export async function syncTranslationMetadata(
  editions: TranslationEdition[]
): Promise<number> {
  let synced = 0;
  // Batch upsert in chunks
  const BATCH = 50;
  for (let i = 0; i < editions.length; i += BATCH) {
    const batch = editions.slice(i, i + BATCH);
    for (const ed of batch) {
      await prisma.quranTranslation.upsert({
        where: { id: ed.id },
        update: {
          language: ed.language,
          name: ed.name,
          author: ed.author,
          direction: ed.direction,
        },
        create: {
          id: ed.id,
          language: ed.language,
          name: ed.name,
          author: ed.author,
          source: "fawazahmed0",
          direction: ed.direction,
        },
      });
      synced++;
    }
  }
  return synced;
}

// ============================================================================
// Tafsir Editions
// ============================================================================

export interface TafsirEdition {
  id: string;       // "ar-tafsir-ibn-kathir"
  slug: string;     // same as id for spa5k
  language: string;  // ISO code: "ar", "en", etc.
  name: string;
  author: string | null;
  direction: "ltr" | "rtl";
  sourceAttribution: string; // "quran.com" or "altafsir.com"
}

interface Spa5kEdition {
  id: number;
  author_name: string;
  name: string;
  language_name: string;
  slug: string;
  source: string;
}

// Map spa5k language names to ISO codes
const TAFSIR_LANG_MAP: Record<string, string> = {
  arabic: "ar", english: "en", bengali: "bn", urdu: "ur",
  russian: "ru", kurdish: "ku",
};

export async function fetchTafsirEditions(): Promise<TafsirEdition[]> {
  const response = await fetch(TAFSIRS_EDITIONS_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch tafsir editions: ${response.status}`);
  }

  const data: Spa5kEdition[] = await response.json();
  return data.map((t) => {
    const isoLang = TAFSIR_LANG_MAP[t.language_name.toLowerCase()] || t.language_name.slice(0, 2).toLowerCase();
    return {
      id: t.slug,
      slug: t.slug,
      language: isoLang,
      name: t.name,
      author: t.author_name || null,
      direction: RTL_LANGUAGES.has(isoLang) ? "rtl" : "ltr",
      sourceAttribution: t.source,
    };
  });
}

export async function syncTafsirMetadata(
  editions: TafsirEdition[]
): Promise<number> {
  let synced = 0;
  for (const ed of editions) {
    await prisma.quranTafsir.upsert({
      where: { id: ed.id },
      update: {
        language: ed.language,
        name: ed.name,
        author: ed.author,
        direction: ed.direction,
      },
      create: {
        id: ed.id,
        language: ed.language,
        name: ed.name,
        author: ed.author,
        source: "spa5k-tafsir",
        direction: ed.direction,
      },
    });
    synced++;
  }
  return synced;
}

// ============================================================================
// QUL (Tarteel AI) Editions
// ============================================================================

interface QulResourceEdition {
  id: number;
  name: string;
  author_name: string;
  language: string;         // e.g. "english", "uighur, uyghur", "sinhala, sinhalese"
  language_name?: string;   // Some endpoints use this instead
  slug: string | null;
  translated_name?: { name: string; locale: string } | null;
}

/**
 * Normalize QUL language name (may contain comma-separated aliases)
 * e.g. "uighur, uyghur" -> "ug", "sinhala, sinhalese" -> "si"
 */
function normalizeQulLanguage(langName: string | null | undefined): string {
  if (!langName) return "unknown";
  // Try each comma-separated name
  for (const part of langName.split(",")) {
    const trimmed = part.trim().toLowerCase();
    const iso = LANGUAGE_TO_ISO[trimmed];
    if (iso) return iso;
  }
  // Fallback: first two chars of first name
  return langName.trim().slice(0, 2).toLowerCase();
}

export interface QulTranslationEdition {
  id: string;          // "qul-{resource_id}"
  resourceId: number;  // Original QUL numeric ID
  language: string;    // ISO code
  name: string;
  author: string | null;
  direction: "ltr" | "rtl";
}

export interface QulTafsirEdition {
  id: string;          // "qul-{resource_id}"
  resourceId: number;
  language: string;
  name: string;
  author: string | null;
  direction: "ltr" | "rtl";
}

export async function fetchQulTranslationEditions(): Promise<QulTranslationEdition[]> {
  const response = await fetch(QUL_TRANSLATIONS_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch QUL translation editions: ${response.status}`);
  }

  const data: { translations: QulResourceEdition[] } = await response.json();
  return data.translations.map((t) => {
    const isoLang = normalizeQulLanguage(t.language || t.language_name);
    return {
      id: `qul-${t.id}`,
      resourceId: t.id,
      language: isoLang,
      name: t.name,
      author: t.author_name || null,
      direction: RTL_LANGUAGES.has(isoLang) ? "rtl" : "ltr",
    };
  });
}

export async function fetchQulTafsirEditions(): Promise<QulTafsirEdition[]> {
  const response = await fetch(QUL_TAFSIRS_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch QUL tafsir editions: ${response.status}`);
  }

  const data: { tafsirs: QulResourceEdition[] } = await response.json();
  return data.tafsirs.map((t) => {
    const isoLang = normalizeQulLanguage(t.language || t.language_name);
    return {
      id: `qul-${t.id}`,
      resourceId: t.id,
      language: isoLang,
      name: t.name,
      author: t.author_name || null,
      direction: RTL_LANGUAGES.has(isoLang) ? "rtl" : "ltr",
    };
  });
}

export async function syncQulTranslationMetadata(
  editions: QulTranslationEdition[]
): Promise<number> {
  let synced = 0;
  const BATCH = 50;
  for (let i = 0; i < editions.length; i += BATCH) {
    const batch = editions.slice(i, i + BATCH);
    for (const ed of batch) {
      await prisma.quranTranslation.upsert({
        where: { id: ed.id },
        update: {
          language: ed.language,
          name: ed.name,
          author: ed.author,
          direction: ed.direction,
        },
        create: {
          id: ed.id,
          language: ed.language,
          name: ed.name,
          author: ed.author,
          source: "qul",
          direction: ed.direction,
        },
      });
      synced++;
    }
  }
  return synced;
}

export async function syncQulTafsirMetadata(
  editions: QulTafsirEdition[]
): Promise<number> {
  let synced = 0;
  for (const ed of editions) {
    await prisma.quranTafsir.upsert({
      where: { id: ed.id },
      update: {
        language: ed.language,
        name: ed.name,
        author: ed.author,
        direction: ed.direction,
      },
      create: {
        id: ed.id,
        language: ed.language,
        name: ed.name,
        author: ed.author,
        source: "qul",
        direction: ed.direction,
      },
    });
    synced++;
  }
  return synced;
}

// Re-export CDN base for use in import scripts
export { TRANSLATION_CDN_BASE, TAFSIR_CDN_BASE, QUL_API_BASE };
