export function normalizeContent(content: string): string {
  let text = content;
  // Strip property lines (key:: value)
  text = text.replace(/^[a-zA-Z_-]+::.*$/gm, "");
  // Strip block references ((uuid))
  text = text.replace(/\(\([0-9a-f-]+\)\)/g, "");
  // Strip markdown bold/italic markers
  text = text.replace(/\*{1,3}(.*?)\*{1,3}/g, "$1");
  text = text.replace(/_{1,3}(.*?)_{1,3}/g, "$1");
  // Strip tags #[[page]] -> page, #tag -> tag
  text = text.replace(/#\[\[([^\]]*)\]\]/g, "$1");
  text = text.replace(/#([a-zA-Z][\w-]*)/g, "$1");
  // Strip page references [[page]] -> page
  text = text.replace(/\[\[([^\]]*)\]\]/g, "$1");
  // Strip markdown headings
  text = text.replace(/^#{1,6}\s+/gm, "");
  // Strip markdown links [text](url) -> text
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Strip markdown images ![alt](url)
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Strip inline code markers
  text = text.replace(/`([^`]*)`/g, "$1");
  // Collapse whitespace
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

const SKIP_PROPERTIES = new Set([
  "id", "filters", "collapsed", "icon",
  "public", "exclude-from-graph-view",
]);

export function formatPageProperties(props: Record<string, any>): string {
  const entries = Object.entries(props)
    .filter(([k]) => !SKIP_PROPERTIES.has(k))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => {
      const val = Array.isArray(v) ? v.join(", ") : String(v);
      return `${k}: ${val}`;
    });
  if (entries.length === 0) return "";
  return `[${entries.join(", ")}]`;
}
