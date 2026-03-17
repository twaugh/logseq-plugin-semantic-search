export function normalizeContent(content: string): string {
  if (!content) return "";
  let text = content;

  // Strip property lines (key:: value)
  text = text.replace(/^[a-zA-Z_-]+::.*$/gm, "");

  // Strip Logseq block references ((uuid))
  text = text.replace(/\(\([0-9a-fA-F-]+\)\)/g, "");

  // Strip Logseq embed macros {{embed ...}}
  text = text.replace(/\{\{embed\s[^}]*\}\}/g, "");

  // Strip raw URLs from images, but PRESERVE the alt text
  // ![Diagram of architecture](https://...) -> Diagram of architecture
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");

  // Strip raw URLs from links, but PRESERVE the anchor text in brackets
  // [Logseq Website](https://logseq.com) -> [Logseq Website]
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "[$1]");

  // Strip bare URLs that aren't in markdown format
  text = text.replace(/(?:https?|ftp):\/\/[\n\S]+/g, "");

  // Collapse excess whitespace and newlines
  text = text.replace(/\s+/g, " ").trim();

  return text;
}

export async function hashContent(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  ms: number,
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: Parameters<T>) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength);
}

export function parseAllowList(csv: string): Set<string> {
  return new Set(
    csv.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
}

export function formatProperties(
  props: Record<string, any>,
  allowList: Set<string>,
): string[] {
  return Object.entries(props)
    .filter(([k]) => allowList.has(k.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => {
      const val = Array.isArray(v) ? v.join(", ") : String(v);
      return `${k}: ${val}`;
    });
}

export function parseBlockProperties(content: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const match of content.matchAll(/^([a-zA-Z_-]+)::\s*(.+)$/gm)) {
    props[match[1]] = match[2].trim();
  }
  return props;
}

export function wordCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}
