import { describe, it, expect, vi } from "vitest";
import { normalizeContent, hashContent, debounce, formatPageProperties } from "../utils";

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

  it("strips markdown bold and italic", () => {
    expect(normalizeContent("**bold** and *italic*")).toBe("bold and italic");
  });

  it("strips heading markers", () => {
    expect(normalizeContent("## Heading Two")).toBe("Heading Two");
  });

  it("strips markdown links, keeps text", () => {
    expect(normalizeContent("[click here](http://example.com)")).toBe(
      "click here",
    );
  });

  it("strips inline code markers", () => {
    expect(normalizeContent("use `const x = 1`")).toBe("use const x = 1");
  });

  it("keeps TODO markers", () => {
    expect(normalizeContent("TODO Buy groceries")).toBe("TODO Buy groceries");
  });

  it("strips page references, keeps text", () => {
    expect(normalizeContent("Talk to [[Jon Jones]]")).toBe("Talk to Jon Jones");
  });

  it("strips tags with page references", () => {
    expect(normalizeContent("some task #[[Fred Bloggs]]")).toBe("some task Fred Bloggs");
  });

  it("strips simple tags", () => {
    expect(normalizeContent("important #urgent")).toBe("important urgent");
  });

  it("collapses whitespace", () => {
    expect(normalizeContent("a   b\n\nc")).toBe("a b c");
  });

  it("handles combined formatting", () => {
    const input =
      "priority:: high\n## TODO **Buy** groceries from [store](http://x.com)";
    const result = normalizeContent(input);
    expect(result).toBe("TODO Buy groceries from store");
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

describe("formatPageProperties", () => {
  it("formats simple properties", () => {
    expect(formatPageProperties({ tags: "meeting", category: "work" })).toBe(
      "[category: work, tags: meeting]",
    );
  });

  it("formats array properties", () => {
    expect(formatPageProperties({ tags: ["project-x", "planning"] })).toBe(
      "[tags: project-x, planning]",
    );
  });

  it("skips internal properties", () => {
    expect(formatPageProperties({ id: "123", filters: {}, tags: "meeting" })).toBe(
      "[tags: meeting]",
    );
  });

  it("returns empty string for no useful properties", () => {
    expect(formatPageProperties({})).toBe("");
    expect(formatPageProperties({ id: "123", collapsed: true })).toBe("");
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
