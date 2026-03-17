import { describe, it, expect, vi } from "vitest";
import { normalizeContent, hashContent, debounce, formatProperties, parseAllowList, parseBlockProperties, wordCount } from "../utils";

describe("normalizeContent", () => {
  it("strips property lines", () => {
    expect(normalizeContent("title:: My Title\nSome content")).toBe(
      "Some content",
    );
  });

  it("strips block references", () => {
    expect(normalizeContent("See ((abc12345-def6-7890-abcd-ef1234567890))")).toBe(
      "See",
    );
  });

  it("strips embed macros", () => {
    expect(normalizeContent("Before {{embed ((abc-123))}} after")).toBe(
      "Before after",
    );
    expect(normalizeContent("{{embed [[Some Page]]}}")).toBe("");
  });

  it("strips markdown link URLs, keeps bracketed text", () => {
    expect(normalizeContent("[click here](http://example.com)")).toBe(
      "[click here]",
    );
  });

  it("strips image URLs, keeps alt text", () => {
    expect(normalizeContent("![Diagram](http://example.com/img.png)")).toBe(
      "Diagram",
    );
  });

  it("strips bare URLs", () => {
    expect(normalizeContent("visit https://example.com/page today")).toBe(
      "visit today",
    );
  });

  it("preserves markdown formatting", () => {
    expect(normalizeContent("**bold** and *italic*")).toBe("**bold** and *italic*");
    expect(normalizeContent("## Heading Two")).toBe("## Heading Two");
    expect(normalizeContent("use `const x = 1`")).toBe("use `const x = 1`");
    expect(normalizeContent("Talk to [[Jon Jones]]")).toBe("Talk to [[Jon Jones]]");
    expect(normalizeContent("important #urgent")).toBe("important #urgent");
  });

  it("collapses whitespace", () => {
    expect(normalizeContent("a   b\n\nc")).toBe("a b c");
  });

  it("strips properties and URLs but preserves other formatting", () => {
    const input =
      "priority:: high\n## TODO **Buy** groceries from [store](http://x.com)";
    const result = normalizeContent(input);
    expect(result).toBe("## TODO **Buy** groceries from [store]");
  });

  it("returns empty string for falsy input", () => {
    expect(normalizeContent("")).toBe("");
  });
});

describe("hashContent", () => {
  it("returns a consistent hex string", async () => {
    const hash = await hashContent("hello world");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const hash2 = await hashContent("hello world");
    expect(hash).toBe(hash2);
  });

  it("returns different hashes for different content", async () => {
    const h1 = await hashContent("hello");
    const h2 = await hashContent("world");
    expect(h1).not.toBe(h2);
  });
});

describe("formatProperties", () => {
  const allowList = parseAllowList("tags, category, status");

  it("formats allowed properties", () => {
    expect(formatProperties({ tags: "meeting", category: "work" }, allowList)).toEqual([
      "category: work",
      "tags: meeting",
    ]);
  });

  it("formats array properties", () => {
    expect(formatProperties({ tags: ["project-x", "planning"] }, allowList)).toEqual([
      "tags: project-x, planning",
    ]);
  });

  it("excludes properties not in allow-list", () => {
    expect(formatProperties({ id: "123", filters: {}, tags: "meeting" }, allowList)).toEqual([
      "tags: meeting",
    ]);
  });

  it("returns empty array when no properties match", () => {
    expect(formatProperties({}, allowList)).toEqual([]);
    expect(formatProperties({ id: "123", collapsed: true }, allowList)).toEqual([]);
  });
});

describe("parseBlockProperties", () => {
  it("parses key:: value lines", () => {
    expect(parseBlockProperties("priority:: critical\nstatus:: done\nSome content")).toEqual({
      priority: "critical",
      status: "done",
    });
  });

  it("returns empty object for no properties", () => {
    expect(parseBlockProperties("Just plain content")).toEqual({});
  });
});

describe("wordCount", () => {
  it("counts words", () => {
    expect(wordCount("hello world")).toBe(2);
    expect(wordCount("one two three four five")).toBe(5);
  });

  it("returns 0 for empty/whitespace", () => {
    expect(wordCount("")).toBe(0);
    expect(wordCount("   ")).toBe(0);
  });
});

describe("debounce", () => {
  it("delays execution", async () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced("a");
    debounced("b");
    debounced("c");

    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("c");

    vi.useRealTimers();
  });
});
