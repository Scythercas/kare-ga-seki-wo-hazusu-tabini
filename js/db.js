// IndexedDB ラッパー（設計書.md 8.3）
// 録音Blobは blobs ストアに、名前と録音メタは state ストアに置く。
// localStorage は容量的に使えない。サーバーには一切送信しない。

const DB_NAME = 'kare-ga-seki-wo-hazusu-tabini';
const DB_VERSION = 1;
const STORE_BLOBS = 'blobs';
const STORE_STATE = 'state';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_BLOBS)) db.createObjectStore(STORE_BLOBS);
      if (!db.objectStoreNames.contains(STORE_STATE)) db.createObjectStore(STORE_STATE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run(storeName, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const req = fn(tx.objectStore(storeName));
    tx.onabort = tx.onerror = () => reject(tx.error);
    tx.oncomplete = () => resolve(req ? req.result : undefined);
  }));
}

export const store = {
  putBlob: (key, blob) => run(STORE_BLOBS, 'readwrite', (s) => s.put(blob, key)),
  getBlob: (key) => run(STORE_BLOBS, 'readonly', (s) => s.get(key)),
  deleteBlob: (key) => run(STORE_BLOBS, 'readwrite', (s) => s.delete(key)),
  blobKeys: () => run(STORE_BLOBS, 'readonly', (s) => s.getAllKeys()),
  clearBlobs: () => run(STORE_BLOBS, 'readwrite', (s) => s.clear()),

  getState: () => run(STORE_STATE, 'readonly', (s) => s.get('app')),
  putState: (value) => run(STORE_STATE, 'readwrite', (s) => s.put(value, 'app')),
  clearState: () => run(STORE_STATE, 'readwrite', (s) => s.clear()),
};

// ストレージ退去の対象になると録音が消えるため、録音を始める前に永続化を要求する。
// 拒否されても致命的ではない（起動時の欠損チェックで録音画面に戻す）。
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch (_) { /* 未対応ブラウザは無視 */ }
  return false;
}
