import { debounce } from "./utils";
import { embedTexts } from "./embeddings";
import { getCachedEmbeddings, getEmbeddingCount, invalidateEmbeddingCache } from "./storage";
import { searchEmbeddings } from "./search";
import { indexBlocks, indexingState, acquireSearchPriority, releaseSearchPriority } from "./indexer";
import { getSettings } from "./settings";
import {
  getOverfetchCount,
  applyTimeDecay,
  groupAndRank,
  type ScoredResult,
} from "./ranking";

interface DisplayBlock {
  blockId: string;
  pageId: number;
  similarity: number;
  adjustedScore: number;
  pageName: string;
  content: string;
  isJournal: boolean;
  breadcrumbs: string[];
}

interface DisplayPageGroup {
  kind: "page-group";
  pageId: number;
  pageName: string;
  pageScore: number;
  isJournal: boolean;
  blocks: DisplayBlock[];
}

interface DisplaySingleBlock {
  kind: "single-block";
  block: DisplayBlock;
}

type DisplayItem = DisplayPageGroup | DisplaySingleBlock;

let progressInterval: ReturnType<typeof setInterval> | undefined;
let evictTimer: ReturnType<typeof setTimeout> | undefined;
const CACHE_EVICT_MS = 60_000;
let lastDisplayItems: DisplayItem[] = [];
let expandedPageIds = new Set<number>();
let lastScoredResults: ScoredResult[] = [];
let lastDisplayBlockCache = new Map<string, DisplayBlock>();
let lastJournalPageIds = new Set<number>();
let lastQueryWordCount = 0;
let lastTopK = 20;
let lastQuery = "";
const queryHistory: string[] = [];
const MAX_HISTORY = 20;
let historyIndex = -1;
let pendingInput = "";

export function createSearchModal(): void {
  const app = document.getElementById("app");
  if (!app) return;

  app.innerHTML = `
    <div class="semantic-search-overlay" id="ss-overlay">
      <div class="semantic-search-modal" id="ss-modal">
        <div class="ss-header">
          <span class="ss-title">Semantic Search</span>
          <button class="ss-close" id="ss-close">&times;</button>
        </div>
        <input type="text" class="ss-input" id="ss-input" placeholder="Search query..." autocomplete="off" />
        <div class="ss-status" id="ss-status"></div>
        <div class="ss-results" id="ss-results"></div>
        <div class="ss-footer">
          <label class="ss-checkbox-label" id="ss-journal-label">
            <input type="checkbox" id="ss-include-journal" checked />
            Include journal
          </label>
        </div>
      </div>
    </div>
  `;

  const input = document.getElementById("ss-input") as HTMLInputElement;
  const closeBtn = document.getElementById("ss-close")!;
  const overlay = document.getElementById("ss-overlay")!;
  const journalCheckbox = document.getElementById("ss-include-journal") as HTMLInputElement;

  const debouncedSearch = debounce(async (...args: unknown[]) => {
    const query = args[0] as string;
    await performSearch(query);
  }, 500);

  input.addEventListener("input", () => {
    historyIndex = -1;
    const query = input.value.trim();
    if (query.length > 0) {
      debouncedSearch(query);
    } else {
      clearResults();
    }
  });

  closeBtn.addEventListener("click", hideModal);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) hideModal();
  });

  journalCheckbox.addEventListener("change", () => {
    renderFilteredResults();
  });

  document.addEventListener("keydown", handleKeydown);

  const resultsContainer = document.getElementById("ss-results")!;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Shift") resultsContainer.classList.add("shift-held");
  });
  document.addEventListener("keyup", (e) => {
    if (e.key === "Shift") resultsContainer.classList.remove("shift-held");
  });
  window.addEventListener("blur", () => {
    resultsContainer.classList.remove("shift-held");
  });

  updateStatus();
}

function handleKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    hideModal();
    return;
  }

  const input = document.getElementById("ss-input") as HTMLInputElement | null;
  const results = document.getElementById("ss-results");

  // History cycling: Up/Down when input is focused and no result is active
  if (input && document.activeElement === input && queryHistory.length > 0) {
    const active = results?.querySelector(".ss-result-item.active");
    if (!active) {
      if (e.key === "ArrowUp" && input.selectionStart === 0) {
        e.preventDefault();
        if (historyIndex === -1) pendingInput = input.value;
        let newIndex = historyIndex;
        while (newIndex < queryHistory.length - 1) {
          newIndex++;
          const candidate = queryHistory[queryHistory.length - 1 - newIndex];
          if (candidate !== input.value.trim()) {
            historyIndex = newIndex;
            input.value = candidate;
            input.select();
            if (candidate.trim()) performSearch(candidate.trim());
            return;
          }
        }
        return;
      }
      if (e.key === "ArrowDown" && historyIndex > -1) {
        e.preventDefault();
        historyIndex--;
        if (historyIndex === -1) {
          input.value = pendingInput;
          if (pendingInput.trim()) {
            performSearch(pendingInput.trim());
          } else {
            clearResults();
          }
        } else {
          const query = queryHistory[queryHistory.length - 1 - historyIndex];
          input.value = query;
          input.select();
          if (query.trim()) performSearch(query.trim());
        }
        return;
      }
    }
  }

  if (!results) return;

  const items = results.querySelectorAll(".ss-result-item:not(.ss-hidden)");
  if (items.length === 0) return;

  const active = results.querySelector(".ss-result-item.active");
  let index = active ? Array.from(items).indexOf(active) : -1;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    index = Math.min(index + 1, items.length - 1);
    items.forEach((el) => el.classList.remove("active"));
    items[index].classList.add("active");
    items[index].scrollIntoView({ block: "nearest" });
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    index = Math.max(index - 1, 0);
    items.forEach((el) => el.classList.remove("active"));
    items[index].classList.add("active");
    items[index].scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter" && active) {
    e.preventDefault();
    if (active.classList.contains("ss-page-group")) {
      const pageId = Number(active.getAttribute("data-page-id"));
      if (e.shiftKey) {
        const displayItem = lastDisplayItems.find(
          (di) => di.kind === "page-group" && di.pageId === pageId,
        ) as DisplayPageGroup | undefined;
        if (displayItem) {
          const firstBlockId = displayItem.blocks[0]?.blockId;
          if (firstBlockId) {
            logseq.Editor.getBlock(firstBlockId).then((block) => {
              if (block?.page?.id) {
                logseq.Editor.openInRightSidebar(block.page.id);
              }
            });
          }
        }
      } else {
        togglePageGroup(pageId, results);
      }
    } else {
      (active as HTMLElement).dispatchEvent(
        new MouseEvent("click", { shiftKey: e.shiftKey, bubbles: true }),
      );
    }
  } else if (e.key === "Enter" && !active && input && document.activeElement === input) {
    e.preventDefault();
    const query = input.value.trim();
    if (query) performSearch(query);
  } else if (e.key === "c" && (e.ctrlKey || e.metaKey) && active) {
    e.preventDefault();
    if (active.classList.contains("ss-page-group")) {
      const pageId = Number(active.getAttribute("data-page-id"));
      const displayItem = lastDisplayItems.find(
        (item) => item.kind === "page-group" && item.pageId === pageId,
      ) as DisplayPageGroup | undefined;
      if (displayItem) copyPageReference(displayItem.pageName);
    } else {
      const blockId = active.getAttribute("data-block-id");
      if (blockId) copyBlockReference(blockId);
    }
  }
}

function addToHistory(query: string): void {
  if (!query) return;
  const existingIdx = queryHistory.indexOf(query);
  if (existingIdx !== -1) queryHistory.splice(existingIdx, 1);
  queryHistory.push(query);
  if (queryHistory.length > MAX_HISTORY) queryHistory.shift();
}

function hideModal(): void {
  if (progressInterval) {
    clearInterval(progressInterval);
    progressInterval = undefined;
  }
  addToHistory(lastQuery);
  logseq.hideMainUI();
  // Evict embedding cache after idle period
  if (evictTimer) clearTimeout(evictTimer);
  evictTimer = setTimeout(() => {
    invalidateEmbeddingCache();
    evictTimer = undefined;
  }, CACHE_EVICT_MS);
}

async function updateStatus(): Promise<void> {
  const statusEl = document.getElementById("ss-status");
  if (!statusEl) return;

  if (indexingState.status === "scanning") {
    statusEl.textContent = "Scanning for changes...";
    return;
  }

  if (indexingState.status === "indexing") {
    const { done, total } = indexingState.progress;
    statusEl.textContent = `Indexing... ${done}/${total}`;
    return;
  }

  // idle — stop polling
  if (progressInterval) {
    clearInterval(progressInterval);
    progressInterval = undefined;
  }

  try {
    const count = await getEmbeddingCount();
    statusEl.textContent =
      count > 0 ? `${count} blocks indexed` : "No blocks indexed";
  } catch {
    statusEl.textContent = "No blocks indexed";
  }
}

function startStatusPolling(): void {
  if (progressInterval) clearInterval(progressInterval);
  progressInterval = setInterval(() => updateStatus(), 500);
}

interface PageInfo {
  pageName: string;
  isJournal: boolean;
  journalDay: number | null;
}

async function fetchPageInfo(
  pageEntityId: number,
  cache: Map<number, PageInfo>,
): Promise<PageInfo> {
  const cached = cache.get(pageEntityId);
  if (cached) return cached;
  const page = await logseq.Editor.getPage(pageEntityId);
  const info: PageInfo = {
    pageName: page?.originalName ?? page?.name ?? "Unknown",
    isJournal: page?.["journal?"] ?? false,
    journalDay: page?.journalDay ?? null,
  };
  cache.set(pageEntityId, info);
  return info;
}

async function fetchBreadcrumbs(blockId: string, pageName: string): Promise<string[]> {
  const breadcrumbs: string[] = [pageName];
  const ancestors: string[] = [];
  let childUuid = blockId;
  while (childUuid) {
    try {
      const rows: [string, string][] = await logseq.DB.datascriptQuery(
        `[:find ?content ?uuid
          :where [?child :block/uuid #uuid "${childUuid}"]
                 [?child :block/parent ?parent]
                 [?parent :block/content ?content]
                 [?parent :block/uuid ?uuid]
                 (not [?parent :block/name _])]`,
      );
      if (!rows?.[0]) break;
      const [content, parentUuid] = rows[0];
      const firstLine = content.split("\n")[0];
      const truncated = firstLine.length > 50;
      ancestors.unshift(truncated ? firstLine.slice(0, 50) + "..." : firstLine);
      childUuid = parentUuid;
    } catch {
      break;
    }
  }
  breadcrumbs.push(...ancestors);
  return breadcrumbs;
}

async function scoredToDisplayBlock(
  scored: ScoredResult,
  pageCache: Map<number, PageInfo>,
): Promise<DisplayBlock | null> {
  try {
    const block = await logseq.Editor.getBlock(scored.blockId);
    if (!block) return null;

    let pageInfo: PageInfo = { pageName: "Unknown", isJournal: false, journalDay: null };
    if (block.page?.id) {
      pageInfo = await fetchPageInfo(block.page.id, pageCache);
    }

    const breadcrumbs = await fetchBreadcrumbs(scored.blockId, pageInfo.pageName);

    return {
      blockId: scored.blockId,
      pageId: scored.pageId,
      similarity: scored.similarity,
      adjustedScore: scored.adjustedScore,
      pageName: pageInfo.pageName,
      content: block.content ?? "",
      isJournal: pageInfo.isJournal,
      breadcrumbs,
    };
  } catch {
    return null;
  }
}

async function performSearch(query: string): Promise<void> {
  const resultsEl = document.getElementById("ss-results");
  if (!resultsEl) return;

  resultsEl.innerHTML = '<div class="ss-loading">Searching...</div>';
  lastQuery = query;

  try {
    const settings = getSettings();
    acquireSearchPriority();
    let queryEmbedding: number[];
    try {
      [queryEmbedding] = await embedTexts(
        [query],
        settings.apiEndpoint,
        settings.embeddingModel,
        settings.apiFormat,
        undefined,
        "query",
      );
    } finally {
      releaseSearchPriority();
    }

    const allEmbeddings = await getCachedEmbeddings();
    const candidates = searchEmbeddings(
      queryEmbedding,
      allEmbeddings,
      getOverfetchCount(settings.topK),
    );

    // Fetch page info for all candidates, build journalDays map
    const pageCache = new Map<number, PageInfo>();
    const journalDays = new Map<number, number | null>();
    const journalPageIds = new Set<number>();
    for (const c of candidates) {
      if (!journalDays.has(c.pageId)) {
        try {
          const block = await logseq.Editor.getBlock(c.blockId);
          if (block?.page?.id) {
            const info = await fetchPageInfo(block.page.id, pageCache);
            journalDays.set(c.pageId, info.journalDay);
            if (info.isJournal) journalPageIds.add(c.pageId);
          } else {
            journalDays.set(c.pageId, null);
          }
        } catch {
          journalDays.set(c.pageId, null);
        }
      }
    }

    // Apply time decay
    const scored = applyTimeDecay(candidates, journalDays);

    // Fetch display blocks for all scored candidates
    const displayBlockCache = new Map<string, DisplayBlock>();
    for (const s of scored) {
      if (!displayBlockCache.has(s.blockId)) {
        const db = await scoredToDisplayBlock(s, pageCache);
        if (db) displayBlockCache.set(s.blockId, db);
      }
    }

    // Store state for re-grouping when journal filter changes
    lastScoredResults = scored;
    lastDisplayBlockCache = displayBlockCache;
    lastJournalPageIds = journalPageIds;
    lastQueryWordCount = query.split(/\s+/).filter(Boolean).length;
    lastTopK = settings.topK;

    renderFilteredResults();
  } catch (err) {
    resultsEl.innerHTML = `<div class="ss-error">${(err as Error).message}</div>`;
  }
}

function renderBlockElement(block: DisplayBlock, extraClass = ""): HTMLDivElement {
  const item = document.createElement("div");
  item.className = `ss-result-item${extraClass ? " " + extraClass : ""}`;
  item.setAttribute("data-block-id", block.blockId);

  const score = Math.round(block.adjustedScore * 100);
  const preview =
    block.content.length > 150
      ? block.content.slice(0, 150) + "..."
      : block.content;

  const breadcrumbHtml = block.breadcrumbs
    .map((b) => `<span class="ss-breadcrumb-segment">${escapeHtml(b)}</span>`)
    .join('<span class="ss-breadcrumb-sep">›</span>');

  item.innerHTML = `
    <div class="ss-result-header">
      <span class="ss-similarity">${score}%</span>
      <span class="ss-breadcrumbs">${breadcrumbHtml}</span>
    </div>
    <div class="ss-result-content">${escapeHtml(preview)}</div>
    <button class="ss-ref-btn" title="Copy block reference (Ctrl+C)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
  `;

  const refBtn = item.querySelector(".ss-ref-btn")!;
  refBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    copyBlockReference(block.blockId);
  });

  item.addEventListener("click", async (e) => {
    if (e.shiftKey) {
      try {
        logseq.Editor.openInRightSidebar(block.blockId);
      } catch {
        // ignore sidebar errors
      }
      return;
    }
    try {
      const b = await logseq.Editor.getBlock(block.blockId);
      if (b?.page?.id) {
        const page = await logseq.Editor.getPage(b.page.id);
        if (page?.name) {
          logseq.Editor.scrollToBlockInPage(page.name, block.blockId);
        }
      }
    } catch {
      // ignore navigation errors
    }
    hideModal();
  });

  return item;
}

function togglePageGroup(pageId: number, container: HTMLElement): void {
  const expanded = expandedPageIds.has(pageId);
  if (expanded) {
    expandedPageIds.delete(pageId);
  } else {
    expandedPageIds.add(pageId);
  }
  const header = container.querySelector(`.ss-page-group[data-page-id="${pageId}"]`);
  const children = container.querySelector(`.ss-group-children[data-page-id="${pageId}"]`);
  if (header && children) {
    const toggle = header.querySelector(".ss-group-toggle");
    if (expanded) {
      (children as HTMLElement).style.display = "none";
      children.querySelectorAll(".ss-result-item").forEach((el) => el.classList.add("ss-hidden"));
      if (toggle) toggle.textContent = "\u25B6";
    } else {
      (children as HTMLElement).style.display = "";
      children.querySelectorAll(".ss-result-item").forEach((el) => el.classList.remove("ss-hidden"));
      if (toggle) toggle.textContent = "\u25BC";
    }
  }
}

function renderResults(items: DisplayItem[]): void {
  const resultsEl = document.getElementById("ss-results");
  if (!resultsEl) return;

  if (items.length === 0) {
    resultsEl.innerHTML = '<div class="ss-no-results">No results found</div>';
    return;
  }

  resultsEl.innerHTML = "";
  for (const item of items) {
    if (item.kind === "single-block") {
      resultsEl.appendChild(renderBlockElement(item.block));
    } else {
      const expanded = expandedPageIds.has(item.pageId);
      const score = Math.round(item.blocks[0].adjustedScore * 100);
      const blockCount = item.blocks.length;

      const header = document.createElement("div");
      header.className = "ss-result-item ss-page-group";
      header.setAttribute("data-page-id", String(item.pageId));
      header.innerHTML = `
        <div class="ss-result-header">
          <span class="ss-similarity">${score}%</span>
          <span class="ss-group-toggle">${expanded ? "\u25BC" : "\u25B6"}</span>
          <span class="ss-breadcrumbs"><span class="ss-breadcrumb-segment">${escapeHtml(item.pageName)}</span></span>
          <span class="ss-block-count">${blockCount} block${blockCount !== 1 ? "s" : ""}</span>
        </div>
        <button class="ss-ref-btn" title="Copy page reference (Ctrl+C)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
      `;

      const refBtn = header.querySelector(".ss-ref-btn")!;
      refBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        copyPageReference(item.pageName);
      });

      header.addEventListener("click", (e) => {
        if (e.shiftKey) {
          // Open page in sidebar — use first block's ID to find the page
          try {
            const firstBlockId = item.blocks[0]?.blockId;
            if (firstBlockId) {
              logseq.Editor.getBlock(firstBlockId).then((block) => {
                if (block?.page?.id) {
                  logseq.Editor.openInRightSidebar(block.page.id);
                }
              });
            }
          } catch {
            // ignore
          }
          return;
        }
        togglePageGroup(item.pageId, resultsEl);
      });

      resultsEl.appendChild(header);

      const childrenContainer = document.createElement("div");
      childrenContainer.className = "ss-group-children";
      childrenContainer.setAttribute("data-page-id", String(item.pageId));
      childrenContainer.style.display = expanded ? "" : "none";

      for (const block of item.blocks) {
        const el = renderBlockElement(block, `ss-grouped-block${expanded ? "" : " ss-hidden"}`);
        childrenContainer.appendChild(el);
      }

      resultsEl.appendChild(childrenContainer);
    }
  }
}

function buildDisplayItems(scored: ScoredResult[], journalPageIds: Set<number>): DisplayItem[] {
  const rankedItems = groupAndRank(scored, lastQueryWordCount, lastTopK, journalPageIds);
  const displayItems: DisplayItem[] = [];
  for (const item of rankedItems) {
    if (item.kind === "page-group") {
      const blocks: DisplayBlock[] = [];
      for (const s of item.blocks) {
        const db = lastDisplayBlockCache.get(s.blockId);
        if (db) blocks.push(db);
      }
      if (blocks.length === 0) continue;
      displayItems.push({
        kind: "page-group",
        pageId: item.pageId,
        pageName: blocks[0].pageName,
        pageScore: item.pageScore,
        isJournal: blocks[0].isJournal,
        blocks,
      });
    } else {
      const db = lastDisplayBlockCache.get(item.result.blockId);
      if (db) {
        displayItems.push({ kind: "single-block", block: db });
      }
    }
  }
  return displayItems;
}

function renderFilteredResults(): void {
  const checkbox = document.getElementById("ss-include-journal") as HTMLInputElement | null;
  const includeJournal = checkbox?.checked ?? true;

  const scored = includeJournal
    ? lastScoredResults
    : lastScoredResults.filter((s) => !lastJournalPageIds.has(s.pageId));

  lastDisplayItems = buildDisplayItems(scored, lastJournalPageIds);
  renderResults(lastDisplayItems);
}

function clearResults(): void {
  const resultsEl = document.getElementById("ss-results");
  if (resultsEl) resultsEl.innerHTML = "";
  lastDisplayItems = [];
  lastScoredResults = [];
  lastDisplayBlockCache.clear();
  lastJournalPageIds.clear();
  expandedPageIds.clear();
}

function copyBlockReference(blockId: string): void {
  navigator.clipboard.writeText(`((${blockId}))`).then(() => {
    logseq.UI.showMsg("Block reference copied to clipboard");
  });
}

function copyPageReference(pageName: string): void {
  navigator.clipboard.writeText(`[[${pageName}]]`).then(() => {
    logseq.UI.showMsg("Page reference copied to clipboard");
  });
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

export function showModal(): void {
  if (evictTimer) {
    clearTimeout(evictTimer);
    evictTimer = undefined;
  }
  // Invalidate cache so first search loads fresh from IDB
  invalidateEmbeddingCache();
  clearResults();
  logseq.showMainUI();
  if (indexingState.status === "idle") {
    startIndexing();
  } else {
    startStatusPolling();
  }
  historyIndex = -1;
  setTimeout(() => {
    const input = document.getElementById("ss-input") as HTMLInputElement;
    if (input) {
      input.value = lastQuery;
      input.focus();
      input.select();
      if (lastQuery) {
        performSearch(lastQuery);
      }
    }
  }, 50);
}

function startIndexing(): void {
  updateStatus();
  startStatusPolling();
  indexBlocks()
    .then(() => updateStatus())
    .catch(() => updateStatus());
}
