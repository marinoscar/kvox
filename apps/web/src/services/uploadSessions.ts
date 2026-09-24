/**
 * Resumable upload sessions — the "you left an upload unfinished" record.
 *
 * Issue #22, epic #19.
 *
 * =============================================================================
 * ⚠️ THE `File` IS NEVER STORED, AND THAT IS THE WHOLE DESIGN
 * =============================================================================
 *
 * IndexedDB can hold a `File`/`Blob` — that is exactly why the temptation
 * exists, and why this comment is here rather than a line of code. Doing it
 * would mean writing a SECOND FULL COPY of a multi-gigabyte recording into the
 * origin's storage quota, on a phone, while the first copy is still being
 * read. On iOS the quota for a web app is a fraction of free disk and eviction
 * is silent; on Android the write itself can fail mid-way. The failure mode is
 * the worst available: the upload dies because the app tried to make it
 * resumable.
 *
 * So what is persisted is a POINTER-SHAPED record — ids, a file name, a size,
 * a mtime — measured in bytes, not gigabytes. On return the user re-picks the
 * file from their own disk (where it already is), and `matchUploadSession`
 * checks it is the same one. That check is not a formality: uploading part 7
 * of a DIFFERENT file into a multipart upload produces an object that
 * assembles without error and is silently corrupt.
 *
 * =============================================================================
 * EVERY ACCESS DEGRADES TO "NO SESSIONS"
 * =============================================================================
 *
 * IndexedDB is absent or throws on open in more real situations than it works
 * in edge cases: Firefox private windows (historically), Safari with storage
 * blocked, an origin over quota, an embedded webview with storage disabled, a
 * user who cleared site data mid-session. Resume is a CONVENIENCE layered on
 * top of `GET …/upload/status`, which is the real resume mechanism — so every
 * function here swallows its failure and answers "nothing stored". A reader
 * gets an empty list, a writer silently does nothing, and uploads keep working
 * with the resume affordance simply absent.
 */

/** The persisted record. Small by construction — see the header. */
export interface UploadSessionRecord {
  /** The storage object being uploaded. Primary key. */
  objectId: string;
  /** The transcript this upload belongs to, when it exists yet. */
  transcriptId: string | null;
  fileName: string;
  size: number;
  /** `File.lastModified`, in epoch milliseconds. Part of the identity check. */
  lastModified: number;
  partSize: number;
  /** Epoch milliseconds, for "started 2 hours ago" and for pruning. */
  createdAt: number;
}

const DB_NAME = 'upload-sessions';
const DB_VERSION = 1;
const STORE_NAME = 'sessions';

/**
 * Read through an indirection rather than touching `globalThis.indexedDB`
 * directly, so a test can install a fake (jsdom implements no IndexedDB at
 * all) and so the "not available" branch is reachable.
 */
function getIndexedDB(): IDBFactory | null {
  try {
    return typeof indexedDB === 'undefined' ? null : indexedDB;
  } catch {
    return null;
  }
}

function openDatabase(): Promise<IDBDatabase | null> {
  const factory = getIndexedDB();
  if (!factory) return Promise.resolve(null);

  return new Promise<IDBDatabase | null>((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'objectId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    // Another tab holding an old version open. Nothing to do but give up:
    // resume is a convenience, and blocking here would hang the caller.
    request.onblocked = () => resolve(null);
  });
}

/** Run one transaction, resolving `fallback` on any failure at any stage. */
async function withStore<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore, resolve: (value: T) => void) => void,
  fallback: T,
): Promise<T> {
  let db: IDBDatabase | null = null;
  try {
    db = await openDatabase();
  } catch {
    return fallback;
  }
  if (!db) return fallback;

  return new Promise<T>((resolve) => {
    let settled = false;
    const settle = (value: T) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    try {
      const tx = db!.transaction(STORE_NAME, mode);
      tx.onerror = () => settle(fallback);
      tx.onabort = () => settle(fallback);
      work(tx.objectStore(STORE_NAME), settle);
    } catch {
      settle(fallback);
    }
  });
}

/** Record (or refresh) a session. Silently does nothing where storage is unavailable. */
export async function saveUploadSession(record: UploadSessionRecord): Promise<void> {
  await withStore<void>(
    'readwrite',
    (store, resolve) => {
      const request = store.put(record);
      request.onsuccess = () => resolve(undefined);
      request.onerror = () => resolve(undefined);
    },
    undefined,
  );
}

/** Every stored session, newest first. `[]` where storage is unavailable. */
export async function listUploadSessions(): Promise<UploadSessionRecord[]> {
  const records = await withStore<UploadSessionRecord[]>(
    'readonly',
    (store, resolve) => {
      const request = store.getAll();
      request.onsuccess = () => resolve((request.result as UploadSessionRecord[]) ?? []);
      request.onerror = () => resolve([]);
    },
    [],
  );
  return [...records].sort((a, b) => b.createdAt - a.createdAt);
}

export async function getUploadSession(objectId: string): Promise<UploadSessionRecord | null> {
  return withStore<UploadSessionRecord | null>(
    'readonly',
    (store, resolve) => {
      const request = store.get(objectId);
      request.onsuccess = () => resolve((request.result as UploadSessionRecord) ?? null);
      request.onerror = () => resolve(null);
    },
    null,
  );
}

export async function deleteUploadSession(objectId: string): Promise<void> {
  await withStore<void>(
    'readwrite',
    (store, resolve) => {
      const request = store.delete(objectId);
      request.onsuccess = () => resolve(undefined);
      request.onerror = () => resolve(undefined);
    },
    undefined,
  );
}

/**
 * The user re-picked a file that is not the one this session was started for.
 *
 * A dedicated error type rather than a string, because the caller has to be
 * able to tell it apart from a network failure: the remedy is "pick a
 * different file", not "try again".
 */
export class UploadSessionMismatchError extends Error {
  constructor(
    readonly session: UploadSessionRecord,
    readonly file: File,
  ) {
    super(
      `"${file.name}" does not match the interrupted upload of "${session.fileName}". ` +
        'Choose the same file to continue, or start a new upload.',
    );
    this.name = 'UploadSessionMismatchError';
  }
}

/**
 * The upload a session points at no longer exists on the server — issue #339.
 *
 * Since #322 the server purges a transcript whose upload was abandoned, which
 * takes its storage object with it, so a persisted session can outlive the
 * only thing it could ever resume into. By the time this is thrown the
 * session has ALREADY been discarded, so its card is gone: a caller treats it
 * as "nothing to show", never as an error message about a row that vanished.
 */
export class UploadSessionGoneError extends Error {
  constructor(readonly session: UploadSessionRecord) {
    super(`The upload of "${session.fileName}" no longer exists on the server.`);
    this.name = 'UploadSessionGoneError';
  }
}

/**
 * Is this the same file the session was started for?
 *
 * Name + size + `lastModified`, all three.
 *
 *   * **Size alone** collides constantly — two takes of the same recording
 *     setup are routinely byte-identical in length.
 *   * **Name alone** is the weakest of the three: `recording.m4a` is what
 *     every phone calls every file.
 *   * **`lastModified`** is what actually distinguishes a re-export or a
 *     re-record from the original, and it is millisecond-precision.
 *
 * A hash would be stronger and is deliberately rejected: hashing a 2 GB file
 * on a phone to decide whether to offer a resume costs more time and battery
 * than re-uploading the parts the check would have saved, and it has to happen
 * before the user sees any progress at all.
 */
export function matchUploadSession(session: UploadSessionRecord, file: File): boolean {
  return (
    session.fileName === file.name &&
    session.size === file.size &&
    session.lastModified === file.lastModified
  );
}

/** `matchUploadSession`, as a guard. Throws `UploadSessionMismatchError`. */
export function assertUploadSessionMatches(
  session: UploadSessionRecord,
  file: File,
): void {
  if (!matchUploadSession(session, file)) {
    throw new UploadSessionMismatchError(session, file);
  }
}
