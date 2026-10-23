// =============================================================================
// The browser implementation of KvoxFileAccessPort
// =============================================================================
//
// Two modes, chosen once when the port is created:
//
//   1. FILE SYSTEM ACCESS (Chromium: `window.showDirectoryPicker`). The picked
//      `FileSystemDirectoryHandle` is stored in IndexedDB, so the folder
//      survives a reload; the browser asks the user again for read permission
//      after a restart (`queryPermission`, then `requestPermission`, which
//      needs a user gesture: call `enumerate` from a click handler the first
//      time after a reload).
//   2. DIRECTORY INPUT (Firefox, Safari): a hidden `<input type="file"
//      webkitdirectory>`. The browser hands over every `File` of the tree at
//      once; they live in memory only, so `persistentFolders` is `false` and a
//      library must be re-picked after a reload.
//
// =============================================================================
// WHY HASHING RUNS ON THE MAIN THREAD
// =============================================================================
//
// The web edition's CSP is `worker-src 'self'` (infra/nginx/csp.conf): an
// inline worker from a `blob:` URL is refused, and a packaged library cannot
// ship a separate worker file the host is guaranteed to serve. WebCrypto has no
// incremental digest either, so a file is read whole and digested with one
// `crypto.subtle.digest` call. The digest itself runs off the main thread in
// every engine; only the read blocks memory. A caller should therefore hash
// only the files the server asks it to (`capabilities.hashInHost` is `false`).
// =============================================================================

import { normalizeLibraryPath } from '@marinoscar/kvox-contract/notes';

import { createFileAccessKvStore } from './idb.js';
import type { FileAccessKvStore } from './idb.js';
import { KvoxFileAccessError } from './types.js';
import type {
  KvoxEnumerateOptions,
  KvoxFileAccessCapabilities,
  KvoxFileAccessPort,
  KvoxFileEntry,
  KvoxFolderRef,
} from './types.js';

// -----------------------------------------------------------------------------
// The slice of the File System Access API this file uses, declared
// structurally: TypeScript's DOM lib lacks `showDirectoryPicker` and the
// permission methods, and a structural shape is what a test fakes.
// -----------------------------------------------------------------------------

/**
 * A file handle, as far as the browser file access reads it.
 *
 * @stability experimental
 */
export interface BrowserFileHandleLike {
  /** Always `file`. */
  readonly kind: 'file';
  /** The entry's name. */
  readonly name: string;
  /** The file's current content and metadata. */
  getFile(): Promise<File>;
}

/**
 * A directory handle, as far as the browser file access reads it.
 *
 * @stability experimental
 */
export interface BrowserDirectoryHandleLike {
  /** Always `directory`. */
  readonly kind: 'directory';
  /** The entry's name. */
  readonly name: string;
  /** The direct children. */
  values(): AsyncIterable<BrowserDirectoryHandleLike | BrowserFileHandleLike>;
  /** A child directory by name. */
  getDirectoryHandle(name: string): Promise<BrowserDirectoryHandleLike>;
  /** A child file by name. */
  getFileHandle(name: string): Promise<BrowserFileHandleLike>;
  /** The current permission state. */
  queryPermission?(descriptor: { mode: 'read' }): Promise<PermissionState>;
  /** Asks the user for permission (needs a user gesture). */
  requestPermission?(descriptor: { mode: 'read' }): Promise<PermissionState>;
  /** Whether two handles name the same directory. */
  isSameEntry?(other: BrowserDirectoryHandleLike): Promise<boolean>;
}

/**
 * The globals the browser file access reads, injectable for a test.
 *
 * @stability experimental
 */
export interface BrowserFileAccessGlobals {
  /** The File System Access picker; absent outside Chromium. */
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite'; id?: string }) => Promise<BrowserDirectoryHandleLike>;
  /** The document the fallback input is attached to. */
  document?: Document;
}

/**
 * Options of {@link createBrowserFileAccess}.
 *
 * @stability experimental
 */
export interface BrowserFileAccessOptions {
  /** The globals to read; defaults to `window`. */
  globals?: BrowserFileAccessGlobals;
  /** The IndexedDB factory; defaults to `globalThis.indexedDB`. `null` keeps everything in memory. */
  indexedDB?: IDBFactory | null;
  /** The IndexedDB database name. Default `kvox-file-access`. */
  dbName?: string;
  /** Generates folder ids. Default `crypto.randomUUID`. */
  createId?: () => string;
  /** The WebCrypto to digest with. Default `globalThis.crypto.subtle`. */
  subtle?: SubtleCrypto;
}

interface StoredFolder {
  id: string;
  name: string;
  handle: BrowserDirectoryHandleLike;
}

const SKIPPED_DIRECTORIES = new Set(['node_modules']);

/** Whether a name is hidden or skipped (`.git`, `.DS_Store`, `node_modules`). */
function isSkippedName(name: string): boolean {
  return name.startsWith('.') || SKIPPED_DIRECTORIES.has(name);
}

function normalizeExtensions(extensions: readonly string[]): Set<string> {
  return new Set(extensions.map((extension) => extension.replace(/^\./, '').toLowerCase()));
}

function hasExtension(name: string, extensions: ReadonlySet<string>): boolean {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return false;
  return extensions.has(name.slice(dot + 1).toLowerCase());
}

/**
 * Whether a relative path may be yielded: every segment visible and not
 * skipped, and the file's extension wanted.
 */
function isWantedPath(path: string, extensions: ReadonlySet<string>): boolean {
  const segments = path.split('/');
  if (segments.some(isSkippedName)) return false;
  return hasExtension(segments[segments.length - 1] ?? '', extensions);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

function defaultCreateId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The lower-case hex SHA-256 of a blob, digested in one WebCrypto call.
 *
 * @param blob - The content.
 * @param subtle - The WebCrypto to use; defaults to `globalThis.crypto.subtle`.
 * @returns 64 hex characters.
 *
 * @stability experimental
 */
export async function sha256Hex(blob: Blob, subtle?: SubtleCrypto): Promise<string> {
  const crypto = subtle ?? (globalThis.crypto as Crypto | undefined)?.subtle;
  if (!crypto) throw new KvoxFileAccessError('unsupported', 'WebCrypto is not available: cannot hash a file.');
  const digest = await crypto.digest('SHA-256', await blob.arrayBuffer());
  return toHex(digest);
}

/**
 * The files of a directory input, by folder-relative path.
 *
 * @stability experimental
 */
export interface DirectoryInputFiles {
  /** The picked folder's name (the first segment of `webkitRelativePath`). */
  name: string;
  /** The files by normalised relative path. */
  files: Map<string, File>;
}

/**
 * Maps the files of an `<input webkitdirectory>` to folder-relative paths.
 *
 * `webkitRelativePath` starts with the picked folder's own name
 * (`Notes/2024/plan.md`); that first segment is the folder's name and is
 * dropped. Paths `normalizeLibraryPath` rejects are skipped.
 *
 * @param files - The input's files.
 * @returns The folder name and the files by relative path.
 *
 * @stability experimental
 */
export function filesFromDirectoryInput(files: Iterable<File>): DirectoryInputFiles {
  const byPath = new Map<string, File>();
  let name: string | null = null;
  for (const file of files) {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    const segments = relative.replace(/\\/g, '/').split('/');
    if (segments.length > 1) {
      name ??= segments[0] ?? null;
      segments.shift();
    }
    const path = normalizeLibraryPath(segments.join('/'));
    if (path !== null) byPath.set(path, file);
  }
  return { name: name || 'Folder', files: byPath };
}

/**
 * Creates the browser's {@link KvoxFileAccessPort}: File System Access where
 * the browser has it, an `<input webkitdirectory>` otherwise.
 *
 * @param options - Injection points for a test; the defaults read `window`.
 * @returns The port.
 *
 * @stability experimental
 */
export function createBrowserFileAccess(options: BrowserFileAccessOptions = {}): KvoxFileAccessPort {
  const globals: BrowserFileAccessGlobals =
    options.globals ?? (typeof window === 'undefined' ? {} : (window as unknown as BrowserFileAccessGlobals));
  const createId = options.createId ?? defaultCreateId;
  const subtle = options.subtle;

  if (typeof globals.showDirectoryPicker === 'function') {
    const idbFactory =
      options.indexedDB === undefined ? (globalThis.indexedDB as IDBFactory | undefined) : options.indexedDB;
    const store = createFileAccessKvStore(options.dbName ?? 'kvox-file-access', idbFactory);
    return createHandlePort(globals.showDirectoryPicker.bind(globals), store, createId, subtle);
  }
  return createInputPort(globals.document ?? (typeof document === 'undefined' ? undefined : document), createId, subtle);
}

// -----------------------------------------------------------------------------
// Shared: the library -> folder binding
// -----------------------------------------------------------------------------

function libraryBinding(
  store: FileAccessKvStore,
  isKnown: (ref: KvoxFolderRef) => Promise<boolean>,
): Pick<KvoxFileAccessPort, 'getLibraryFolder' | 'setLibraryFolder'> {
  return {
    async getLibraryFolder(libraryId) {
      const ref = await store.get<KvoxFolderRef>('library-folders', libraryId);
      if (!ref) return null;
      return (await isKnown(ref)) ? { id: ref.id, name: ref.name } : null;
    },
    async setLibraryFolder(libraryId, ref) {
      if (ref === null) await store.delete('library-folders', libraryId);
      else await store.set('library-folders', libraryId, { id: ref.id, name: ref.name });
    },
  };
}

async function unbindFolder(store: FileAccessKvStore, folderId: string): Promise<void> {
  for (const [libraryId, ref] of await store.entries<KvoxFolderRef>('library-folders')) {
    if (ref.id === folderId) await store.delete('library-folders', libraryId);
  }
}

// -----------------------------------------------------------------------------
// Mode 1: File System Access handles
// -----------------------------------------------------------------------------

function createHandlePort(
  showDirectoryPicker: NonNullable<BrowserFileAccessGlobals['showDirectoryPicker']>,
  store: FileAccessKvStore,
  createId: () => string,
  subtle: SubtleCrypto | undefined,
): KvoxFileAccessPort {
  const capabilities: KvoxFileAccessCapabilities = { persistentFolders: true, watch: false, hashInHost: false };

  async function folderOf(ref: KvoxFolderRef): Promise<StoredFolder> {
    const stored = await store.get<StoredFolder>('folders', ref.id);
    if (!stored) throw new KvoxFileAccessError('unknown_folder', `Unknown folder "${ref.name}".`);
    return stored;
  }

  async function ensureRead(handle: BrowserDirectoryHandleLike): Promise<void> {
    const descriptor = { mode: 'read' } as const;
    if (handle.queryPermission && (await handle.queryPermission(descriptor)) === 'granted') return;
    if (!handle.requestPermission) {
      if (!handle.queryPermission) return; // No permission model: access is implied.
      throw new KvoxFileAccessError('permission_denied', `Read access to "${handle.name}" was not granted.`);
    }
    if ((await handle.requestPermission(descriptor)) !== 'granted') {
      throw new KvoxFileAccessError('permission_denied', `Read access to "${handle.name}" was not granted.`);
    }
  }

  async function fileHandleAt(root: BrowserDirectoryHandleLike, path: string): Promise<BrowserFileHandleLike> {
    const normalized = normalizeLibraryPath(path);
    if (normalized === null) throw new KvoxFileAccessError('not_found', `Invalid path "${path}".`);
    const segments = normalized.split('/');
    const fileName = segments.pop() as string;
    try {
      let dir = root;
      for (const segment of segments) dir = await dir.getDirectoryHandle(segment);
      return await dir.getFileHandle(fileName);
    } catch {
      throw new KvoxFileAccessError('not_found', `No file "${normalized}" in "${root.name}".`);
    }
  }

  async function read(ref: KvoxFolderRef, path: string): Promise<Blob> {
    const { handle } = await folderOf(ref);
    await ensureRead(handle);
    return (await fileHandleAt(handle, path)).getFile();
  }

  async function* walk(
    dir: BrowserDirectoryHandleLike,
    prefix: string,
    extensions: ReadonlySet<string>,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<KvoxFileEntry> {
    for await (const entry of dir.values()) {
      throwIfAborted(signal);
      if (isSkippedName(entry.name)) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.kind === 'directory') {
        yield* walk(entry, relative, extensions, signal);
        continue;
      }
      if (!hasExtension(entry.name, extensions)) continue;
      const path = normalizeLibraryPath(relative);
      if (path === null) continue;
      const file = await entry.getFile();
      throwIfAborted(signal);
      yield { path, size: file.size, mtime: file.lastModified };
    }
  }

  return {
    capabilities,
    async pickFolder() {
      let handle: BrowserDirectoryHandleLike;
      try {
        handle = await showDirectoryPicker({ mode: 'read' });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return null;
        if ((error as { name?: string } | null)?.name === 'AbortError') return null;
        throw error;
      }
      // Picking the same folder again reuses its ref, so its library bindings hold.
      for (const [, stored] of await store.entries<StoredFolder>('folders')) {
        try {
          if (stored.handle.isSameEntry && (await stored.handle.isSameEntry(handle))) {
            await store.set('folders', stored.id, { ...stored, handle });
            return { id: stored.id, name: stored.name };
          }
        } catch {
          // A stale handle cannot be compared; treat it as a different folder.
        }
      }
      const folder: StoredFolder = { id: createId(), name: handle.name, handle };
      await store.set('folders', folder.id, folder);
      return { id: folder.id, name: folder.name };
    },
    async listFolders() {
      return (await store.entries<StoredFolder>('folders')).map(([, stored]) => ({
        id: stored.id,
        name: stored.name,
      }));
    },
    async forgetFolder(ref) {
      await store.delete('folders', ref.id);
      await unbindFolder(store, ref.id);
    },
    enumerate(ref: KvoxFolderRef, opts: KvoxEnumerateOptions): AsyncIterable<KvoxFileEntry> {
      const extensions = normalizeExtensions(opts.extensions);
      return {
        async *[Symbol.asyncIterator]() {
          throwIfAborted(opts.signal);
          const { handle } = await folderOf(ref);
          await ensureRead(handle);
          yield* walk(handle, '', extensions, opts.signal);
        },
      };
    },
    async hash(ref, path, signal) {
      throwIfAborted(signal);
      const blob = await read(ref, path);
      throwIfAborted(signal);
      const hex = await sha256Hex(blob, subtle);
      throwIfAborted(signal);
      return hex;
    },
    read,
    ...libraryBinding(store, async (ref) => (await store.get('folders', ref.id)) !== undefined),
  };
}

// -----------------------------------------------------------------------------
// Mode 2: <input type="file" webkitdirectory>
// -----------------------------------------------------------------------------

function createInputPort(
  doc: Document | undefined,
  createId: () => string,
  subtle: SubtleCrypto | undefined,
): KvoxFileAccessPort {
  const capabilities: KvoxFileAccessCapabilities = { persistentFolders: false, watch: false, hashInHost: false };
  const folders = new Map<string, { ref: KvoxFolderRef; files: Map<string, File> }>();
  // The files are memory-only, so the bindings are too: they would point at nothing after a reload.
  const store = createFileAccessKvStore('kvox-file-access-memory', null);

  function folderOf(ref: KvoxFolderRef) {
    const folder = folders.get(ref.id);
    if (!folder) throw new KvoxFileAccessError('unknown_folder', `Unknown folder "${ref.name}"; pick it again.`);
    return folder;
  }

  async function read(ref: KvoxFolderRef, path: string): Promise<Blob> {
    const folder = folderOf(ref);
    const normalized = normalizeLibraryPath(path);
    const file = normalized === null ? undefined : folder.files.get(normalized);
    if (!file) throw new KvoxFileAccessError('not_found', `No file "${path}" in "${ref.name}".`);
    return file;
  }

  function pickFiles(): Promise<File[] | null> {
    if (!doc) {
      return Promise.reject(new KvoxFileAccessError('unsupported', 'No document: cannot pick a folder.'));
    }
    return new Promise((resolve) => {
      const input = doc.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.setAttribute('webkitdirectory', '');
      input.setAttribute('directory', '');
      input.style.display = 'none';
      input.setAttribute('aria-hidden', 'true');
      let settled = false;
      const finish = (files: File[] | null) => {
        if (settled) return;
        settled = true;
        input.remove();
        resolve(files);
      };
      input.addEventListener('change', () => finish(input.files ? Array.from(input.files) : null));
      input.addEventListener('cancel', () => finish(null));
      doc.body.appendChild(input);
      input.click();
    });
  }

  return {
    capabilities,
    async pickFolder() {
      const files = await pickFiles();
      if (!files || files.length === 0) return null;
      const { name, files: byPath } = filesFromDirectoryInput(files);
      const ref: KvoxFolderRef = { id: createId(), name };
      folders.set(ref.id, { ref, files: byPath });
      return { ...ref };
    },
    async listFolders() {
      return Array.from(folders.values(), ({ ref }) => ({ ...ref }));
    },
    async forgetFolder(ref) {
      folders.delete(ref.id);
      await unbindFolder(store, ref.id);
    },
    enumerate(ref: KvoxFolderRef, opts: KvoxEnumerateOptions): AsyncIterable<KvoxFileEntry> {
      const extensions = normalizeExtensions(opts.extensions);
      return {
        async *[Symbol.asyncIterator]() {
          throwIfAborted(opts.signal);
          const folder = folderOf(ref);
          for (const [path, file] of folder.files) {
            throwIfAborted(opts.signal);
            if (!isWantedPath(path, extensions)) continue;
            yield { path, size: file.size, mtime: file.lastModified };
          }
        },
      };
    },
    async hash(ref, path, signal) {
      throwIfAborted(signal);
      const hex = await sha256Hex(await read(ref, path), subtle);
      throwIfAborted(signal);
      return hex;
    },
    read,
    ...libraryBinding(store, async (ref) => folders.has(ref.id)),
  };
}
