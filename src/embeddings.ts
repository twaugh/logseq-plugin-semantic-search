export interface EmbedResult {
  embeddings: number[][];
}

export class EmbeddingError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "EmbeddingError";
  }
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 3,
): Promise<Response> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;

      const body = await response.text().catch(() => "");
      if (response.status === 404 && body.includes("model")) {
        throw new EmbeddingError(
          `Model not found. Try: ollama pull <model>`,
          404,
        );
      }
      throw new EmbeddingError(
        `HTTP ${response.status}: ${body || response.statusText}`,
        response.status,
      );
    } catch (err) {
      if (err instanceof EmbeddingError && err.statusCode === 404) throw err;
      lastError = err as Error;
      if (lastError.name === "TypeError" && attempt === 0) {
        throw new EmbeddingError(
          `Cannot reach embedding server. Is Ollama running?`,
        );
      }
      if (attempt < retries - 1) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
  }
  throw lastError ?? new EmbeddingError("Unknown error");
}

export type TaskType = "query" | "document";

interface PrefixPair {
  query: string;
  document: string;
}

const MODEL_PREFIXES: [RegExp, PrefixPair][] = [
  [/\bnomic-embed-text\b/i, { query: "search_query: ", document: "search_document: " }],
];

function getPrefix(model: string, task: TaskType): string {
  for (const [pattern, prefixes] of MODEL_PREFIXES) {
    if (pattern.test(model)) return prefixes[task];
  }
  return "";
}

export async function embedTexts(
  texts: string[],
  endpoint: string,
  model: string,
  format: "ollama" | "openai",
  signal?: AbortSignal,
  task: TaskType = "document",
): Promise<number[][]> {
  const prefix = getPrefix(model, task);
  const prefixed = prefix ? texts.map((t) => prefix + t) : texts;
  if (format === "ollama") {
    return embedOllama(prefixed, endpoint, model, signal);
  }
  return embedOpenAI(prefixed, endpoint, model, signal);
}

async function embedOllama(
  texts: string[],
  endpoint: string,
  model: string,
  signal?: AbortSignal,
): Promise<number[][]> {
  const url = `${endpoint.replace(/\/$/, "")}/api/embed`;
  const response = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: texts }),
    signal,
  });
  const data = await response.json();
  return data.embeddings;
}

async function embedOpenAI(
  texts: string[],
  endpoint: string,
  model: string,
  signal?: AbortSignal,
): Promise<number[][]> {
  const url = `${endpoint.replace(/\/$/, "")}/v1/embeddings`;
  const response = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: texts }),
    signal,
  });
  const data = await response.json();
  return data.data
    .sort((a: { index: number }, b: { index: number }) => a.index - b.index)
    .map((d: { embedding: number[] }) => d.embedding);
}
