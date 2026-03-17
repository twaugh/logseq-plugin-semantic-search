import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLogseq = {
  settings: {
    apiEndpoint: "http://localhost:11434",
    apiFormat: "ollama",
    embeddingModel: "nomic-embed-text",
    batchSize: 2,
    topK: 20,
    autoIndexOnLoad: true,
    pageProperties: "tags, alias, category, type, description, summary, author, topic, area, project, status, priority, platform",
    blockProperties: "type, status, priority, tags, source, url, author",
  },
  DB: {
    datascriptQuery: vi.fn(),
  },
  Editor: {
    getBlock: vi.fn(),
    getPage: vi.fn(),
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
import { getAllEmbeddings, setMetadata, setGraphName } from "../storage";

const mockEmbedTexts = vi.mocked(embedTexts);

function mockQueries(blocks: any[][], pages: any[][]) {
  mockLogseq.DB.datascriptQuery
    .mockResolvedValueOnce(blocks)   // block query (all blocks)
    .mockResolvedValueOnce(pages);   // page query
}

const defaultPage = { id: 10, name: "test-page", originalName: "Test Page", properties: {}, "updated-at": 1000 };

beforeEach(async () => {
  vi.clearAllMocks();
  indexingState.status = "idle";
  indexingState.progress = { done: 0, total: 0 };
  setGraphName("test-graph");

  // Clear IndexedDB
  const dbs = await indexedDB.databases();
  for (const db of dbs) {
    if (db.name) indexedDB.deleteDatabase(db.name);
  }
});

describe("indexBlocks", () => {
  it("skips unchanged blocks", async () => {
    const blocks = [
      [{ id: 1, uuid: "u1", content: "Hello world this is a test block", page: { id: 10 }, parent: { id: 10 }, "updated-at": 1000 }],
    ];
    const pages = [[defaultPage]];

    mockQueries(blocks, pages);
    mockEmbedTexts.mockResolvedValue([[0.1, 0.2, 0.3]]);

    // First index
    await indexBlocks();
    expect(mockEmbedTexts).toHaveBeenCalledTimes(1);

    // Second index - same timestamps, should skip
    mockEmbedTexts.mockClear();
    mockQueries(blocks, pages);
    await indexBlocks();
    expect(mockEmbedTexts).not.toHaveBeenCalled();
  });

  it("re-embeds changed blocks", async () => {
    const pages = [[defaultPage]];

    mockQueries(
      [[{ id: 1, uuid: "u1", content: "Hello world this is a test block", page: { id: 10 }, parent: { id: 10 }, "updated-at": 1000 }]],
      pages,
    );
    mockEmbedTexts.mockResolvedValue([[0.1, 0.2, 0.3]]);

    await indexBlocks();

    // Change content — updated-at changes
    mockQueries(
      [[{ id: 1, uuid: "u1", content: "Changed content that is different", page: { id: 10 }, parent: { id: 10 }, "updated-at": 2000 }]],
      pages,
    );
    mockEmbedTexts.mockClear();
    mockEmbedTexts.mockResolvedValue([[0.4, 0.5, 0.6]]);

    await indexBlocks();
    expect(mockEmbedTexts).toHaveBeenCalledTimes(1);
  });

  it("batches correctly", async () => {
    // batchSize is 2
    mockQueries(
      [
        [{ id: 1, uuid: "u1", content: "First block with enough content", page: { id: 10 }, parent: { id: 10 }, "updated-at": 1000 }],
        [{ id: 2, uuid: "u2", content: "Second block with enough content", page: { id: 10 }, parent: { id: 10 }, "updated-at": 1000 }],
        [{ id: 3, uuid: "u3", content: "Third block with enough content", page: { id: 11 }, parent: { id: 11 }, "updated-at": 1000 }],
      ],
      [[defaultPage], [{ id: 11, name: "page-2", originalName: "Page 2", properties: {}, "updated-at": 1000 }]],
    );

    mockEmbedTexts
      .mockResolvedValueOnce([[0.1], [0.2]])  // batch 1
      .mockResolvedValueOnce([[0.3]]);          // batch 2

    await indexBlocks();

    expect(mockEmbedTexts).toHaveBeenCalledTimes(2);
    const stored = await getAllEmbeddings();
    expect(stored).toHaveLength(3);
  });

  it("tracks progress", async () => {
    mockQueries(
      [
        [{ id: 1, uuid: "u1", content: "Block one with enough content", page: { id: 10 }, parent: { id: 10 }, "updated-at": 1000 }],
        [{ id: 2, uuid: "u2", content: "Block two with enough content", page: { id: 10 }, parent: { id: 10 }, "updated-at": 1000 }],
      ],
      [[defaultPage]],
    );

    mockEmbedTexts.mockResolvedValue([[0.1], [0.2]]);

    const progress: Array<{ done: number; total: number }> = [];
    await indexBlocks((done, total) => progress.push({ done, total }));

    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1].done).toBe(2);
  });

  it("clears embeddings on model change", async () => {
    const blocks = [
      [{ id: 1, uuid: "u1", content: "Hello world this is a test block", page: { id: 10 }, parent: { id: 10 }, "updated-at": 1000 }],
    ];
    const pages = [[defaultPage]];

    mockQueries(blocks, pages);
    mockEmbedTexts.mockResolvedValue([[0.1, 0.2]]);

    await indexBlocks();
    const count1 = (await getAllEmbeddings()).length;
    expect(count1).toBe(1);

    // Simulate model change via stored metadata
    await setMetadata("model", "different-model");

    mockQueries(blocks, pages);
    mockEmbedTexts.mockClear();
    mockEmbedTexts.mockResolvedValue([[0.3, 0.4]]);

    await indexBlocks();
    expect(mockEmbedTexts).toHaveBeenCalled();
  });

  it("embeds with page and ancestor context", async () => {
    // Block 5 is child of block 4, which is a top-level block on page 10
    const meetingPage = {
      id: 10,
      name: "meeting-notes",
      originalName: "Meeting Notes",
      properties: { tags: ["project-x", "planning"] },
      "updated-at": 1000,
    };

    mockQueries(
      [
        [{ id: 4, uuid: "u4", content: "## Project X Updates", page: { id: 10 }, parent: { id: 10 }, "updated-at": 1000 }],
        [{ id: 5, uuid: "u5", content: "Discussed timeline and budget", page: { id: 10 }, parent: { id: 4 }, "updated-at": 1000 }],
      ],
      [[meetingPage]],
    );

    mockEmbedTexts.mockResolvedValue([[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]);

    await indexBlocks();

    expect(mockEmbedTexts).toHaveBeenCalledTimes(1);
    const call = mockEmbedTexts.mock.calls[0];
    const texts = call[0];

    // Find the child block's embedding text (4 words, so short-block heuristic applies)
    const childText = texts.find((t: string) => t.includes("Discussed timeline and budget"));
    expect(childText).toBeDefined();
    // Short block: parent prepended before separator
    expect(childText).toContain("Project X Updates > Discussed timeline and budget");
    // Context section follows
    expect(childText).toContain("--- Context ---");
    expect(childText).toContain("[Page: Meeting Notes]");
    expect(childText).toContain("tags: project-x, planning");
    // Order: block content before context separator, page/props after
    const sepIndex = childText!.indexOf("--- Context ---");
    expect(childText!.indexOf("Project X Updates > Discussed timeline and budget")).toBeLessThan(sepIndex);
    expect(childText!.indexOf("[Page: Meeting Notes]")).toBeGreaterThan(sepIndex);
    expect(childText!.indexOf("tags: project-x, planning")).toBeGreaterThan(sepIndex);
  });

  it("uses short-block heuristic for blocks under 5 words", async () => {
    // Grandparent -> Parent -> short child
    mockQueries(
      [
        [{ id: 1, uuid: "u1", content: "Logistics", page: { id: 10 }, parent: { id: 10 }, "updated-at": 1000 }],
        [{ id: 2, uuid: "u2", content: "There are concerns about", page: { id: 10 }, parent: { id: 1 }, "updated-at": 1000 }],
        [{ id: 3, uuid: "u3", content: "security", page: { id: 10 }, parent: { id: 2 }, "updated-at": 1000 }],
      ],
      [[{ id: 10, name: "project", originalName: "Project Architecture", properties: {}, "updated-at": 1000 }]],
    );

    mockEmbedTexts
      .mockResolvedValueOnce([[0.1], [0.2]])
      .mockResolvedValueOnce([[0.3]]);

    await indexBlocks();

    const allTexts = mockEmbedTexts.mock.calls.flatMap((call: any) => call[0]);
    const shortBlockText = allTexts.find((t: string) => t.includes("security"));
    expect(shortBlockText).toBeDefined();
    // Short block gets parent prepended
    expect(shortBlockText).toContain("There are concerns about > security");
    // Grandparent goes to context
    expect(shortBlockText).toContain("> Logistics");
    // Immediate parent is NOT in context as ancestor
    const sepIndex = shortBlockText!.indexOf("--- Context ---");
    const contextSection = shortBlockText!.slice(sepIndex);
    expect(contextSection).not.toContain("> There are concerns about");
    // Order: combined block+parent before separator, page and grandparent after
    expect(shortBlockText!.indexOf("There are concerns about > security")).toBeLessThan(sepIndex);
    expect(contextSection).toContain("[Page: Project Architecture]");
    expect(contextSection).toContain("> Logistics");
  });

  it("does not use short-block heuristic for top-level blocks", async () => {
    mockQueries(
      [
        [{ id: 1, uuid: "u1", content: "cost", page: { id: 10 }, parent: { id: 10 }, "updated-at": 1000 }],
      ],
      [[{ id: 10, name: "test", originalName: "Test", properties: {}, "updated-at": 1000 }]],
    );

    mockEmbedTexts.mockResolvedValue([[0.1]]);

    await indexBlocks();

    const texts = mockEmbedTexts.mock.calls[0][0];
    // Top-level short block should NOT have parent prepended
    expect(texts[0]).toMatch(/^cost/);
    // Block content before context
    const sepIndex = texts[0].indexOf("--- Context ---");
    expect(sepIndex).toBeGreaterThan(0);
    expect(texts[0].indexOf("cost")).toBeLessThan(sepIndex);
    expect(texts[0].indexOf("[Page: Test]")).toBeGreaterThan(sepIndex);
  });

  it("includes allowed block properties in embedding text", async () => {
    mockQueries(
      [
        [{ id: 1, uuid: "u1", content: "priority:: critical\nstatus:: in-progress\ncollapsed:: true\nDo the deployment", page: { id: 10 }, parent: { id: 10 }, "updated-at": 1000 }],
      ],
      [[defaultPage]],
    );

    mockEmbedTexts.mockResolvedValue([[0.1]]);

    await indexBlocks();

    const texts = mockEmbedTexts.mock.calls[0][0];
    expect(texts[0]).toContain("priority: critical");
    expect(texts[0]).toContain("status: in-progress");
    // collapsed is not in the block allow-list
    expect(texts[0]).not.toContain("collapsed");
    // Order: block content, then block properties, then context separator, then page
    const sepIndex = texts[0].indexOf("--- Context ---");
    expect(texts[0].indexOf("Do the deployment")).toBeLessThan(texts[0].indexOf("priority: critical"));
    expect(texts[0].indexOf("priority: critical")).toBeLessThan(sepIndex);
    expect(texts[0].indexOf("status: in-progress")).toBeLessThan(sepIndex);
    expect(texts[0].indexOf("[Page: Test Page]")).toBeGreaterThan(sepIndex);
  });

  it("re-embeds when page is renamed", async () => {
    const blocks = [
      [{ id: 1, uuid: "u1", content: "Hello world this is a test block", page: { id: 10 }, parent: { id: 10 }, "updated-at": 1000 }],
    ];

    mockQueries(blocks, [[{ id: 10, name: "old-name", originalName: "Old Name", properties: {}, "updated-at": 1000 }]]);
    mockEmbedTexts.mockResolvedValue([[0.1, 0.2, 0.3]]);

    await indexBlocks();
    expect(mockEmbedTexts).toHaveBeenCalledTimes(1);

    // Same block, but page renamed — page updated-at changes
    mockEmbedTexts.mockClear();
    mockQueries(blocks, [[{ id: 10, name: "new-name", originalName: "New Name", properties: {}, "updated-at": 2000 }]]);
    mockEmbedTexts.mockResolvedValue([[0.4, 0.5, 0.6]]);

    await indexBlocks();
    expect(mockEmbedTexts).toHaveBeenCalledTimes(1);
  });

  it("re-embeds when parent block changes", async () => {
    const pages = [[defaultPage]];

    // Initial: block 5 is child of block 4
    mockQueries(
      [
        [{ id: 4, uuid: "u4", content: "Original parent content here", page: { id: 10 }, parent: { id: 10 }, "updated-at": 1000 }],
        [{ id: 5, uuid: "u5", content: "Child block content unchanged", page: { id: 10 }, parent: { id: 4 }, "updated-at": 1000 }],
      ],
      pages,
    );
    mockEmbedTexts.mockResolvedValue([[0.1], [0.2]]);

    await indexBlocks();
    expect(mockEmbedTexts).toHaveBeenCalledTimes(1);

    // Parent content changes (updated-at changes), child stays the same
    mockEmbedTexts.mockClear();
    mockQueries(
      [
        [{ id: 4, uuid: "u4", content: "Updated parent content here", page: { id: 10 }, parent: { id: 10 }, "updated-at": 2000 }],
        [{ id: 5, uuid: "u5", content: "Child block content unchanged", page: { id: 10 }, parent: { id: 4 }, "updated-at": 1000 }],
      ],
      pages,
    );
    mockEmbedTexts.mockResolvedValue([[0.3], [0.4]]);

    await indexBlocks();
    // Both parent and child should be re-embedded
    expect(mockEmbedTexts).toHaveBeenCalledTimes(1);
    const texts = mockEmbedTexts.mock.calls[0][0];
    expect(texts).toHaveLength(2);
  });

  it("stores timestamps in embedding records", async () => {
    mockQueries(
      [[{ id: 1, uuid: "u1", content: "Hello world this is a test block", page: { id: 10 }, parent: { id: 10 }, "updated-at": 1000 }]],
      [[defaultPage]],
    );
    mockEmbedTexts.mockResolvedValue([[0.1, 0.2, 0.3]]);

    await indexBlocks();

    const stored = await getAllEmbeddings();
    expect(stored).toHaveLength(1);
    expect(stored[0].blockUpdatedAt).toBe(1000);
    expect(stored[0].pageUpdatedAt).toBe(1000);
  });

  it("handles cancellation", async () => {
    mockQueries(
      [[{ id: 1, uuid: "u1", content: "Block one with enough content", page: { id: 10 }, parent: { id: 10 }, "updated-at": 1000 }]],
      [[defaultPage]],
    );

    mockEmbedTexts.mockImplementation(async () => {
      cancelIndexing();
      throw new DOMException("Aborted", "AbortError");
    });

    // Should not throw
    await indexBlocks();
    expect(indexingState.status).toBe("idle");
  });
});
