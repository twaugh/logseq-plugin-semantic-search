import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import {
  putEmbeddings,
  getEmbedding,
  getAllEmbeddings,
  deleteEmbeddings,
  clearAllEmbeddings,
  putPageEmbeddings,
  getAllPageEmbeddings,
  clearAllPageEmbeddings,
  getMetadata,
  setMetadata,
  getEmbeddingCount,
  setGraphName,
} from "../storage";

beforeEach(async () => {
  setGraphName("test-graph");
  // Clear databases between tests
  const dbs = await indexedDB.databases();
  for (const db of dbs) {
    if (db.name) indexedDB.deleteDatabase(db.name);
  }
});

describe("embeddings CRUD", () => {
  it("stores and retrieves embeddings", async () => {
    const record = {
      blockId: "uuid-1",
      blockUpdatedAt: 1000,
      pageUpdatedAt: 2000,
      embedding: [0.1, 0.2, 0.3],
      pageId: 1,
    };
    await putEmbeddings([record]);
    const result = await getEmbedding("uuid-1");
    expect(result).toBeDefined();
    expect(result!.blockUpdatedAt).toBe(1000);
    expect(result!.pageUpdatedAt).toBe(2000);
    expect(result!.embedding).toEqual([0.1, 0.2, 0.3]);
  });

  it("returns undefined for missing blockId", async () => {
    const result = await getEmbedding("nonexistent");
    expect(result).toBeUndefined();
  });

  it("gets all embeddings", async () => {
    await putEmbeddings([
      { blockId: "a", embedding: [1], pageId: 1, blockUpdatedAt: 0, pageUpdatedAt: 0 },
      { blockId: "b", embedding: [2], pageId: 1, blockUpdatedAt: 0, pageUpdatedAt: 0 },
    ]);
    const all = await getAllEmbeddings();
    expect(all).toHaveLength(2);
  });

  it("deletes specific embeddings", async () => {
    await putEmbeddings([
      { blockId: "a", embedding: [1], pageId: 1, blockUpdatedAt: 0, pageUpdatedAt: 0 },
      { blockId: "b", embedding: [2], pageId: 1, blockUpdatedAt: 0, pageUpdatedAt: 0 },
    ]);
    await deleteEmbeddings(["a"]);
    const all = await getAllEmbeddings();
    expect(all).toHaveLength(1);
    expect(all[0].blockId).toBe("b");
  });

  it("clears all embeddings", async () => {
    await putEmbeddings([
      { blockId: "a", embedding: [1], pageId: 1, blockUpdatedAt: 0, pageUpdatedAt: 0 },
    ]);
    await clearAllEmbeddings();
    const count = await getEmbeddingCount();
    expect(count).toBe(0);
  });

  it("counts embeddings", async () => {
    await putEmbeddings([
      { blockId: "a", embedding: [1], pageId: 1, blockUpdatedAt: 0, pageUpdatedAt: 0 },
      { blockId: "b", embedding: [2], pageId: 1, blockUpdatedAt: 0, pageUpdatedAt: 0 },
      { blockId: "c", embedding: [3], pageId: 2, blockUpdatedAt: 0, pageUpdatedAt: 0 },
    ]);
    expect(await getEmbeddingCount()).toBe(3);
  });
});

describe("page embeddings CRUD", () => {
  it("stores and retrieves page embeddings", async () => {
    await putPageEmbeddings([
      { pageId: 1, pageName: "Page A", embedding: [0.1, 0.2], isJournal: false, blockCount: 5, timestamp: Date.now() },
      { pageId: 2, pageName: "Page B", embedding: [0.3, 0.4], isJournal: true, blockCount: 3, timestamp: Date.now() },
    ]);
    const all = await getAllPageEmbeddings();
    expect(all).toHaveLength(2);
    expect(all[0].pageName).toBe("Page A");
    expect(all[1].isJournal).toBe(true);
  });

  it("clears all page embeddings", async () => {
    await putPageEmbeddings([
      { pageId: 1, pageName: "Page A", embedding: [0.1], isJournal: false, blockCount: 2, timestamp: 0 },
    ]);
    await clearAllPageEmbeddings();
    const all = await getAllPageEmbeddings();
    expect(all).toHaveLength(0);
  });
});

describe("metadata", () => {
  it("stores and retrieves metadata", async () => {
    await setMetadata("model", "nomic-embed-text");
    const value = await getMetadata("model");
    expect(value).toBe("nomic-embed-text");
  });

  it("returns undefined for missing key", async () => {
    const value = await getMetadata("nonexistent");
    expect(value).toBeUndefined();
  });

  it("overwrites existing metadata", async () => {
    await setMetadata("model", "old");
    await setMetadata("model", "new");
    expect(await getMetadata("model")).toBe("new");
  });
});
