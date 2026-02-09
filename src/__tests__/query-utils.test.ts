import { describe, test, expect } from "bun:test";
import {
  prepareSearchTerms,
  parseSearchQuery,
  hasQuotedPhrases,
  shouldSkipSemanticSearch,
  isArabicQuery,
  getSearchStrategy,
  getDynamicSimilarityThreshold,
} from "../routes/search/query-utils";

// --- isArabicQuery ---

describe("isArabicQuery", () => {
  test("detects Arabic characters", () => {
    expect(isArabicQuery("بسم الله")).toBe(true);
  });

  test("detects mixed Arabic-English", () => {
    expect(isArabicQuery("search بسم")).toBe(true);
  });

  test("returns false for pure English", () => {
    expect(isArabicQuery("hello world")).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(isArabicQuery("")).toBe(false);
  });

  test("detects Arabic Supplement range", () => {
    // U+0750-077F
    expect(isArabicQuery("\u0750")).toBe(true);
  });
});

// --- getSearchStrategy ---

describe("getSearchStrategy", () => {
  test("returns hybrid for Arabic queries", () => {
    expect(getSearchStrategy("الرحمن الرحيم")).toBe("hybrid");
  });

  test("returns semantic_only for English queries", () => {
    expect(getSearchStrategy("mercy of God")).toBe("semantic_only");
  });
});

// --- hasQuotedPhrases ---

describe("hasQuotedPhrases", () => {
  test("detects regular double quotes", () => {
    expect(hasQuotedPhrases('"exact match"')).toBe(true);
  });

  test("detects guillemets", () => {
    expect(hasQuotedPhrases("\u00ABexact match\u00BB")).toBe(true);
  });

  test("detects Unicode smart quotes", () => {
    expect(hasQuotedPhrases("\u201Cexact match\u201D")).toBe(true);
  });

  test("returns false for no quotes", () => {
    expect(hasQuotedPhrases("no quotes here")).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(hasQuotedPhrases("")).toBe(false);
  });
});

// --- shouldSkipSemanticSearch ---

describe("shouldSkipSemanticSearch", () => {
  test("skips for quoted phrases", () => {
    expect(shouldSkipSemanticSearch('"بسم الله"')).toBe(true);
  });

  test("skips for very short queries (< 4 chars after normalization)", () => {
    // "بس" = 2 Arabic chars, below MIN_CHARS_FOR_SEMANTIC=4
    expect(shouldSkipSemanticSearch("بس")).toBe(true);
  });

  test("does not skip for longer queries", () => {
    expect(shouldSkipSemanticSearch("بسم الله الرحمن")).toBe(false);
  });
});

// --- parseSearchQuery ---

describe("parseSearchQuery", () => {
  test("extracts terms from simple query", () => {
    const result = parseSearchQuery("hello world");
    expect(result.terms.length).toBeGreaterThan(0);
    expect(result.phrases).toEqual([]);
  });

  test("extracts quoted phrase", () => {
    const result = parseSearchQuery('"hello world"');
    expect(result.phrases).toHaveLength(1);
    expect(result.phrases[0]).toContain("hello");
    expect(result.phrases[0]).toContain("world");
  });

  test("extracts both phrases and terms", () => {
    const result = parseSearchQuery('free text "exact phrase" more text');
    expect(result.phrases.length).toBeGreaterThanOrEqual(1);
    expect(result.terms.length).toBeGreaterThanOrEqual(1);
  });

  test("handles Arabic text with quotes", () => {
    const result = parseSearchQuery('"بسم الله" الرحمن');
    expect(result.phrases.length).toBeGreaterThanOrEqual(1);
  });

  test("treats single-word quoted text as term, not phrase", () => {
    const result = parseSearchQuery('"hello"');
    // A single word in quotes should become a term, not a phrase
    expect(result.phrases).toHaveLength(0);
    expect(result.terms.length).toBeGreaterThanOrEqual(1);
  });

  test("handles empty string", () => {
    const result = parseSearchQuery("");
    expect(result.terms).toEqual([]);
    expect(result.phrases).toEqual([]);
  });
});

// --- prepareSearchTerms ---

describe("prepareSearchTerms", () => {
  test("splits whitespace-separated terms", () => {
    const terms = prepareSearchTerms("hello world");
    expect(terms.length).toBe(2);
  });

  test("filters empty strings", () => {
    const terms = prepareSearchTerms("  spaced  out  ");
    expect(terms.every((t) => t.length > 0)).toBe(true);
  });

  test("strips non-Arabic non-word characters", () => {
    const terms = prepareSearchTerms("hello! world?");
    expect(terms).toEqual(["hello", "world"]);
  });

  test("preserves Arabic characters", () => {
    const terms = prepareSearchTerms("بسم الله");
    expect(terms.length).toBeGreaterThan(0);
    expect(terms.some((t) => /[\u0600-\u06FF]/.test(t))).toBe(true);
  });

  test("returns empty array for whitespace-only input", () => {
    expect(prepareSearchTerms("   ")).toEqual([]);
  });
});

// --- getDynamicSimilarityThreshold ---

describe("getDynamicSimilarityThreshold", () => {
  test("returns higher threshold for very short queries (1-3 chars)", () => {
    const threshold = getDynamicSimilarityThreshold("بس", 0.2);
    expect(threshold).toBeGreaterThanOrEqual(0.40);
  });

  test("returns base threshold for long queries", () => {
    const base = 0.25;
    const threshold = getDynamicSimilarityThreshold("this is a very long search query with many words", base);
    expect(threshold).toBe(base);
  });

  test("never returns below base threshold", () => {
    const base = 0.6;
    const threshold = getDynamicSimilarityThreshold("ab", base);
    expect(threshold).toBeGreaterThanOrEqual(base);
  });

  test("single-word queries clamp effective chars to 6", () => {
    // A long single word should be clamped to 6 effective chars
    // maxChars=6 → threshold=0.40
    const threshold = getDynamicSimilarityThreshold("abcdefghijklmnop", 0.2);
    expect(threshold).toBeGreaterThanOrEqual(0.30);
  });
});
