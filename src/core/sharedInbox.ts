/**
 * Raw-IndexedDB inbox for files received via the PWA share target.
 * The service worker writes; the capture page reads + clears.
 * Kept dependency-free so it also compiles into the service worker bundle.
 */
const DB_NAME = 'workspace-shared';
const STORE = 'shared_inbox';

export interface SharedItem {
  id: string;
  file: Blob;
  name: string;
  mime: string;
  addedAt: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putShared(items: SharedItem[]): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    for (const item of items) tx.objectStore(STORE).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function takeShared(): Promise<SharedItem[]> {
  const db = await open();
  const items = await new Promise<SharedItem[]>((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as SharedItem[]);
    req.onerror = () => reject(req.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return items;
}
