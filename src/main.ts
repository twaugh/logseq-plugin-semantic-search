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
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2,22 L5,8 L9,8 L12,22" stroke-width="2"/>
          <line x1="1" y1="22" x2="13" y2="22" stroke-width="2"/>
          <rect x="4.5" y="5" width="5" height="3.5" rx="0.5" stroke-width="2" fill="currentColor" opacity="0.5"/>
          <path d="M5,5 Q7,2 9,5" stroke-width="2"/>
          <line x1="10" y1="6" x2="22" y2="2" stroke-width="1.2" opacity="0.6"/>
          <line x1="10" y1="8" x2="22" y2="13" stroke-width="1.2" opacity="0.6"/>
          <path d="M18,3 Q18.5,6.5 21.5,7 18.5,7.5 18,11 17.5,7.5 14.5,7 17.5,6.5 18,3" fill="currentColor" stroke="none" opacity="0.7"/>
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
