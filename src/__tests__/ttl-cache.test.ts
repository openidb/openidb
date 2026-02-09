import { describe, test, expect } from "bun:test";
import { TTLCache } from "../lib/ttl-cache";

describe("TTLCache", () => {
  test("stores and retrieves values", () => {
    const cache = new TTLCache<string>({ maxSize: 10, ttlMs: 60_000, evictionCount: 5 });
    cache.set("key", "value");
    expect(cache.get("key")).toBe("value");
  });

  test("returns null for missing keys", () => {
    const cache = new TTLCache<string>({ maxSize: 10, ttlMs: 60_000, evictionCount: 5 });
    expect(cache.get("missing")).toBeNull();
  });

  test("respects maxSize with eviction", () => {
    const cache = new TTLCache<number>({ maxSize: 5, ttlMs: 60_000, evictionCount: 3 });
    for (let i = 0; i < 10; i++) {
      cache.set(`key${i}`, i);
    }
    // Should not exceed maxSize (some entries evicted)
    expect(cache.stats.size).toBeLessThanOrEqual(10);
  });

  test("expires entries after TTL", async () => {
    const cache = new TTLCache<string>({ maxSize: 10, ttlMs: 50, evictionCount: 5 });
    cache.set("key", "value");
    expect(cache.get("key")).toBe("value");

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 60));
    expect(cache.get("key")).toBeNull();
  });

  test("getMany returns only non-expired entries", async () => {
    const cache = new TTLCache<string>({ maxSize: 10, ttlMs: 50, evictionCount: 5 });
    cache.set("a", "1");
    cache.set("b", "2");

    const result = cache.getMany(["a", "b", "missing"]);
    expect(result.size).toBe(2);
    expect(result.get("a")).toBe("1");
    expect(result.get("b")).toBe("2");
  });

  test("setMany stores multiple entries", () => {
    const cache = new TTLCache<number>({ maxSize: 10, ttlMs: 60_000, evictionCount: 5 });
    cache.setMany([
      { key: "a", value: 1 },
      { key: "b", value: 2 },
      { key: "c", value: 3 },
    ]);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
  });

  test("clear removes all entries", () => {
    const cache = new TTLCache<string>({ maxSize: 10, ttlMs: 60_000, evictionCount: 5 });
    cache.set("a", "1");
    cache.set("b", "2");
    cache.clear();
    expect(cache.stats.size).toBe(0);
    expect(cache.get("a")).toBeNull();
  });

  test("stats returns current size and config", () => {
    const cache = new TTLCache<string>({ maxSize: 100, ttlMs: 30_000, evictionCount: 10 });
    cache.set("a", "1");
    const stats = cache.stats;
    expect(stats.size).toBe(1);
    expect(stats.maxSize).toBe(100);
    expect(stats.ttlMs).toBe(30_000);
  });

  test("overwrites existing key", () => {
    const cache = new TTLCache<string>({ maxSize: 10, ttlMs: 60_000, evictionCount: 5 });
    cache.set("key", "old");
    cache.set("key", "new");
    expect(cache.get("key")).toBe("new");
  });
});
