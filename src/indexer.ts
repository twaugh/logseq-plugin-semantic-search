import { normalizeContent, truncate, formatPageProperties } from "./utils";
import { embedTexts } from "./embeddings";
import {
  type EmbeddingRecord,
  putEmbeddings,
  getAllEmbeddings,
  deleteEmbeddings,
  clearAllEmbeddings,
  getMetadata,
  setMetadata,
  getEmbeddingCount,
} from "./storage";
import { getSettings } from "./settings";

export interface IndexingState {
  status: "idle" | "scanning" | "indexing";
  progress: { done: number; total: number };
}

export const indexingState: IndexingState = {
  status: "idle",
  progress: { done: 0, total: 0 },
};

let currentAbort: AbortController | null = null;

let searchResolve: (() => void) | null = null;
let searchPromise: Promise<void> | null = null;
let batchAbort: AbortController | null = null;

export function acquireSearchPriority(): void {
  if (!searchPromise) {
    searchPromise = new Promise((r) => { searchResolve = r; });
  }
  // Abort any in-flight indexing batch so the API is free for search
  if (batchAbort) {
    batchAbort.abort();
  }
}

export function releaseSearchPriority(): void {
  if (searchResolve) {
    searchResolve();
    searchPromise = null;
    searchResolve = null;
  }
}

async function waitForSearch(): Promise<void> {
  if (searchPromise) await searchPromise;
}

interface BlockResult {
  id: number;
  uuid: string;
  content: string;
  page?: { id: number };
  parent?: { id: number };
}

interface PageResult {
  id: number;
  name?: string;
  originalName?: string;
  properties?: Record<string, any>;
}

const SCHEMA_VERSION = 3;

interface PageInfo {
  name: string;
  properties: Record<string, any>;
}

interface BlockInfo {
  content: string;
  parentId: number;
  pageId: number;
}

function buildContextHashes(
  blockId: number,
  blockMap: Map<number, BlockInfo>,
  pageMap: Map<number, PageInfo>,
  hashCache: Map<string, string>,
): string[] {
  const block = blockMap.get(blockId);
  if (!block) return [];

  const hashes: string[] = [];

  // Page context hash
  const pageInfo = pageMap.get(block.pageId);
  if (pageInfo) {
    let pageContext = pageInfo.name;
    const propsStr = formatPageProperties(pageInfo.properties);
    if (propsStr) pageContext += ` ${propsStr}`;
    const pageKey = `page:${block.pageId}`;
    let pageHash = hashCache.get(pageKey);
    if (!pageHash) {
      pageHash = quickHash(pageContext);
      hashCache.set(pageKey, pageHash);
    }
    hashes.push(pageHash);
  }

  // Ancestor hashes (from root to immediate parent)
  const ancestors: string[] = [];
  let currentId: number | undefined = block.parentId;
  while (currentId && currentId !== block.pageId) {
    const parent = blockMap.get(currentId);
    if (!parent) break;
    const parentKey = `block:${currentId}`;
    let parentHash = hashCache.get(parentKey);
    if (!parentHash) {
      parentHash = quickHash(normalizeContent(parent.content));
      hashCache.set(parentKey, parentHash);
    }
    ancestors.unshift(parentHash);
    currentId = parent.parentId;
  }
  hashes.push(...ancestors);

  // Block's own content hash
  const blockKey = `block:${blockId}`;
  let blockHash = hashCache.get(blockKey);
  if (!blockHash) {
    blockHash = quickHash(normalizeContent(block.content));
    hashCache.set(blockKey, blockHash);
  }
  hashes.push(blockHash);

  return hashes;
}

function buildEmbeddingText(
  blockId: number,
  blockMap: Map<number, BlockInfo>,
  pageMap: Map<number, PageInfo>,
): string {
  const block = blockMap.get(blockId);
  if (!block) return "";

  const parts: string[] = [];

  // Page context
  const pageInfo = pageMap.get(block.pageId);
  if (pageInfo?.name) {
    let pageLine = `[Page: ${pageInfo.name}]`;
    const propsStr = formatPageProperties(pageInfo.properties);
    if (propsStr) pageLine += ` ${propsStr}`;
    parts.push(pageLine);
  }

  // Ancestor context (walk up parent chain)
  const ancestors: string[] = [];
  let currentId: number | undefined = block.parentId;
  while (currentId && currentId !== block.pageId) {
    const parent = blockMap.get(currentId);
    if (!parent) break;
    const content = normalizeContent(parent.content);
    if (content) ancestors.unshift(`> ${content}`);
    currentId = parent.parentId;
  }
  parts.push(...ancestors);

  // Block's own content
  parts.push(normalizeContent(block.content));

  return parts.join("\n");
}

/** Fast non-cryptographic hash for change detection */
function quickHash(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function contextHashesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function cancelIndexing(): void {
  if (currentAbort) {
    currentAbort.abort();
    currentAbort = null;
    indexingState.status = "idle";
  }
}

export async function indexBlocks(
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  cancelIndexing();

  const abort = new AbortController();
  currentAbort = abort;
  indexingState.status = "scanning";
  indexingState.progress = { done: 0, total: 0 };

  const settings = getSettings();

  try {
    // Check if schema version changed
    const storedSchema = await getMetadata("schemaVersion");
    if (!storedSchema || (storedSchema as number) < SCHEMA_VERSION) {
      await clearAllEmbeddings();
      logseq.UI.showMsg("Embedding format changed, re-indexing all blocks...");
      await setMetadata("schemaVersion", SCHEMA_VERSION);
    }

    // Check if model changed
    const storedModel = await getMetadata("model");
    if (storedModel && storedModel !== settings.embeddingModel) {
      await clearAllEmbeddings();
      logseq.UI.showMsg("Model changed, re-indexing all blocks...");
    }
    await setMetadata("model", settings.embeddingModel);

    // Bulk-fetch all blocks (including short ones needed for parent context)
    const blockQuery = `[:find (pull ?b [:db/id :block/uuid :block/content :block/page :block/parent])
     :where [?b :block/content _]]`;
    const blockResults: BlockResult[][] = await logseq.DB.datascriptQuery(blockQuery);

    // Bulk-fetch all pages
    const pageQuery = `[:find (pull ?p [:db/id :block/name :block/original-name :block/properties])
     :where [?p :block/name _]]`;
    const pageResults: PageResult[][] = await logseq.DB.datascriptQuery(pageQuery);

    if (abort.signal.aborted) return;

    // Build in-memory maps
    const blockMap = new Map<number, BlockInfo>();
    const indexableBlocks: BlockResult[] = [];

    for (const [block] of blockResults) {
      if (!block?.id || !block.content) continue;
      blockMap.set(block.id, {
        content: block.content,
        parentId: block.parent?.id ?? 0,
        pageId: block.page?.id ?? 0,
      });
      if (block.uuid) {
        indexableBlocks.push(block);
      }
    }

    const pageMap = new Map<number, PageInfo>();
    for (const [page] of pageResults) {
      if (!page?.id) continue;
      pageMap.set(page.id, {
        name: page.originalName ?? page.name ?? "",
        properties: page.properties ?? {},
      });
    }

    // Bulk-load existing embeddings for fast lookups
    const allExisting = await getAllEmbeddings();
    const existingMap = new Map<string, EmbeddingRecord>();
    for (const rec of allExisting) {
      existingMap.set(rec.blockId, rec);
    }

    // Find blocks needing embedding
    const toEmbed: {
      blockId: string;
      content: string;
      contextHashes: string[];
      pageId: number;
    }[] = [];

    const currentBlockIds = new Set<string>();
    const hashCache = new Map<string, string>();

    for (const block of indexableBlocks) {
      if (abort.signal.aborted) return;

      const blockId = block.uuid;
      currentBlockIds.add(blockId);

      const contextHashes = buildContextHashes(block.id, blockMap, pageMap, hashCache);
      const existing = existingMap.get(blockId);

      if (!existing || !existing.contextHashes || !contextHashesEqual(existing.contextHashes, contextHashes)) {
        const embeddingText = buildEmbeddingText(block.id, blockMap, pageMap);
        toEmbed.push({
          blockId,
          content: truncate(embeddingText, 4000),
          contextHashes,
          pageId: block.page?.id ?? 0,
        });
      }
    }

    // Batch embed
    const total = toEmbed.length;
    let done = 0;

    if (total > 0) {
      indexingState.status = "indexing";
      indexingState.progress = { done: 0, total };
    }

    for (let i = 0; i < toEmbed.length; i += settings.batchSize) {
      if (abort.signal.aborted) return;

      await waitForSearch();
      if (abort.signal.aborted) return;

      const batch = toEmbed.slice(i, i + settings.batchSize);
      const texts = batch.map((b) => b.content);

      // Create a per-batch abort controller that search can cancel
      batchAbort = new AbortController();
      const onMainAbort = () => batchAbort?.abort();
      abort.signal.addEventListener("abort", onMainAbort);

      let embeddings: number[][];
      try {
        embeddings = await embedTexts(
          texts,
          settings.apiEndpoint,
          settings.embeddingModel,
          settings.apiFormat,
          batchAbort.signal,
        );
      } catch (err) {
        abort.signal.removeEventListener("abort", onMainAbort);
        batchAbort = null;
        if (abort.signal.aborted) return;
        // Batch was aborted by search priority — retry this batch
        if ((err as Error).name === "AbortError") {
          i -= settings.batchSize;
          continue;
        }
        throw err;
      }
      abort.signal.removeEventListener("abort", onMainAbort);
      batchAbort = null;

      const records = batch.map((b, j) => ({
        blockId: b.blockId,
        contextHashes: b.contextHashes,
        embedding: embeddings[j],
        pageId: b.pageId,
        timestamp: Date.now(),
      }));

      await putEmbeddings(records);

      done += batch.length;
      indexingState.progress = { done, total };
      onProgress?.(done, total);

      // Yield to event loop
      await new Promise((r) => setTimeout(r, 0));
    }

    // Delete stale entries
    const staleIds = allExisting
      .map((r) => r.blockId)
      .filter((id) => !currentBlockIds.has(id));
    if (staleIds.length > 0) {
      await deleteEmbeddings(staleIds);
    }

    const count = await getEmbeddingCount();
    await setMetadata("blockCount", count);
    await setMetadata("lastIndexed", Date.now());

    if (!abort.signal.aborted && total > 0) {
      logseq.UI.showMsg(`Indexed ${total} blocks`);
    }
  } catch (err) {
    if ((err as Error).name === "AbortError") return;
    const msg = (err as Error).message || "Indexing failed";
    logseq.UI.showMsg(msg, "error");
    throw err;
  } finally {
    if (currentAbort === abort) {
      indexingState.status = "idle";
      currentAbort = null;
    }
  }
}
