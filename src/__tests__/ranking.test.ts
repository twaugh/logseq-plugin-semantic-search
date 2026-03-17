import { describe, it, expect } from "vitest";
import {
  computeDecayMultiplier,
  applyTimeDecay,
  computeGroupingParams,
  groupAndRank,
  getOverfetchCount,
  DECAY_FLOOR,
  T_MIN,
  T_MAX,
  W_MAX,
  W_MIN,
  type ScoredResult,
} from "../ranking";
import type { SearchResult } from "../search";

describe("getOverfetchCount", () => {
  it("returns 2x topK", () => {
    expect(getOverfetchCount(10)).toBe(20);
    expect(getOverfetchCount(1)).toBe(2);
  });
});

describe("computeDecayMultiplier", () => {
  const now = new Date(2025, 5, 15); // June 15, 2025

  it("returns 1.0 for null journalDay", () => {
    expect(computeDecayMultiplier(null, now)).toBe(1.0);
  });

  it("returns ~1.0 for today", () => {
    expect(computeDecayMultiplier(20250615, now)).toBeCloseTo(1.0, 2);
  });

  it("returns ~0.906 for 180 days ago", () => {
    // 180 days before June 15 = ~Dec 17, 2024
    const journalDay = 20241217;
    const result = computeDecayMultiplier(journalDay, now);
    // F + (1-F)*e^(-1) = 0.85 + 0.15*0.368 = 0.905
    expect(result).toBeCloseTo(0.905, 2);
  });

  it("converges to DECAY_FLOOR for very old entries", () => {
    const result = computeDecayMultiplier(20100101, now);
    expect(result).toBeCloseTo(DECAY_FLOOR, 2);
  });

  it("clamps future dates to 1.0", () => {
    const result = computeDecayMultiplier(20260101, now);
    expect(result).toBeCloseTo(1.0, 2);
  });
});

describe("computeGroupingParams", () => {
  it("returns min threshold and max density for short queries (<=3 words)", () => {
    for (const wc of [1, 2, 3]) {
      const { threshold, densityWeight } = computeGroupingParams(wc);
      expect(threshold).toBe(T_MIN);
      expect(densityWeight).toBeCloseTo(W_MAX);
    }
  });

  it("returns max threshold and min density for long queries (>=8 words)", () => {
    for (const wc of [8, 12]) {
      const { threshold, densityWeight } = computeGroupingParams(wc);
      expect(threshold).toBe(T_MAX);
      expect(densityWeight).toBeCloseTo(W_MIN);
    }
  });

  it("interpolates for mid-length queries", () => {
    const { threshold, densityWeight } = computeGroupingParams(5);
    // ratio = (5-3)/(8-3) = 0.4
    expect(threshold).toBe(Math.round(T_MIN + (T_MAX - T_MIN) * 0.4));
    expect(densityWeight).toBeCloseTo(W_MAX + (W_MIN - W_MAX) * 0.4);
  });
});

describe("applyTimeDecay", () => {
  it("applies decay multipliers from journal day map", () => {
    const now = new Date(2025, 5, 15);
    const results: SearchResult[] = [
      { blockId: "a", pageId: 1, similarity: 0.9 },
      { blockId: "b", pageId: 2, similarity: 0.8 },
    ];
    const journalDays = new Map<number, number | null>([
      [1, null],      // not a journal
      [2, 20250615],  // today's journal
    ]);
    const scored = applyTimeDecay(results, journalDays, now);
    expect(scored[0].decayMultiplier).toBe(1.0);
    expect(scored[0].adjustedScore).toBe(0.9);
    expect(scored[1].decayMultiplier).toBeCloseTo(1.0, 2);
    expect(scored[1].adjustedScore).toBeCloseTo(0.8, 2);
  });

  it("treats missing pageId as non-journal", () => {
    const results: SearchResult[] = [
      { blockId: "a", pageId: 99, similarity: 0.9 },
    ];
    const scored = applyTimeDecay(results, new Map());
    expect(scored[0].decayMultiplier).toBe(1.0);
  });
});

describe("groupAndRank", () => {
  function makeScoredResult(
    blockId: string,
    pageId: number,
    adjustedScore: number,
  ): ScoredResult {
    return {
      blockId,
      pageId,
      similarity: adjustedScore,
      decayMultiplier: 1.0,
      adjustedScore,
    };
  }

  it("groups pages meeting threshold into PageGroup", () => {
    const scored = [
      makeScoredResult("a1", 1, 0.9),
      makeScoredResult("a2", 1, 0.8),
      makeScoredResult("a3", 1, 0.7),
      makeScoredResult("a4", 1, 0.6),
      makeScoredResult("b1", 2, 0.85),
    ];
    // queryWordCount=1 → threshold=T_MIN=4, densityWeight=W_MAX=0.15
    const items = groupAndRank(scored, 1, 10, new Set());
    expect(items[0].kind).toBe("page-group");
    if (items[0].kind === "page-group") {
      expect(items[0].pageId).toBe(1);
      // pageScore = 0.9 + 0.8*0.15/1 + 0.7*0.15/2 + 0.6*0.15/3 (harmonic decay)
      expect(items[0].pageScore).toBeCloseTo(0.9 + 0.8 * 0.15 + 0.7 * 0.15 / 2 + 0.6 * 0.15 / 3);
      expect(items[0].blocks).toHaveLength(4);
    }
    expect(items[1].kind).toBe("single-block");
  });

  it("does not group pages below threshold", () => {
    const scored = [
      makeScoredResult("a1", 1, 0.9),
      makeScoredResult("b1", 2, 0.85),
    ];
    // threshold=4, page 1 has only 1 block
    const items = groupAndRank(scored, 1, 10, new Set());
    expect(items.every((i) => i.kind === "single-block")).toBe(true);
  });

  it("never groups journal pages", () => {
    const scored = [
      makeScoredResult("a1", 1, 0.9),
      makeScoredResult("a2", 1, 0.8),
      makeScoredResult("a3", 1, 0.7),
      makeScoredResult("a4", 1, 0.6),
    ];
    const journalPageIds = new Set([1]);
    const items = groupAndRank(scored, 1, 10, journalPageIds);
    expect(items.every((i) => i.kind === "single-block")).toBe(true);
  });

  it("respects topK limit", () => {
    const scored = [
      makeScoredResult("a1", 1, 0.9),
      makeScoredResult("b1", 2, 0.85),
      makeScoredResult("c1", 3, 0.80),
      makeScoredResult("d1", 4, 0.75),
    ];
    const items = groupAndRank(scored, 1, 2, new Set());
    expect(items).toHaveLength(2);
  });


  it("sorts by score descending", () => {
    const scored = [
      makeScoredResult("a1", 1, 0.5),
      makeScoredResult("b1", 2, 0.9),
    ];
    const items = groupAndRank(scored, 1, 10, new Set());
    expect(items[0].kind === "single-block" && items[0].result.blockId === "b1").toBe(true);
  });

  it("handles empty input", () => {
    const items = groupAndRank([], 1, 10, new Set());
    expect(items).toHaveLength(0);
  });

  it("handles all results from one page", () => {
    const scored = [
      makeScoredResult("a1", 1, 0.9),
      makeScoredResult("a2", 1, 0.8),
      makeScoredResult("a3", 1, 0.7),
      makeScoredResult("a4", 1, 0.6),
    ];
    const items = groupAndRank(scored, 1, 10, new Set());
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("page-group");
  });
});
