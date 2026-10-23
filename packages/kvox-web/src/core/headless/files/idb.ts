// =============================================================================
// A tiny key-value store over IndexedDB that degrades to memory
// =============================================================================
//
// The browser file access keeps two maps: folder id -> directory handle, and
// library id -> folder ref. A `FileSystemDirectoryHandle` is structured-
// cloneable, so IndexedDB is the only place it survives a reload (localStorage
// holds strings only).
//
// IndexedDB is absent in some contexts (a private window in older browsers, a
// test environment) and can throw at any step (quota, a blocked upgrade, a
// cleared profile). Every operation is therefore wrapped: a failure falls back
// to an in-memory mirror that every write also updates, so the port keeps
// working for the life of the page; it just forgets on reload.
// =============================================================================

/** The two object stores. */
export type FileAccessStoreName = 'folders' | 'library-folders';

const STORE_NAMES: readonly FileAccessStoreName[] = ['folders', 'library-folders'];

/** A string-keyed store per object store. */
export interface FileAccessKvStore {
  get<T>(store: FileAccessStoreName, key: string): Promise<T | undefined>;
  set(store: FileAccessStoreName, key: string, value: unknown): Promise<void>;
  delete(store: FileAccessStoreName, key: string): Promise<void>;
  entries<T>(store: FileAccessStoreName): Promise<Array<[string, T]>>;
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/**
 * Opens (lazily) the store. `factory` `null` or missing means memory only.
 *
 * @param dbName - The database name.
 * @param factory - The `IDBFactory`, normally `globalThis.indexedDB`.
 * @returns The store.
 */
export function createFileAccessKvStore(dbName: string, factory: IDBFactory | null | undefined): FileAccessKvStore {
  const memory = new Map<FileAccessStoreName, Map<string, unknown>>(
    STORE_NAMES.map((name) => [name, new Map<string, unknown>()]),
  );
  let dbPromise: Promise<IDBDatabase | null> | null = null;

  function open(): Promise<IDBDatabase | null> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise<IDBDatabase | null>((resolve) => {
      if (!factory) {
        resolve(null);
        return;
      }
      try {
        const request = factory.open(dbName, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          for (const name of STORE_NAMES) {
            if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return dbPromise;
  }

  async function withStore<T>(
    store: FileAccessStoreName,
    mode: IDBTransactionMode,
    run: (objectStore: IDBObjectStore) => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    try {
      const db = await open();
      if (!db) return { ok: false };
      const value = await run(db.transaction(store, mode).objectStore(store));
      return { ok: true, value };
    } catch {
      return { ok: false };
    }
  }

  const mem = (store: FileAccessStoreName) => memory.get(store) as Map<string, unknown>;

  return {
    async get<T>(store: FileAccessStoreName, key: string) {
      const result = await withStore(store, 'readonly', (s) => promisify(s.get(key)));
      if (result.ok && result.value !== undefined) return result.value as T;
      return mem(store).get(key) as T | undefined;
    },
    async set(store, key, value) {
      mem(store).set(key, value);
      await withStore(store, 'readwrite', (s) => promisify(s.put(value, key)));
    },
    async delete(store, key) {
      mem(store).delete(key);
      await withStore(store, 'readwrite', (s) => promisify(s.delete(key)));
    },
    async entries<T>(store: FileAccessStoreName) {
      const merged = new Map<string, T>();
      const result = await withStore(store, 'readonly', async (s) => {
        const [keys, values] = await Promise.all([promisify(s.getAllKeys()), promisify(s.getAll())]);
        return keys.map((key, index) => [String(key), values[index]] as [string, unknown]);
      });
      if (result.ok) for (const [key, value] of result.value) merged.set(key, value as T);
      for (const [key, value] of mem(store)) if (!merged.has(key)) merged.set(key, value as T);
      return Array.from(merged.entries());
    },
  };
}
