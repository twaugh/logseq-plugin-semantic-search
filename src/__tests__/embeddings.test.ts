import { describe, it, expect, vi, beforeEach } from "vitest";
import { embedTexts, EmbeddingError } from "../embeddings";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

describe("embedTexts - ollama format", () => {
  it("sends correct request to /api/embed", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: [[0.1, 0.2], [0.3, 0.4]] }),
    });

    const result = await embedTexts(
      ["hello", "world"],
      "http://localhost:11434",
      "nomic-embed-text",
      "ollama",
    );

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:11434/api/embed",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          model: "nomic-embed-text",
          input: ["search_document: hello", "search_document: world"],
        }),
      }),
    );
    expect(result).toEqual([[0.1, 0.2], [0.3, 0.4]]);
  });

  it("strips trailing slash from endpoint", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: [[1]] }),
    });

    await embedTexts(["test"], "http://localhost:11434/", "model", "ollama");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:11434/api/embed",
      expect.anything(),
    );
  });
});

describe("embedTexts - openai format", () => {
  it("sends correct request to /v1/embeddings", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { index: 1, embedding: [0.3, 0.4] },
          { index: 0, embedding: [0.1, 0.2] },
        ],
      }),
    });

    const result = await embedTexts(
      ["hello", "world"],
      "http://localhost:8080",
      "text-embedding-3-small",
      "openai",
    );

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8080/v1/embeddings",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: ["hello", "world"],
        }),
      }),
    );
    // Should be sorted by index
    expect(result).toEqual([[0.1, 0.2], [0.3, 0.4]]);
  });
});

describe("error handling", () => {
  it("throws on connection error", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(
      embedTexts(["test"], "http://localhost:11434", "model", "ollama"),
    ).rejects.toThrow("Cannot reach embedding server");
  });

  it("throws on 404 model not found", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: async () => "model not found",
    });

    await expect(
      embedTexts(["test"], "http://localhost:11434", "model", "ollama"),
    ).rejects.toThrow("Model not found");
  });

  it("retries on server error", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: async () => "server error",
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embeddings: [[1]] }),
      });

    const result = await embedTexts(
      ["test"],
      "http://localhost:11434",
      "model",
      "ollama",
    );
    expect(result).toEqual([[1]]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
