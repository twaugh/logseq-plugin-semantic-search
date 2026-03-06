import { normalizeContent, hashContent, truncate, formatPageProperties } from "./utils";
import { embedTexts } from "./embeddings";
import {
  getEmbedding,
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
  status: "idle" | "indexing";
  progress: { done: number; total: number };
}

export const indexingState: IndexingState = {
  status: "idle",
  progress: { done: 0, total: 0 },
};

let currentAbort: AbortController | null = null;

interface BlockResult {
  id: number;
  uuid: string;
  content: string;
  page?: { id: number };
  parent?: { id: number };
}

const SCHEMA_VERSION = 2;

interface PageInfo {
  name: string;
  properties: Record<string, any>;
}

async function buildEmbeddingText(
  block: BlockResult,
  pageCache: Map<number, PageInfo>,
  parentCache: Map<number, string>,
): Promise<string> {
  const parts: string[] = [];
  const pageId = block.page?.id ?? 0;

  // Page context
  if (pageId) {
    let pageInfo = pageCache.get(pageId);
    if (!pageInfo) {
      const page = await logseq.Editor.getPage(pageId);
      pageInfo = {
        name: page?.originalName ?? page?.name ?? "",
        properties: page?.properties ?? {},
      };
      pageCache.set(pageId, pageInfo);
    }
    if (pageInfo.name) {
      let pageLine = `[Page: ${pageInfo.name}]`;
      const propsStr = formatPageProperties(pageInfo.properties);
      if (propsStr) pageLine += ` ${propsStr}`;
      parts.push(pageLine);
    }
  }

  // Ancestor context (walk up parent chain)
  const ancestors: string[] = [];
  let currentId = block.parent?.id;
  while (currentId && currentId !== pageId) {
    let content = parentCache.get(currentId);
    if (content === undefined) {
      const parentBlock = await logseq.Editor.getBlock(currentId);
      content = parentBlock?.content ? normalizeContent(parentBlock.content) : "";
      parentCache.set(currentId, content);
      // Get next parent
      currentId = parentBlock?.parent?.id;
    } else {
      // Content was cached but we still need to walk up; fetch block for parent pointer
      const parentBlock = await logseq.Editor.getBlock(currentId);
      currentId = parentBlock?.parent?.id;
    }
    if (content) ancestors.unshift(`> ${content}`);
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
  }
}

export async function indexBlocks(
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  cancelIndexing();

  const abort = new AbortController();
  currentAbort = abort;

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

    // Query all blocks
    const query = `[:find (pull ?b [:db/id :block/uuid :block/content :block/page :block/parent])
     :where [?b :block/content ?c] [(>= (count ?c) ${settings.minBlockLength})]]`;
    const results: BlockResult[][] = await logseq.DB.datascriptQuery(query);
    const blocks = results.map((r) => r[0]);

    indexingState.status = "indexing";
    indexingState.progress = { done: 0, total: blocks.length };

    // Find blocks needing embedding
    const toEmbed: {
      blockId: string;
      content: string;
      hash: string;
      pageId: number;
    }[] = [];

    const currentBlockIds = new Set<string>();
    const pageCache = new Map<number, PageInfo>();
    const parentCache = new Map<number, string>();

    for (const block of blocks) {
      if (abort.signal.aborted) return;

      const blockId = block.uuid;
      if (!blockId || !block.content) continue;
      currentBlockIds.add(blockId);

      const normalized = normalizeContent(block.content);
      if (normalized.length < settings.minBlockLength) continue;

      const embeddingText = await buildEmbeddingText(block, pageCache, parentCache);
      const hash = await hashContent(embeddingText);
      const existing = await getEmbedding(blockId);

      if (!existing || existing.contentHash !== hash) {
        toEmbed.push({
          blockId,
          content: truncate(embeddingText, 4000),
          hash,
          pageId: block.page?.id ?? 0,
        });
      }
    }

    // Batch embed
    const total = toEmbed.length;
    let done = 0;

    for (let i = 0; i < toEmbed.length; i += settings.batchSize) {
      if (abort.signal.aborted) return;

      const batch = toEmbed.slice(i, i + settings.batchSize);
      const texts = batch.map((b) => b.content);

      const embeddings = await embedTexts(
        texts,
        settings.apiEndpoint,
        settings.embeddingModel,
        settings.apiFormat,
        abort.signal,
      );

      const records = batch.map((b, j) => ({
        blockId: b.blockId,
        contentHash: b.hash,
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
    const allStored = await getAllEmbeddings();
    const staleIds = allStored
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
    indexingState.status = "idle";
    if (currentAbort === abort) {
      currentAbort = null;
    }
  }
}
