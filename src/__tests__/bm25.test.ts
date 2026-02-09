import { describe, test, expect } from "bun:test";
import { normalizeBM25Score, BM25_K1, BM25_B } from "../search/bm25";

describe("normalizeBM25Score", () => {
  test("returns 0 for score 0", () => {
    expect(normalizeBM25Score(0)).toBe(0);
  });

  test("returns 0 for negative scores", () => {
    expect(normalizeBM25Score(-5)).toBe(0);
  });

  test("returns 0.5 when score equals k (default k=5)", () => {
    expect(normalizeBM25Score(5)).toBeCloseTo(0.5, 10);
  });

  test("approaches 1 for very large scores", () => {
    expect(normalizeBM25Score(10000)).toBeGreaterThan(0.99);
  });

  test("returns correct value for typical BM25 scores", () => {
    // score=10, k=5: 10/(10+5) = 2/3
    expect(normalizeBM25Score(10)).toBeCloseTo(2 / 3, 5);
  });

  test("respects custom k parameter", () => {
    // score=10, k=10: 10/(10+10) = 0.5
    expect(normalizeBM25Score(10, 10)).toBeCloseTo(0.5, 10);
  });

  test("output is always between 0 and 1 for positive scores", () => {
    for (const score of [0.001, 0.1, 1, 5, 10, 50, 100, 1000]) {
      const result = normalizeBM25Score(score);
      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThan(1);
    }
  });

  test("is monotonically increasing", () => {
    let prev = 0;
    for (const score of [0, 1, 2, 5, 10, 20, 50, 100]) {
      const result = normalizeBM25Score(score);
      expect(result).toBeGreaterThanOrEqual(prev);
      prev = result;
    }
  });
});

describe("BM25 constants", () => {
  test("K1 is Elasticsearch default (1.2)", () => {
    expect(BM25_K1).toBe(1.2);
  });

  test("B is Elasticsearch default (0.75)", () => {
    expect(BM25_B).toBe(0.75);
  });
});
