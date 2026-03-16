import { describe, it, expect } from "vitest";
import { dotProduct, searchEmbeddings, searchPageEmbeddings } from "../search";
import type { EmbeddingRecord, PageEmbeddingRecord } from "../storage";

describe("dotProduct", () => {
  it("computes dot product correctly", () => {
    expect(dotProduct([1, 0, 0], [0, 1, 0])).toBe(0);
    expect(dotProduct([1, 2, 3], [4, 5, 6])).toBe(32);
    expect(dotProduct([1, 0], [1, 0])).toBe(1);
  });

  it("handles normalized vectors", () => {
    const a = [0.6, 0.8];
    const b = [0.6, 0.8];
    expect(dotProduct(a, b)).toBeCloseTo(1.0);
  });
});

describe("searchEmbeddings", () => {
  const records: EmbeddingRecord[] = [
    { blockId: "a", embedding: [1, 0, 0], pageId: 1, blockUpdatedAt: 0, pageUpdatedAt: 0 },
    { blockId: "b", embedding: [0, 1, 0], pageId: 1, blockUpdatedAt: 0, pageUpdatedAt: 0 },
    { blockId: "c", embedding: [0.7, 0.7, 0], pageId: 2, blockUpdatedAt: 0, pageUpdatedAt: 0 },
  ];

  it("returns results sorted by similarity", () => {
    const results = searchEmbeddings([1, 0, 0], records, 10, 0);
    expect(results[0].blockId).toBe("a");
    expect(results[0].similarity).toBe(1);
    expect(results[1].blockId).toBe("c");
  });

  it("respects topK", () => {
    const results = searchEmbeddings([1, 0, 0], records, 1, 0);
    expect(results).toHaveLength(1);
    expect(results[0].blockId).toBe("a");
  });

  it("filters by threshold", () => {
    const results = searchEmbeddings([1, 0, 0], records, 10, 0.5);
    // "b" has similarity 0, "c" has 0.7, "a" has 1
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.blockId)).toEqual(["a", "c"]);
  });

  it("handles empty index", () => {
    const results = searchEmbeddings([1, 0, 0], [], 10, 0);
    expect(results).toHaveLength(0);
  });

  it("handles single result", () => {
    const results = searchEmbeddings([1, 0, 0], [records[0]], 10, 0);
    expect(results).toHaveLength(1);
  });
});

describe("searchPageEmbeddings", () => {
  const pages: PageEmbeddingRecord[] = [
    { pageId: 1, pageName: "Page A", embedding: [1, 0, 0], isJournal: false, blockCount: 5, timestamp: 0 },
    { pageId: 2, pageName: "Page B", embedding: [0, 1, 0], isJournal: true, blockCount: 3, timestamp: 0 },
    { pageId: 3, pageName: "Page C", embedding: [0.7, 0.7, 0], isJournal: false, blockCount: 2, timestamp: 0 },
  ];

  it("returns page results sorted by similarity", () => {
    const results = searchPageEmbeddings([1, 0, 0], pages, 10, 0);
    expect(results[0].pageName).toBe("Page A");
    expect(results[0].similarity).toBe(1);
    expect(results[1].pageName).toBe("Page C");
  });

  it("includes isJournal flag", () => {
    const results = searchPageEmbeddings([0, 1, 0], pages, 10, 0);
    expect(results[0].pageName).toBe("Page B");
    expect(results[0].isJournal).toBe(true);
  });

  it("respects topK and threshold", () => {
    const results = searchPageEmbeddings([1, 0, 0], pages, 1, 0.5);
    expect(results).toHaveLength(1);
    expect(results[0].pageName).toBe("Page A");
  });
});
