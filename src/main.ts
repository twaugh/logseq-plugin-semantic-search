import "@logseq/libs";
import { settingsSchema } from "./settings";
import { getSettings } from "./settings";
import { indexBlocks } from "./indexer";
import { setGraphName } from "./storage";
import { createSearchModal, showModal } from "./ui";

async function main() {
  logseq.useSettingsSchema(settingsSchema);

  createSearchModal();

  // Register toolbar button
  logseq.App.registerUIItem("toolbar", {
    key: "semantic-search",
    template: `
      <a class="button" data-on-click="showSearch" title="Semantic Search">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"/>
          <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
      </a>
    `,
  });

  // Register model for toolbar click
  logseq.provideModel({
    showSearch() {
      showModal();
    },
  });

  // Register keyboard shortcut
  logseq.App.registerCommandShortcut(
    { binding: "alt+k" },
    () => { showModal(); },
    { label: "Semantic Search" },
  );

  // Auto-index on load
  const settings = getSettings();
  if (settings.autoIndexOnLoad) {
    // Delay to let Logseq finish loading
    setTimeout(async () => {
      try {
        const graph = await logseq.App.getCurrentGraph();
        if (graph?.name) setGraphName(graph.name);
        await indexBlocks();
      } catch (err) {
        console.error("Auto-indexing failed:", err);
      }
    }, 3000);
  }

  // Re-index on graph change
  logseq.App.onCurrentGraphChanged(async () => {
    const graph = await logseq.App.getCurrentGraph();
    if (graph?.name) setGraphName(graph.name);
    const s = getSettings();
    if (s.autoIndexOnLoad) {
      setTimeout(() => {
        indexBlocks().catch((err) => {
          console.error("Indexing on graph change failed:", err);
        });
      }, 3000);
    }
  });
}

logseq.ready(main).catch(console.error);
