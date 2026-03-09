import { describe, it, expect } from "vitest";
import { dotProduct, searchEmbeddings } from "../search";
import type { EmbeddingRecord } from "../storage";

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
    { blockId: "a", contextHashes: [], embedding: [1, 0, 0], pageId: 1, timestamp: 0 },
    { blockId: "b", contextHashes: [], embedding: [0, 1, 0], pageId: 1, timestamp: 0 },
    { blockId: "c", contextHashes: [], embedding: [0.7, 0.7, 0], pageId: 2, timestamp: 0 },
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
