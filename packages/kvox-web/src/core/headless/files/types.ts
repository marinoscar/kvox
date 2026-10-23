// =============================================================================
// The file-access port: how a library page reads a folder on the user's device
// =============================================================================
//
// A note library (epic #708) is a folder the user keeps on THEIR machine. The
// server never sees the folder: the client walks it, sends a manifest and
// uploads only the files the server asks for (`@marinoscar/kvox-contract/notes`,
// `note-library.ts`). This port is the client half of that walk.
//
// Two implementations exist:
//
//   - the browser one in this package (`createBrowserFileAccess`): the File
//     System Access API where the browser has it, an `<input webkitdirectory>`
//     otherwise;
//   - KVox Desktop's, over IPC to the main process (real paths, a watcher,
//     hashing off the renderer thread). Desktop sets it as `KvoxWebHost.files`.
//
// WHY A FOLDER IS AN OPAQUE REF: an absolute path is device-specific, leaks the
// user's directory layout and means nothing to a browser. A `KvoxFolderRef` is
// an id the implementation resolves itself; every path that crosses the port
// is POSIX and relative to that folder.
// =============================================================================

/**
 * A folder the user granted access to. Opaque: `id` means something only to the
 * {@link KvoxFileAccessPort} that issued it, and it is never an absolute path.
 *
 * @stability experimental
 */
export interface KvoxFolderRef {
  /** The implementation's id of the folder. */
  id: string;
  /** The folder's display name (its last path segment). */
  name: string;
}

/**
 * One file inside a folder.
 *
 * @stability experimental
 */
export interface KvoxFileEntry {
  /**
   * POSIX path relative to the folder, normalised with the contract's
   * `normalizeLibraryPath` (no leading slash, no `.` or `..` segment).
   */
  path: string;
  /** Size in bytes. */
  size: number;
  /** Last modified time, milliseconds since the epoch. */
  mtime: number;
}

/**
 * What a file-access implementation can do.
 *
 * @stability experimental
 */
export interface KvoxFileAccessCapabilities {
  /**
   * A picked folder survives a reload: {@link KvoxFileAccessPort.listFolders}
   * returns it and a library stays bound to it. `false` for the
   * `<input webkitdirectory>` fallback, whose files live only in memory.
   */
  persistentFolders: boolean;
  /** {@link KvoxFileAccessPort.watch} is implemented. */
  watch: boolean;
  /**
   * {@link KvoxFileAccessPort.hash} runs outside the page's thread (Desktop's
   * main process). When `false` a caller should hash sparingly: only the files
   * the server asks it to.
   */
  hashInHost: boolean;
}

/**
 * Options of {@link KvoxFileAccessPort.enumerate}.
 *
 * @stability experimental
 */
export interface KvoxEnumerateOptions {
  /** The extensions to yield, without the dot, any case (`NOTE_IMPORT_EXTENSIONS`). */
  extensions: readonly string[];
  /** Stops the walk; the iterator then throws the signal's reason. */
  signal?: AbortSignal;
}

/**
 * How the domain UI reads folders on the user's device.
 *
 * @remarks
 * A host capability: KVox Desktop implements it over IPC and sets it as
 * `KvoxWebHost.files`; the web edition leaves it out and the pages use the
 * browser implementation (`useKvoxFileAccess` picks). Every path is
 * POSIX and relative to its folder. `enumerate` skips hidden entries (a name
 * starting with `.`) and `node_modules`.
 *
 * The library-to-folder binding is per DEVICE (the same library may live in a
 * different folder on another machine, or nowhere), so it is stored by the
 * port, never by the server.
 *
 * @stability experimental
 * @extensionPoint host
 */
export interface KvoxFileAccessPort {
  /** What this implementation can do. */
  readonly capabilities: KvoxFileAccessCapabilities;
  /** Asks the user for a folder. Resolves `null` when they cancel. */
  pickFolder(): Promise<KvoxFolderRef | null>;
  /** The folders this device remembers. */
  listFolders(): Promise<KvoxFolderRef[]>;
  /** Forgets a folder (and every library binding to it). */
  forgetFolder(ref: KvoxFolderRef): Promise<void>;
  /** Walks the folder recursively, yielding the files with one of `extensions`. */
  enumerate(ref: KvoxFolderRef, options: KvoxEnumerateOptions): AsyncIterable<KvoxFileEntry>;
  /** The lower-case hex SHA-256 of one file's content. */
  hash(ref: KvoxFolderRef, path: string, signal?: AbortSignal): Promise<string>;
  /** One file's content. */
  read(ref: KvoxFolderRef, path: string): Promise<Blob>;
  /**
   * Calls `onChange` with the relative paths that changed (added, modified or
   * removed). Returns the unsubscribe function. Only when `capabilities.watch`.
   */
  watch?(ref: KvoxFolderRef, onChange: (paths: string[]) => void): () => void;
  /** The folder a library is bound to on this device, `null` when none or forgotten. */
  getLibraryFolder(libraryId: string): Promise<KvoxFolderRef | null>;
  /** Binds a library to a folder on this device; `null` unbinds it. */
  setLibraryFolder(libraryId: string, ref: KvoxFolderRef | null): Promise<void>;
}

/**
 * Why a file-access call failed.
 *
 * @stability experimental
 */
export type KvoxFileAccessErrorCode =
  /** The user (or the browser) refused read access to the folder. */
  | 'permission_denied'
  /** The folder ref is not one this port knows (forgotten, or from before a reload). */
  | 'unknown_folder'
  /** The path does not name a file in the folder. */
  | 'not_found'
  /** The environment cannot pick a folder at all. */
  | 'unsupported';

/**
 * The error a {@link KvoxFileAccessPort} rejects with for an expected failure.
 *
 * @stability experimental
 */
export class KvoxFileAccessError extends Error {
  /** The failure. */
  readonly code: KvoxFileAccessErrorCode;

  /**
   * @param code - The failure.
   * @param message - A human-readable explanation.
   */
  constructor(code: KvoxFileAccessErrorCode, message: string) {
    super(message);
    this.name = 'KvoxFileAccessError';
    this.code = code;
  }
}
