const DB_PREFIX = "semantic-search-embeddings";
const DB_VERSION = 1;
const EMBEDDINGS_STORE = "embeddings";
const METADATA_STORE = "metadata";

let graphName = "";

export function setGraphName(name: string): void {
  graphName = name;
}

function getDBName(): string {
  if (!graphName) return DB_PREFIX;
  return `${DB_PREFIX}-${graphName}`;
}

export interface EmbeddingRecord {
  blockId: string;
  embedding: number[];
  pageId: number;
  blockUpdatedAt: number;
  pageUpdatedAt: number;
}

export interface MetadataRecord {
  key: string;
  value: string | number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(getDBName(), DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(EMBEDDINGS_STORE)) {
        db.createObjectStore(EMBEDDINGS_STORE, { keyPath: "blockId" });
      }
      if (!db.objectStoreNames.contains(METADATA_STORE)) {
        db.createObjectStore(METADATA_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getMetadata(key: string): Promise<string | number | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(METADATA_STORE, "readonly");
    const store = tx.objectStore(METADATA_STORE);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result?.value);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

export async function setMetadata(key: string, value: string | number): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(METADATA_STORE, "readwrite");
    const store = tx.objectStore(METADATA_STORE);
    store.put({ key, value });
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function getEmbedding(blockId: string): Promise<EmbeddingRecord | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EMBEDDINGS_STORE, "readonly");
    const store = tx.objectStore(EMBEDDINGS_STORE);
    const req = store.get(blockId);
    req.onsuccess = () => resolve(req.result ?? undefined);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

export async function putEmbeddings(records: EmbeddingRecord[]): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EMBEDDINGS_STORE, "readwrite");
    const store = tx.objectStore(EMBEDDINGS_STORE);
    for (const record of records) {
      store.put(record);
    }
    tx.oncomplete = () => {
      db.close();
      invalidateEmbeddingCache();
      resolve();
    };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function getAllEmbeddings(): Promise<EmbeddingRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EMBEDDINGS_STORE, "readonly");
    const store = tx.objectStore(EMBEDDINGS_STORE);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

// In-memory embedding cache for fast repeated searches
let embeddingCache: EmbeddingRecord[] | null = null;

export async function getCachedEmbeddings(): Promise<EmbeddingRecord[]> {
  if (!embeddingCache) {
    embeddingCache = await getAllEmbeddings();
  }
  return embeddingCache;
}

export function invalidateEmbeddingCache(): void {
  embeddingCache = null;
}

export async function deleteEmbeddings(blockIds: string[]): Promise<void> {
  if (blockIds.length === 0) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EMBEDDINGS_STORE, "readwrite");
    const store = tx.objectStore(EMBEDDINGS_STORE);
    for (const id of blockIds) {
      store.delete(id);
    }
    tx.oncomplete = () => {
      db.close();
      invalidateEmbeddingCache();
      resolve();
    };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function clearAllEmbeddings(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EMBEDDINGS_STORE, "readwrite");
    const store = tx.objectStore(EMBEDDINGS_STORE);
    store.clear();
    tx.oncomplete = () => { db.close(); invalidateEmbeddingCache(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function getEmbeddingCount(): Promise<number> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EMBEDDINGS_STORE, "readonly");
    const store = tx.objectStore(EMBEDDINGS_STORE);
    const req = store.count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}
