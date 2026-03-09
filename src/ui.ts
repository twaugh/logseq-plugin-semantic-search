import { debounce } from "./utils";
import { embedTexts } from "./embeddings";
import { getAllEmbeddings, getEmbeddingCount } from "./storage";
import { searchEmbeddings, type SearchResult } from "./search";
import { indexBlocks, indexingState } from "./indexer";
import { getSettings } from "./settings";

interface DisplayResult extends SearchResult {
  pageName: string;
  content: string;
  isJournal: boolean;
  breadcrumbs: string[];
}

let progressInterval: ReturnType<typeof setInterval> | undefined;
let lastDisplayResults: DisplayResult[] = [];

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
          <button class="ss-reindex" id="ss-reindex">Re-index</button>
        </div>
      </div>
    </div>
  `;

  const input = document.getElementById("ss-input") as HTMLInputElement;
  const closeBtn = document.getElementById("ss-close")!;
  const reindexBtn = document.getElementById("ss-reindex")!;
  const overlay = document.getElementById("ss-overlay")!;
  const journalCheckbox = document.getElementById("ss-include-journal") as HTMLInputElement;

  const debouncedSearch = debounce(async (...args: unknown[]) => {
    const query = args[0] as string;
    await performSearch(query);
  }, 300);

  input.addEventListener("input", () => {
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

  reindexBtn.addEventListener("click", () => {
    startIndexing();
  });

  document.addEventListener("keydown", handleKeydown);

  updateStatus();
}

function handleKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    hideModal();
    return;
  }

  const results = document.getElementById("ss-results");
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
    (active as HTMLElement).click();
  }
}

function hideModal(): void {
  if (progressInterval) {
    clearInterval(progressInterval);
    progressInterval = undefined;
  }
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

  try {
    const settings = getSettings();
    const [queryEmbedding] = await embedTexts(
      [query],
      settings.apiEndpoint,
      settings.embeddingModel,
      settings.apiFormat,
    );

    const allEmbeddings = await getAllEmbeddings();
    const results = searchEmbeddings(
      queryEmbedding,
      allEmbeddings,
      settings.topK,
    );

    // Fetch block details
    const displayResults: DisplayResult[] = [];
    for (const result of results) {
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

    lastDisplayResults = displayResults;
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
    item.className = "ss-result-item";

    const similarity = Math.round(result.similarity * 100);
    const preview =
      result.content.length > 150
        ? result.content.slice(0, 150) + "..."
        : result.content;

    const breadcrumbHtml = result.breadcrumbs
      .map((b) => `<span class="ss-breadcrumb-segment">${escapeHtml(b)}</span>`)
      .join('<span class="ss-breadcrumb-sep">›</span>');

    item.innerHTML = `
      <div class="ss-result-header">
        <span class="ss-similarity">${similarity}%</span>
        <span class="ss-breadcrumbs">${breadcrumbHtml}</span>
      </div>
      <div class="ss-result-content">${escapeHtml(preview)}</div>
    `;

    item.addEventListener("click", async () => {
      try {
        const block = await logseq.Editor.getBlock(result.blockId);
        if (block?.page?.id) {
          const page = await logseq.Editor.getPage(block.page.id);
          if (page?.name) {
            logseq.Editor.scrollToBlockInPage(page.name, result.blockId);
          }
        }
      } catch {
        // ignore navigation errors
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

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

export function showModal(): void {
  logseq.showMainUI();
  if (indexingState.status === "idle") {
    startIndexing();
  } else {
    startStatusPolling();
  }
  setTimeout(() => {
    const input = document.getElementById("ss-input") as HTMLInputElement;
    if (input) {
      input.value = "";
      input.focus();
    }
    clearResults();
  }, 50);
}

function startIndexing(): void {
  updateStatus();
  startStatusPolling();
  indexBlocks()
    .then(() => updateStatus())
    .catch(() => updateStatus());
}
