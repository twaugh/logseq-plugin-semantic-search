import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @logseq/libs
const mockGetBlock = vi.fn();
const mockGetPage = vi.fn();

const mockLogseq = {
  settings: {
    apiEndpoint: "http://localhost:11434",
    apiFormat: "ollama",
    embeddingModel: "nomic-embed-text",
    batchSize: 2,
    topK: 20,
    minBlockLength: 10,
    autoIndexOnLoad: true,
  },
  DB: {
    datascriptQuery: vi.fn(),
  },
  Editor: {
    getBlock: mockGetBlock,
    getPage: mockGetPage,
  },
  UI: {
    showMsg: vi.fn(),
  },
};
vi.stubGlobal("logseq", mockLogseq);

// Mock embedTexts
vi.mock("../embeddings", () => ({
  embedTexts: vi.fn(),
}));

import { indexBlocks, indexingState, cancelIndexing } from "../indexer";
import { embedTexts } from "../embeddings";
import { getAllEmbeddings, setMetadata } from "../storage";

const mockEmbedTexts = vi.mocked(embedTexts);

beforeEach(async () => {
  vi.clearAllMocks();
  indexingState.status = "idle";
  indexingState.progress = { done: 0, total: 0 };

  // Default: getPage returns a simple page, getBlock returns null (no parent chain)
  mockGetPage.mockResolvedValue({ originalName: "Test Page", properties: {} });
  mockGetBlock.mockResolvedValue(null);

  // Clear IndexedDB
  const dbs = await indexedDB.databases();
  for (const db of dbs) {
    if (db.name) indexedDB.deleteDatabase(db.name);
  }
});

describe("indexBlocks", () => {
  it("skips unchanged blocks", async () => {
    mockLogseq.DB.datascriptQuery.mockResolvedValue([
      [{ id: 1, uuid: "u1", content: "Hello world this is a test block", page: { id: 10 }, parent: { id: 10 } }],
    ]);

    mockEmbedTexts.mockResolvedValue([[0.1, 0.2, 0.3]]);

    // First index
    await indexBlocks();
    expect(mockEmbedTexts).toHaveBeenCalledTimes(1);

    // Second index - same content, should skip
    mockEmbedTexts.mockClear();
    await indexBlocks();
    expect(mockEmbedTexts).not.toHaveBeenCalled();
  });

  it("re-embeds changed blocks", async () => {
    mockLogseq.DB.datascriptQuery.mockResolvedValueOnce([
      [{ id: 1, uuid: "u1", content: "Hello world this is a test block", page: { id: 10 }, parent: { id: 10 } }],
    ]);
    mockEmbedTexts.mockResolvedValue([[0.1, 0.2, 0.3]]);

    await indexBlocks();

    // Change content
    mockLogseq.DB.datascriptQuery.mockResolvedValueOnce([
      [{ id: 1, uuid: "u1", content: "Changed content that is different", page: { id: 10 }, parent: { id: 10 } }],
    ]);
    mockEmbedTexts.mockClear();
    mockEmbedTexts.mockResolvedValue([[0.4, 0.5, 0.6]]);

    await indexBlocks();
    expect(mockEmbedTexts).toHaveBeenCalledTimes(1);
  });

  it("batches correctly", async () => {
    // batchSize is 2
    mockLogseq.DB.datascriptQuery.mockResolvedValue([
      [{ id: 1, uuid: "u1", content: "First block with enough content", page: { id: 10 }, parent: { id: 10 } }],
      [{ id: 2, uuid: "u2", content: "Second block with enough content", page: { id: 10 }, parent: { id: 10 } }],
      [{ id: 3, uuid: "u3", content: "Third block with enough content", page: { id: 11 }, parent: { id: 11 } }],
    ]);

    mockEmbedTexts
      .mockResolvedValueOnce([[0.1], [0.2]])  // batch 1
      .mockResolvedValueOnce([[0.3]]);          // batch 2

    await indexBlocks();

    expect(mockEmbedTexts).toHaveBeenCalledTimes(2);
    const stored = await getAllEmbeddings();
    expect(stored).toHaveLength(3);
  });

  it("tracks progress", async () => {
    mockLogseq.DB.datascriptQuery.mockResolvedValue([
      [{ id: 1, uuid: "u1", content: "Block one with enough content", page: { id: 10 }, parent: { id: 10 } }],
      [{ id: 2, uuid: "u2", content: "Block two with enough content", page: { id: 10 }, parent: { id: 10 } }],
    ]);

    mockEmbedTexts.mockResolvedValue([[0.1], [0.2]]);

    const progress: Array<{ done: number; total: number }> = [];
    await indexBlocks((done, total) => progress.push({ done, total }));

    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1].done).toBe(2);
  });

  it("clears embeddings on model change", async () => {
    mockLogseq.DB.datascriptQuery.mockResolvedValue([
      [{ id: 1, uuid: "u1", content: "Hello world this is a test block", page: { id: 10 }, parent: { id: 10 } }],
    ]);
    mockEmbedTexts.mockResolvedValue([[0.1, 0.2]]);

    await indexBlocks();
    const count1 = (await getAllEmbeddings()).length;
    expect(count1).toBe(1);

    // Simulate model change via stored metadata
    await setMetadata("model", "different-model");

    mockEmbedTexts.mockClear();
    mockEmbedTexts.mockResolvedValue([[0.3, 0.4]]);

    await indexBlocks();
    expect(mockEmbedTexts).toHaveBeenCalled();
  });

  it("embeds with page and ancestor context", async () => {
    // Block 5 is child of block 4, which is a top-level block on page 10
    mockLogseq.DB.datascriptQuery.mockResolvedValue([
      [{ id: 5, uuid: "u5", content: "Discussed timeline and budget", page: { id: 10 }, parent: { id: 4 } }],
    ]);

    mockGetPage.mockResolvedValue({
      originalName: "Meeting Notes",
      properties: { tags: ["project-x", "planning"] },
    });

    mockGetBlock.mockImplementation(async (id: number) => {
      if (id === 4) return { id: 4, content: "## Project X Updates", parent: { id: 10 } };
      return null;
    });

    mockEmbedTexts.mockResolvedValue([[0.1, 0.2, 0.3]]);

    await indexBlocks();

    expect(mockEmbedTexts).toHaveBeenCalledTimes(1);
    const embeddedText = mockEmbedTexts.mock.calls[0][0][0];
    expect(embeddedText).toContain("[Page: Meeting Notes]");
    expect(embeddedText).toContain("[tags: project-x, planning]");
    expect(embeddedText).toContain("> Project X Updates");
    expect(embeddedText).toContain("Discussed timeline and budget");
  });

  it("caches page and parent lookups across blocks", async () => {
    // Two sibling blocks under the same parent on the same page
    mockLogseq.DB.datascriptQuery.mockResolvedValue([
      [{ id: 5, uuid: "u5", content: "First sibling block content", page: { id: 10 }, parent: { id: 4 } }],
      [{ id: 6, uuid: "u6", content: "Second sibling block content", page: { id: 10 }, parent: { id: 4 } }],
    ]);

    mockGetPage.mockResolvedValue({ originalName: "Page", properties: {} });
    mockGetBlock.mockImplementation(async (id: number) => {
      if (id === 4) return { id: 4, content: "Parent block", parent: { id: 10 } };
      return null;
    });

    mockEmbedTexts.mockResolvedValue([[0.1], [0.2]]);

    await indexBlocks();

    // getPage should be called once (cached for second block)
    expect(mockGetPage).toHaveBeenCalledTimes(1);
    // getBlock(4) called twice: once to get content (cached), once more for parent pointer on second block
    // But content is cached so the parent walk still needs the block for the parent pointer
    expect(mockGetBlock).toHaveBeenCalledWith(4);
  });

  it("handles cancellation", async () => {
    mockLogseq.DB.datascriptQuery.mockResolvedValue([
      [{ id: 1, uuid: "u1", content: "Block one with enough content", page: { id: 10 }, parent: { id: 10 } }],
    ]);

    mockEmbedTexts.mockImplementation(async () => {
      cancelIndexing();
      throw new DOMException("Aborted", "AbortError");
    });

    // Should not throw
    await indexBlocks();
    expect(indexingState.status).toBe("idle");
  });
});
