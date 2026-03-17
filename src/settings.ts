import type { SettingSchemaDesc } from "@logseq/libs/dist/LSPlugin";

export const settingsSchema: SettingSchemaDesc[] = [
  {
    key: "apiHeading",
    type: "heading",
    default: "",
    title: "API",
    description: "",
  },
  {
    key: "apiEndpoint",
    type: "string",
    default: "http://localhost:11434",
    title: "API Endpoint",
    description: "Ollama (or compatible) server URL",
  },
  {
    key: "apiFormat",
    type: "enum",
    default: "ollama",
    title: "API Format",
    description: "API format: ollama (/api/embed) or openai (/v1/embeddings)",
    enumChoices: ["ollama", "openai"],
    enumPicker: "select",
  },
  {
    key: "embeddingModel",
    type: "string",
    default: "nomic-embed-text",
    title: "Embedding Model",
    description: "Model name for embedding requests",
  },
  {
    key: "searchHeading",
    type: "heading",
    default: "",
    title: "Search & Indexing",
    description: "",
  },
  {
    key: "topK",
    type: "number",
    default: 20,
    title: "Top K Results",
    description: "Maximum number of results to display",
  },
  {
    key: "batchSize",
    type: "number",
    default: 50,
    title: "Batch Size",
    description: "Number of texts per API request",
  },
  {
    key: "autoIndexOnLoad",
    type: "boolean",
    default: true,
    title: "Auto-index on Load",
    description: "Automatically index blocks when the graph loads",
  },
  {
    key: "propertiesHeading",
    type: "heading",
    default: "",
    title: "Properties",
    description: "",
  },
  {
    key: "pageProperties",
    type: "string",
    default: "tags, alias, category, type, description, summary, author, topic, area, project, status, priority, platform",
    title: "Page Properties",
    description: "Comma-separated list of page properties to include in embedding context",
  },
  {
    key: "blockProperties",
    type: "string",
    default: "type, status, priority, tags, source, url, author",
    title: "Block Properties",
    description: "Comma-separated list of block properties to include in embedding text",
  },
];

export interface PluginSettings {
  apiEndpoint: string;
  apiFormat: "ollama" | "openai";
  embeddingModel: string;
  batchSize: number;
  topK: number;
  autoIndexOnLoad: boolean;
  pageProperties: string;
  blockProperties: string;
}

export function getSettings(): PluginSettings {
  const s = logseq.settings as Partial<PluginSettings> | undefined;
  return {
    apiEndpoint: s?.apiEndpoint ?? "http://localhost:11434",
    apiFormat: s?.apiFormat ?? "ollama",
    embeddingModel: s?.embeddingModel ?? "nomic-embed-text",
    batchSize: s?.batchSize ?? 50,
    topK: s?.topK ?? 20,
    autoIndexOnLoad: s?.autoIndexOnLoad ?? true,
    pageProperties: s?.pageProperties ?? "tags, alias, category, type, description, summary, author, topic, area, project, status, priority, platform",
    blockProperties: s?.blockProperties ?? "type, status, priority, tags, source, url, author",
  };
}
