/**
 * A minimal in-memory IndexedDB — issue #22, epic #19.
 *
 * jsdom implements NO IndexedDB at all (`globalThis.indexedDB` is
 * `undefined`), and this repository has no `fake-indexeddb` dependency. Left
 * alone, `services/uploadSessions.ts` would take its "storage unavailable"
 * branch in every test and the whole persistence path — the one that makes
 * resume-after-reload work — would be permanently unexercised.
 *
 * So: just enough of the API for that module, and nothing more. `open` with
 * `onupgradeneeded`, one object store with a `keyPath`, and
 * `put`/`get`/`getAll`/`delete` requests that settle asynchronously exactly as
 * the real ones do (the module assigns `onsuccess` AFTER calling the method,
 * so a synchronous callback would never be seen).
 *
 * `failOpen()` is what makes the DEGRADATION path testable — a private window
 * or blocked storage, which is the common case this module promises to
 * survive.
 */

interface FakeStore {
  keyPath: string;
  data: Map<string, unknown>;
}

interface FakeDatabase {
  version: number;
  stores: Map<string, FakeStore>;
}

export interface FakeIndexedDbControl {
  /** Remove the fake and restore whatever was there before. */
  uninstall(): void;
  /** Make every `open()` fail, as a private window or blocked storage does. */
  failOpen(shouldFail: boolean): void;
  /** Drop all data, keeping the fake installed. */
  clear(): void;
  /** Direct access to a store's rows, for arranging fixtures. */
  rows(storeName: string): Map<string, unknown> | undefined;
}

function settle(run: () => void): void {
  // A macrotask, not a microtask: the real API settles a request after the
  // caller has finished the synchronous block that created it, and a test
  // that passes only under microtask timing is testing the fake.
  setTimeout(run, 0);
}

export function installFakeIndexedDB(): FakeIndexedDbControl {
  const databases = new Map<string, FakeDatabase>();
  let shouldFailOpen = false;

  const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');

  function makeRequest<T>(compute: () => T) {
    const request: {
      result: T | undefined;
      error: unknown;
      onsuccess: (() => void) | null;
      onerror: (() => void) | null;
    } = { result: undefined, error: null, onsuccess: null, onerror: null };

    settle(() => {
      try {
        request.result = compute();
        request.onsuccess?.();
      } catch (error) {
        request.error = error;
        request.onerror?.();
      }
    });

    return request;
  }

  function makeStoreHandle(store: FakeStore) {
    return {
      put: (value: Record<string, unknown>) =>
        makeRequest(() => {
          const key = String(value[store.keyPath]);
          store.data.set(key, value);
          return key;
        }),
      get: (key: string) => makeRequest(() => store.data.get(String(key))),
      getAll: () => makeRequest(() => [...store.data.values()]),
      delete: (key: string) =>
        makeRequest(() => {
          store.data.delete(String(key));
          return undefined;
        }),
    };
  }

  function makeDatabaseHandle(name: string, db: FakeDatabase) {
    return {
      name,
      get version() {
        return db.version;
      },
      objectStoreNames: {
        contains: (storeName: string) => db.stores.has(storeName),
      },
      createObjectStore: (storeName: string, options: { keyPath: string }) => {
        const store: FakeStore = { keyPath: options.keyPath, data: new Map() };
        db.stores.set(storeName, store);
        return makeStoreHandle(store);
      },
      transaction: (storeName: string) => {
        const store = db.stores.get(storeName);
        if (!store) {
          throw new Error(`NotFoundError: no object store named ${storeName}`);
        }
        return {
          onerror: null as (() => void) | null,
          onabort: null as (() => void) | null,
          oncomplete: null as (() => void) | null,
          objectStore: () => makeStoreHandle(store),
        };
      },
      close: () => {},
    };
  }

  const factory = {
    open: (name: string, version: number) => {
      const request: {
        result: unknown;
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        onupgradeneeded: (() => void) | null;
        onblocked: (() => void) | null;
      } = {
        result: undefined,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
        onblocked: null,
      };

      settle(() => {
        if (shouldFailOpen) {
          request.onerror?.();
          return;
        }
        let db = databases.get(name);
        const isNew = !db || db.version < version;
        if (!db) {
          db = { version, stores: new Map() };
          databases.set(name, db);
        }
        request.result = makeDatabaseHandle(name, db);
        if (isNew) {
          db.version = version;
          request.onupgradeneeded?.();
        }
        request.onsuccess?.();
      });

      return request;
    },
    deleteDatabase: (name: string) => makeRequest(() => databases.delete(name)),
  };

  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    writable: true,
    value: factory,
  });

  return {
    uninstall() {
      if (previousDescriptor) {
        Object.defineProperty(globalThis, 'indexedDB', previousDescriptor);
      } else {
        delete (globalThis as { indexedDB?: unknown }).indexedDB;
      }
    },
    failOpen(shouldFail: boolean) {
      shouldFailOpen = shouldFail;
    },
    clear() {
      databases.clear();
    },
    rows(storeName: string) {
      for (const db of databases.values()) {
        const store = db.stores.get(storeName);
        if (store) return store.data;
      }
      return undefined;
    },
  };
}
