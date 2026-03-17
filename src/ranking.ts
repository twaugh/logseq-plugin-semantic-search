import type { SearchResult } from "./search";

export interface ScoredResult {
  blockId: string;
  pageId: number;
  similarity: number;
  decayMultiplier: number;
  adjustedScore: number;
}

export interface PageGroup {
  kind: "page-group";
  pageId: number;
  pageScore: number;
  blocks: ScoredResult[];
}

export interface SingleBlock {
  kind: "single-block";
  result: ScoredResult;
}

export type RankedItem = PageGroup | SingleBlock;

export const DECAY_FLOOR = 0.85;
export const DECAY_SCALE_DAYS = 180;
export const T_MIN = 2;
export const T_MAX = 5;
export const W_MAX = 0.15;
export const W_MIN = 0.03;
export const QUERY_SHORT = 3;
export const QUERY_LONG = 8;
export const OVERFETCH_MULTIPLIER = 3;

export function getOverfetchCount(topK: number): number {
  return topK * OVERFETCH_MULTIPLIER;
}

export function computeDecayMultiplier(
  journalDay: number | null,
  now: Date = new Date(),
): number {
  if (journalDay === null) return 1.0;
  const str = String(journalDay);
  const year = parseInt(str.slice(0, 4), 10);
  const month = parseInt(str.slice(4, 6), 10) - 1;
  const day = parseInt(str.slice(6, 8), 10);
  const journalDate = new Date(year, month, day);
  const deltaMs = now.getTime() - journalDate.getTime();
  const deltaDays = Math.max(0, deltaMs / (1000 * 60 * 60 * 24));
  return DECAY_FLOOR + (1 - DECAY_FLOOR) * Math.exp(-deltaDays / DECAY_SCALE_DAYS);
}

export function applyTimeDecay(
  results: SearchResult[],
  journalDays: Map<number, number | null>,
  now: Date = new Date(),
): ScoredResult[] {
  return results.map((r) => {
    const journalDay = journalDays.get(r.pageId) ?? null;
    const decayMultiplier = computeDecayMultiplier(journalDay, now);
    return {
      blockId: r.blockId,
      pageId: r.pageId,
      similarity: r.similarity,
      decayMultiplier,
      adjustedScore: r.similarity * decayMultiplier,
    };
  });
}

export function computeGroupingParams(queryWordCount: number): {
  threshold: number;
  densityWeight: number;
} {
  const ratio = Math.max(0, Math.min(1, (queryWordCount - QUERY_SHORT) / (QUERY_LONG - QUERY_SHORT)));
  const threshold = Math.round(T_MIN + (T_MAX - T_MIN) * ratio);
  const densityWeight = W_MAX + (W_MIN - W_MAX) * ratio;
  return { threshold, densityWeight };
}

export function groupAndRank(
  scored: ScoredResult[],
  queryWordCount: number,
  topK: number,
  journalPageIds: Set<number>,
): RankedItem[] {
  const { threshold, densityWeight } = computeGroupingParams(queryWordCount);

  // Group by pageId
  const byPage = new Map<number, ScoredResult[]>();
  for (const s of scored) {
    let arr = byPage.get(s.pageId);
    if (!arr) {
      arr = [];
      byPage.set(s.pageId, arr);
    }
    arr.push(s);
  }

  // Sort each page's blocks descending
  for (const arr of byPage.values()) {
    arr.sort((a, b) => b.adjustedScore - a.adjustedScore);
  }

  const items: RankedItem[] = [];
  for (const [pageId, blocks] of byPage) {
    if (!journalPageIds.has(pageId) && blocks.length >= threshold) {
      const maxScore = blocks[0].adjustedScore;
      let bonus = 0;
      for (let i = 1; i < blocks.length; i++) {
        bonus += blocks[i].adjustedScore * densityWeight / i;
      }
      items.push({
        kind: "page-group",
        pageId,
        pageScore: maxScore + bonus,
        blocks,
      });
    } else {
      for (const b of blocks) {
        items.push({ kind: "single-block", result: b });
      }
    }
  }

  items.sort((a, b) => {
    const scoreA = a.kind === "page-group" ? a.pageScore : a.result.adjustedScore;
    const scoreB = b.kind === "page-group" ? b.pageScore : b.result.adjustedScore;
    return scoreB - scoreA;
  });

  return items.slice(0, topK);
}
