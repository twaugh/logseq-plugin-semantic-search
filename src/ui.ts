import { debounce } from "./utils";
import { embedTexts } from "./embeddings";
import { getAllEmbeddings, getAllPageEmbeddings, getEmbeddingCount } from "./storage";
import { dotProduct, searchEmbeddings, searchPageEmbeddings } from "./search";
import { indexBlocks, indexingState, acquireSearchPriority, releaseSearchPriority } from "./indexer";
import { getSettings } from "./settings";

interface DisplayResult {
  type: "block" | "page";
  blockId: string;
  pageId: number;
  similarity: number;
  pageName: string;
  content: string;
  isJournal: boolean;
  breadcrumbs: string[];
}

let progressInterval: ReturnType<typeof setInterval> | undefined;
let lastDisplayResults: DisplayResult[] = [];
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
  }, 300);

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

  const items = results.querySelectorAll(".ss-result-item");
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
    (active as HTMLElement).dispatchEvent(
      new MouseEvent("click", { shiftKey: e.shiftKey, bubbles: true }),
    );
  } else if (e.key === "c" && (e.ctrlKey || e.metaKey) && active) {
    e.preventDefault();
    const type = active.getAttribute("data-type") as "block" | "page";
    if (type === "page") {
      const pageName = active.getAttribute("data-page-name");
      if (pageName) copyReference("page", pageName);
    } else {
      const blockId = active.getAttribute("data-block-id");
      if (blockId) copyReference("block", blockId);
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
      );
    } finally {
      releaseSearchPriority();
    }

    const [allEmbeddings, allPageEmbeddings] = await Promise.all([
      getAllEmbeddings(),
      getAllPageEmbeddings(),
    ]);
    const blockResults = searchEmbeddings(
      queryEmbedding,
      allEmbeddings,
      settings.topK,
    );
    const pageResults = searchPageEmbeddings(
      queryEmbedding,
      allPageEmbeddings,
      settings.topK,
    );

    // Fetch block details
    const displayResults: DisplayResult[] = [];
    for (const result of blockResults) {
      try {
        const block = await logseq.Editor.getBlock(result.blockId);
        if (!block) continue;

        let pageName = "Unknown";
        let isJournal = false;
        if (block.page?.id) {
          const page = await logseq.Editor.getPage(block.page.id);
          pageName = page?.originalName ?? page?.name ?? "Unknown";
          isJournal = page?.["journal?"] ?? false;
        }

        // Build breadcrumbs by walking up parent chain via datascript
        const breadcrumbs: string[] = [pageName];
        const ancestors: string[] = [];
        let childUuid = result.blockId;
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

        displayResults.push({
          type: "block",
          ...result,
          pageName,
          content: block.content ?? "",
          isJournal,
          breadcrumbs,
        });
      } catch {
        // Skip blocks we can't fetch
      }
    }

    // Fetch page previews from most relevant blocks
    for (const result of pageResults) {
      try {
        // Find the top 3 most similar blocks in this page
        const pageBlocks = allEmbeddings
          .filter((e) => e.pageId === result.pageId)
          .map((e) => ({ blockId: e.blockId, similarity: dotProduct(queryEmbedding, e.embedding) }))
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, 3);

        const previewLines: string[] = [];
        for (const pb of pageBlocks) {
          try {
            const block = await logseq.Editor.getBlock(pb.blockId);
            if (block?.content) {
              const line = block.content.split("\n")[0];
              previewLines.push(line.length > 80 ? line.slice(0, 80) + "..." : line);
            }
          } catch { /* skip */ }
        }

        displayResults.push({
          type: "page",
          blockId: "",
          pageId: result.pageId,
          similarity: result.similarity,
          pageName: result.pageName,
          content: previewLines.join(" · "),
          isJournal: result.isJournal,
          breadcrumbs: [result.pageName],
        });
      } catch {
        // Skip pages we can't fetch
      }
    }

    // Sort merged results by similarity
    displayResults.sort((a, b) => b.similarity - a.similarity);
    // Trim to topK
    lastDisplayResults = displayResults.slice(0, settings.topK);
    renderFilteredResults();
  } catch (err) {
    resultsEl.innerHTML = `<div class="ss-error">${(err as Error).message}</div>`;
  }
}

function renderResults(results: DisplayResult[]): void {
  const resultsEl = document.getElementById("ss-results");
  if (!resultsEl) return;

  if (results.length === 0) {
    resultsEl.innerHTML = '<div class="ss-no-results">No results found</div>';
    return;
  }

  resultsEl.innerHTML = "";
  for (const result of results) {
    const item = document.createElement("div");
    item.className = result.type === "page" ? "ss-result-item ss-page-result" : "ss-result-item";
    item.setAttribute("data-type", result.type);
    if (result.type === "block") {
      item.setAttribute("data-block-id", result.blockId);
    } else {
      item.setAttribute("data-page-name", result.pageName);
    }

    const similarity = Math.round(result.similarity * 100);
    const preview =
      result.content.length > 150
        ? result.content.slice(0, 150) + "..."
        : result.content;

    const copyTitle = result.type === "page"
      ? "Copy page reference (Ctrl+C)"
      : "Copy block reference (Ctrl+C)";

    if (result.type === "page") {
      item.innerHTML = `
        <div class="ss-result-header">
          <span class="ss-similarity">${similarity}%</span>
          <span class="ss-page-label">Page</span>
          <span class="ss-breadcrumbs"><span class="ss-breadcrumb-segment">${escapeHtml(result.pageName)}</span></span>
        </div>
        <div class="ss-result-content">${escapeHtml(preview)}</div>
        <button class="ss-ref-btn" title="${copyTitle}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
      `;
    } else {
      const breadcrumbHtml = result.breadcrumbs
        .map((b) => `<span class="ss-breadcrumb-segment">${escapeHtml(b)}</span>`)
        .join('<span class="ss-breadcrumb-sep">›</span>');

      item.innerHTML = `
        <div class="ss-result-header">
          <span class="ss-similarity">${similarity}%</span>
          <span class="ss-breadcrumbs">${breadcrumbHtml}</span>
        </div>
        <div class="ss-result-content">${escapeHtml(preview)}</div>
        <button class="ss-ref-btn" title="${copyTitle}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
      `;
    }

    const refBtn = item.querySelector(".ss-ref-btn")!;
    refBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (result.type === "page") {
        copyReference("page", result.pageName);
      } else {
        copyReference("block", result.blockId);
      }
    });

    item.addEventListener("click", async (e) => {
      if (result.type === "page") {
        if (e.shiftKey) {
          try {
            const page = await logseq.Editor.getPage(result.pageName);
            if (page) logseq.Editor.openInRightSidebar(page.uuid);
          } catch { /* ignore */ }
          return;
        }
        try {
          logseq.App.pushState("page", { name: result.pageName });
        } catch { /* ignore */ }
      } else {
        if (e.shiftKey) {
          try {
            logseq.Editor.openInRightSidebar(result.blockId);
          } catch { /* ignore */ }
          return;
        }
        try {
          const block = await logseq.Editor.getBlock(result.blockId);
          if (block?.page?.id) {
            const page = await logseq.Editor.getPage(block.page.id);
            if (page?.name) {
              logseq.Editor.scrollToBlockInPage(page.name, result.blockId);
            }
          }
        } catch { /* ignore */ }
      }
      hideModal();
    });

    resultsEl.appendChild(item);
  }
}

function renderFilteredResults(): void {
  const checkbox = document.getElementById("ss-include-journal") as HTMLInputElement | null;
  const includeJournal = checkbox?.checked ?? true;
  const filtered = includeJournal
    ? lastDisplayResults
    : lastDisplayResults.filter((r) => !r.isJournal);
  renderResults(filtered);
}

function clearResults(): void {
  const resultsEl = document.getElementById("ss-results");
  if (resultsEl) resultsEl.innerHTML = "";
  lastDisplayResults = [];
}

function copyReference(type: "block" | "page", id: string): void {
  const text = type === "page" ? `[[${id}]]` : `((${id}))`;
  const label = type === "page" ? "Page" : "Block";
  navigator.clipboard.writeText(text).then(() => {
    logseq.UI.showMsg(`${label} reference copied to clipboard`);
  });
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

export function showModal(): void {
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
