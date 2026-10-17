// Tiny IndexedDB key-value store for the receiver's padlock key (deleted after download).
const open = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open('zerosight', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction('kv', mode).objectStore('kv'));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

export const idbGet = <T>(k: string) => run<T | undefined>('readonly', (s) => s.get(k)).catch(() => undefined);
export const idbSet = (k: string, v: unknown) => run<void>('readwrite', (s) => s.put(v, k));
export const idbDel = (k: string) => run<void>('readwrite', (s) => s.delete(k)).catch(() => undefined);
