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
  "updated-at"?: number;
}

interface PageResult {
  id: number;
  name?: string;
  originalName?: string;
  "original-name"?: string;
  properties?: Record<string, any>;
  "updated-at"?: number;
}

const SCHEMA_VERSION = 4;

interface PageInfo {
  name: string;
  properties: Record<string, any>;
  updatedAt: number;
}

interface BlockInfo {
  content: string;
  parentId: number;
  pageId: number;
  updatedAt: number;
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
    const blockQuery = `[:find (pull ?b [:db/id :block/uuid :block/content :block/page :block/parent :block/updated-at])
     :where [?b :block/content _]]`;
    const blockResults: BlockResult[][] = await logseq.DB.datascriptQuery(blockQuery);

    // Bulk-fetch all pages
    const pageQuery = `[:find (pull ?p [:db/id :block/name :block/original-name :block/properties :block/updated-at])
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
        updatedAt: block["updated-at"] ?? 0,
      });
      if (block.uuid) {
        indexableBlocks.push(block);
      }
    }

    const pageMap = new Map<number, PageInfo>();
    for (const [page] of pageResults) {
      if (!page?.id) continue;
      pageMap.set(page.id, {
        name: page.originalName ?? page["original-name"] ?? page.name ?? "",
        properties: page.properties ?? {},
        updatedAt: page["updated-at"] ?? 0,
      });
    }

    // Build children map (entity id -> child entity ids)
    const childrenMap = new Map<number, number[]>();
    for (const [id, info] of blockMap) {
      if (info.parentId && info.parentId !== info.pageId) {
        let siblings = childrenMap.get(info.parentId);
        if (!siblings) {
          siblings = [];
          childrenMap.set(info.parentId, siblings);
        }
        siblings.push(id);
      }
    }

    // Bulk-load existing embeddings for fast lookups
    const allExisting = await getAllEmbeddings();
    const existingMap = new Map<string, EmbeddingRecord>();
    for (const rec of allExisting) {
      existingMap.set(rec.blockId, rec);
    }

    // Detect dirty entity IDs by comparing timestamps
    const dirtyEntityIds = new Set<number>();

    // Map uuid -> entity id for propagation
    const uuidToEntityId = new Map<string, number>();
    for (const block of indexableBlocks) {
      uuidToEntityId.set(block.uuid, block.id);
    }

    // Check each block's timestamps against stored values
    for (const block of indexableBlocks) {
      const existing = existingMap.get(block.uuid);
      if (!existing) continue; // new block, will be caught below

      const blockInfo = blockMap.get(block.id);
      if (!blockInfo) continue;

      // Block's own content changed
      if (blockInfo.updatedAt !== existing.blockUpdatedAt) {
        dirtyEntityIds.add(block.id);
      }

      // Page changed (rename, properties, etc.)
      const pageInfo = pageMap.get(blockInfo.pageId);
      if (pageInfo && pageInfo.updatedAt !== existing.pageUpdatedAt) {
        dirtyEntityIds.add(block.id);
      }
    }

    // Propagate dirty status down to all descendants
    const propagate = (entityId: number): void => {
      const children = childrenMap.get(entityId);
      if (!children) return;
      for (const childId of children) {
        if (!dirtyEntityIds.has(childId)) {
          dirtyEntityIds.add(childId);
          propagate(childId);
        }
      }
    };
    for (const id of [...dirtyEntityIds]) {
      propagate(id);
    }

    // Find blocks needing embedding (dirty or new)
    const toEmbed: {
      blockId: string;
      content: string;
      pageId: number;
      blockUpdatedAt: number;
      pageUpdatedAt: number;
    }[] = [];

    const currentBlockIds = new Set<string>();

    for (const block of indexableBlocks) {
      if (abort.signal.aborted) return;

      const blockId = block.uuid;
      currentBlockIds.add(blockId);

      const existing = existingMap.get(blockId);
      if (existing && !dirtyEntityIds.has(block.id)) continue;

      const blockInfo = blockMap.get(block.id);
      const pageInfo = pageMap.get(block.page?.id ?? 0);
      const embeddingText = buildEmbeddingText(block.id, blockMap, pageMap);
      toEmbed.push({
        blockId,
        content: truncate(embeddingText, 4000),
        pageId: block.page?.id ?? 0,
        blockUpdatedAt: blockInfo?.updatedAt ?? 0,
        pageUpdatedAt: pageInfo?.updatedAt ?? 0,
      });
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
        embedding: embeddings[j],
        pageId: b.pageId,
        blockUpdatedAt: b.blockUpdatedAt,
        pageUpdatedAt: b.pageUpdatedAt,
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
