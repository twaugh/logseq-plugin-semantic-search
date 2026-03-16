import type { EmbeddingRecord, PageEmbeddingRecord } from "./storage";

export interface SearchResult {
  blockId: string;
  pageId: number;
  similarity: number;
}

export interface PageSearchResult {
  pageId: number;
  pageName: string;
  isJournal: boolean;
  similarity: number;
}

export function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

export function searchEmbeddings(
  queryEmbedding: number[],
  records: EmbeddingRecord[],
  topK: number,
  threshold = 0.3,
): SearchResult[] {
  const scored: SearchResult[] = [];
  for (const record of records) {
    const similarity = dotProduct(queryEmbedding, record.embedding);
    if (similarity >= threshold) {
      scored.push({
        blockId: record.blockId,
        pageId: record.pageId,
        similarity,
      });
    }
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, topK);
}

export function searchPageEmbeddings(
  queryEmbedding: number[],
  records: PageEmbeddingRecord[],
  topK: number,
  threshold = 0.3,
): PageSearchResult[] {
  const scored: PageSearchResult[] = [];
  for (const record of records) {
    const similarity = dotProduct(queryEmbedding, record.embedding);
    if (similarity >= threshold) {
      scored.push({
        pageId: record.pageId,
        pageName: record.pageName,
        isJournal: record.isJournal,
        similarity,
      });
    }
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, topK);
}
