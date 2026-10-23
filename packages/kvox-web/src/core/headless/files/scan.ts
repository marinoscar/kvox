import type { KvoxFileAccessPort, KvoxFileEntry, KvoxFolderRef } from './types.js';

/**
 * Progress of {@link scanFolder}.
 *
 * @stability experimental
 */
export interface ScanFolderProgress {
  /** Files found so far. */
  found: number;
  /** Their total size in bytes so far. */
  bytes: number;
  /** The path of the file just found. */
  lastPath: string;
}

/**
 * Options of {@link scanFolder}.
 *
 * @stability experimental
 */
export interface ScanFolderOptions {
  /** The extensions to collect, without the dot (`NOTE_IMPORT_EXTENSIONS`). */
  extensions: readonly string[];
  /** Stops the scan; the promise then rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Called after every file found. */
  onProgress?(progress: ScanFolderProgress): void;
}

/**
 * Walks a folder and collects its files, reporting progress as it goes: the
 * manifest a library page sends to `POST /notes/libraries/:id/scan`.
 *
 * @param port - The file access ({@link KvoxFileAccessPort}).
 * @param ref - The folder.
 * @param options - Extensions, abort signal and progress callback.
 * @returns Every matching file, in walk order.
 *
 * @stability experimental
 */
export async function scanFolder(
  port: KvoxFileAccessPort,
  ref: KvoxFolderRef,
  options: ScanFolderOptions,
): Promise<KvoxFileEntry[]> {
  const entries: KvoxFileEntry[] = [];
  let bytes = 0;
  const enumerateOptions = options.signal
    ? { extensions: options.extensions, signal: options.signal }
    : { extensions: options.extensions };
  for await (const entry of port.enumerate(ref, enumerateOptions)) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
    }
    entries.push(entry);
    bytes += entry.size;
    options.onProgress?.({ found: entries.length, bytes, lastPath: entry.path });
  }
  return entries;
}
