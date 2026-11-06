/**
 * Unpack a ZIP archive in the browser, for a bulk note import (issue #813, epic #811).
 *
 * The inner files go through the existing per-file upload route, one `File` each, so the
 * server needs no archive support and KVox Desktop gets the feature through this package.
 *
 * HOW IT READS: fflate's streaming `Unzip` is fed the archive in chunks (`file.stream()`,
 * or `Blob.slice` reads where a stream is not available), so the archive itself is never
 * held in memory whole; only the accepted entries are. The central directory at the end of
 * the archive is read first (a few `slice` reads) for what the local headers do not say
 * reliably: the encryption flag and the sizes of entries written with a data descriptor.
 *
 * WHAT IT SKIPS, each with a reason the pre-flight dialog shows: system files (`__MACOSX/`,
 * dotfiles and dot-folders, `~$` Office lock files), unsafe paths (`..`, absolute),
 * nested archives, encrypted entries, entries that are not an importable type, empty
 * entries, and entries over the limits below. Directories are skipped silently.
 *
 * LIMITS mirror `OOXML_LIMITS` of the API's OOXML reader: at most 500 accepted entries,
 * 25 MiB per entry (counted while inflating; the entry is dropped once it passes), 1 GiB
 * inflated in all (the expansion stops), and a 200:1 compression ratio per entry from
 * 1 MiB up. These are user-experience checks: the server still validates every file.
 *
 * PURE-ISH: no React; `File`, `Blob` and `TextDecoder` only.
 */

import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate';
import type { UnzipFile } from 'fflate';

import { normalizeLibraryPath, noteImportMimeTypeForExtension } from '@marinoscar/kvox-contract/notes';

// =============================================================================
// Shapes
// =============================================================================

/**
 * Why an archive entry was not taken.
 *
 * - `system_file`: `__MACOSX/`, a dotfile or dot-folder, or a `~$` Office lock file.
 * - `unsafe_path`: the entry's path climbs out of the archive (`..`) or is absolute.
 * - `nested_archive`: a ZIP inside the ZIP (not expanded).
 * - `encrypted`: the entry is password protected.
 * - `in_archive_unsupported`: not a type KVox imports.
 * - `empty`: no bytes.
 * - `too_large`: over the per-entry limit.
 * - `archive_limit`: over the entry count, the total size or the compression ratio.
 * - `unreadable`: the entry's data could not be inflated.
 *
 * @stability experimental
 */
export type ArchiveEntryRejectReason =
  | 'system_file'
  | 'unsafe_path'
  | 'nested_archive'
  | 'encrypted'
  | 'in_archive_unsupported'
  | 'empty'
  | 'too_large'
  | 'archive_limit'
  | 'unreadable';

/**
 * An archive entry that was not taken.
 *
 * @stability experimental
 */
export interface ArchiveRejectedEntry {
  /** The entry's file name (last path segment). */
  name: string;
  /** Where it was: `<archive stem>/<path inside the archive>` (the raw name when unsafe). */
  path: string;
  /** Why. */
  reason: ArchiveEntryRejectReason;
  /** Its uncompressed size, when known. */
  size?: number;
}

/**
 * An archive entry that was taken: a `File` named by its last segment, and the path to
 * upload it under.
 *
 * @stability experimental
 */
export interface ArchiveExpandedFile {
  /** The bytes, named by the entry's last path segment, typed by its extension. */
  file: File;
  /** `<archive stem>/<path inside the archive>`: the upload's `path` field. */
  path: string;
}

/**
 * Counts of one expansion.
 *
 * @stability experimental
 */
export interface ArchiveExpandTotals {
  /** File entries seen (directories excluded). */
  entries: number;
  /** Entries taken. */
  accepted: number;
  /**
   * `accepted` plus the importable entries dropped only because `maxEntries` was
   * reached: what a batch of everything would hold.
   */
  importable: number;
  /** Bytes inflated into accepted entries. */
  inflatedBytes: number;
  /** The expansion stopped early at `maxTotalBytes`; later entries were not read. */
  stopped: boolean;
}

/**
 * What {@link expandZipArchive} returns.
 *
 * @stability experimental
 */
export interface ArchiveExpandResult {
  /** The entries taken, in archive order. */
  files: ArchiveExpandedFile[];
  /** The entries skipped, with the reason. */
  rejected: ArchiveRejectedEntry[];
  /** Counts. */
  totals: ArchiveExpandTotals;
}

/**
 * Limits and callbacks of {@link expandZipArchive}.
 *
 * @stability experimental
 */
export interface ExpandZipArchiveOptions {
  /** Most entries taken. Default 500 ({@link ARCHIVE_EXPAND_LIMITS}). */
  maxEntries?: number;
  /** Largest entry, uncompressed. Default 25 MiB. */
  maxEntryBytes?: number;
  /** Most bytes inflated in all; the expansion stops past it. Default 1 GiB. */
  maxTotalBytes?: number;
  /** Largest archive read at all. Default 1 GiB. */
  maxArchiveBytes?: number;
  /** Largest compression ratio of one entry (checked from 1 MiB up). Default 200. */
  maxRatio?: number;
  /** Stops the expansion; the promise rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Called as the archive is read. */
  onProgress?: (bytesRead: number, totalBytes: number) => void;
  /** Bytes read per chunk when the archive has no `stream()`. Default 4 MiB. */
  chunkBytes?: number;
}

/**
 * The default limits of {@link expandZipArchive}.
 *
 * @stability experimental
 */
export const ARCHIVE_EXPAND_LIMITS = {
  maxEntries: 500,
  maxEntryBytes: 25 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxArchiveBytes: 1024 * 1024 * 1024,
  maxRatio: 200,
  /** The ratio check applies to entries at least this large (inflated). */
  ratioFloorBytes: 1024 * 1024,
} as const;

/**
 * Why a whole archive could not be expanded: `archive_limit` (larger than
 * `maxArchiveBytes`) or `unreadable` (not a ZIP, or damaged).
 *
 * @stability experimental
 */
export class NoteArchiveError extends Error {
  /** The reason. */
  readonly reason: 'archive_limit' | 'unreadable';

  constructor(reason: 'archive_limit' | 'unreadable', message: string) {
    super(message);
    this.name = 'NoteArchiveError';
    this.reason = reason;
  }
}

// =============================================================================
// Helpers
// =============================================================================

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;
const ZIP_EMPTY_MAGIC = [0x50, 0x4b, 0x05, 0x06] as const;
const NESTED_ARCHIVE_EXTENSIONS = new Set(['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz']);

function extensionOf(name: string): string {
  const at = name.lastIndexOf('.');
  return at <= 0 ? '' : name.slice(at + 1).toLowerCase();
}

function basename(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  const at = trimmed.lastIndexOf('/');
  return at < 0 ? trimmed : trimmed.slice(at + 1);
}

/** `Notes 2024.zip` → `Notes 2024`. */
function archiveStem(name: string): string {
  const base = basename(name.replace(/\\/g, '/'));
  const at = base.lastIndexOf('.');
  const stem = at > 0 ? base.slice(0, at) : base;
  return stem.trim() || 'archive';
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/** A blob's bytes: `arrayBuffer()`, or a `FileReader` where the blob has none (older jsdom). */
async function readBlob(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
    reader.readAsArrayBuffer(blob);
  });
}

/** The archive in chunks: its stream when there is one, else `slice` reads. */
async function* chunksOf(file: Blob, chunkBytes: number): AsyncGenerator<Uint8Array> {
  const stream = typeof file.stream === 'function' ? file.stream() : null;
  if (stream && typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value && value.byteLength > 0) yield value instanceof Uint8Array ? value : new Uint8Array(value);
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // Already closed.
      }
    }
  }
  for (let at = 0; at < file.size; at += chunkBytes) {
    yield await readBlob(file.slice(at, Math.min(file.size, at + chunkBytes)));
  }
}

/**
 * Whether a file is a ZIP archive: a `.zip` name, or the `PK\x03\x04` magic bytes.
 *
 * @param file - The file.
 * @returns `true` for a ZIP.
 *
 * @stability experimental
 */
export async function isZipFile(file: Blob & { name?: string }): Promise<boolean> {
  if (typeof file.name === 'string' && extensionOf(file.name) === 'zip') return true;
  return hasZipMagic(file);
}

/** The `PK\x03\x04` (or empty-archive `PK\x05\x06`) magic bytes. */
async function hasZipMagic(file: Blob): Promise<boolean> {
  if (file.size < 4) return false;
  try {
    const head = await readBlob(file.slice(0, 4));
    return (
      ZIP_MAGIC.every((byte, at) => head[at] === byte) || ZIP_EMPTY_MAGIC.every((byte, at) => head[at] === byte)
    );
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// The central directory (sizes and flags the local headers may not carry)
// -----------------------------------------------------------------------------

/** What the central directory says about one entry. */
interface CentralEntry {
  encrypted: boolean;
  compressedSize: number;
  size: number;
  mtime: number | null;
}

const u16 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u32 = (b: Uint8Array, at: number) => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
const u64 = (b: Uint8Array, at: number) => u32(b, at) + u32(b, at + 4) * 0x1_0000_0000;

function latin1(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

/** The DOS date and time of a ZIP header, as epoch milliseconds (local time, as ZIP stores it). */
function dosTime(time: number, date: number): number | null {
  const year = ((date >> 9) & 0x7f) + 1980;
  const month = ((date >> 5) & 0x0f) - 1;
  const day = date & 0x1f;
  if (month < 0 || month > 11 || day < 1) return null;
  const ms = new Date(year, month, day, (time >> 11) & 0x1f, (time >> 5) & 0x3f, (time & 0x1f) * 2).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** The largest central directory read; a bigger one is ignored (the stream still works). */
const MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024;

/**
 * Reads the central directory, keyed by entry name (a list per name, in order: a name may
 * repeat). `null` when it cannot be found or read; the expansion then goes on without it.
 */
async function readCentralDirectory(file: Blob): Promise<Map<string, CentralEntry[]> | null> {
  try {
    const tailSize = Math.min(file.size, 22 + 0xffff);
    const tailStart = file.size - tailSize;
    const tail = await readBlob(file.slice(tailStart));
    let eocd = -1;
    for (let at = tail.length - 22; at >= 0; at -= 1) {
      if (u32(tail, at) === 0x06054b50) {
        eocd = at;
        break;
      }
    }
    if (eocd < 0) return null;
    let count = u16(tail, eocd + 10);
    let cdSize = u32(tail, eocd + 12);
    let cdOffset = u32(tail, eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      // ZIP64: the locator sits just before the end record.
      const locator = eocd - 20;
      if (locator < 0 || u32(tail, locator) !== 0x07064b50) return null;
      const recordOffset = u64(tail, locator + 8);
      const record = await readBlob(file.slice(recordOffset, recordOffset + 56));
      if (record.length < 56 || u32(record, 0) !== 0x06064b50) return null;
      count = u64(record, 32);
      cdSize = u64(record, 40);
      cdOffset = u64(record, 48);
    }
    if (cdSize > MAX_CENTRAL_DIRECTORY_BYTES || cdOffset + cdSize > file.size) return null;
    const cd = await readBlob(file.slice(cdOffset, cdOffset + cdSize));
    const out = new Map<string, CentralEntry[]>();
    let at = 0;
    for (let n = 0; n < count && at + 46 <= cd.length; n += 1) {
      if (u32(cd, at) !== 0x02014b50) return out.size > 0 ? out : null;
      const flags = u16(cd, at + 8);
      const time = u16(cd, at + 12);
      const date = u16(cd, at + 14);
      let compressedSize = u32(cd, at + 20);
      let size = u32(cd, at + 24);
      const nameLength = u16(cd, at + 28);
      const extraLength = u16(cd, at + 30);
      const commentLength = u16(cd, at + 32);
      const nameBytes = cd.subarray(at + 46, at + 46 + nameLength);
      const name = flags & 0x800 ? new TextDecoder().decode(nameBytes) : latin1(nameBytes);
      // ZIP64 sizes, in the extra field, for the values that overflowed.
      let extra = at + 46 + nameLength;
      const extraEnd = extra + extraLength;
      while (extra + 4 <= extraEnd) {
        const id = u16(cd, extra);
        const length = u16(cd, extra + 2);
        if (id === 0x0001) {
          let field = extra + 4;
          if (size === 0xffffffff) {
            size = u64(cd, field);
            field += 8;
          }
          if (compressedSize === 0xffffffff) compressedSize = u64(cd, field);
          break;
        }
        extra += 4 + length;
      }
      const list = out.get(name) ?? [];
      list.push({ encrypted: (flags & 0x1) !== 0, compressedSize, size, mtime: dosTime(time, date) });
      out.set(name, list);
      at = extraEnd + commentLength;
    }
    return out;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// The decoders: fflate's, behind a switch that drops an entry's bytes
// -----------------------------------------------------------------------------

/** One entry in flight. */
interface EntryState {
  /** Bytes are dropped (a skipped entry, or one that went over a limit). */
  drop: boolean;
}

interface FflateDecoder {
  ondata: (err: Error | null, data: Uint8Array, final: boolean) => void;
  push(chunk: Uint8Array, final: boolean): void;
}

type FflateDecoderClass = new (name: string, size?: number, originalSize?: number) => FflateDecoder;

/**
 * A decoder class for `compression` that reads `pending` when constructed: fflate builds a
 * decoder synchronously inside `UnzipFile.start()`, so the entry it serves is the one
 * `start()` was just called for. A dropped entry's bytes are discarded without inflating,
 * which also keeps fflate from buffering an entry nobody started.
 */
function switchedDecoder(
  compression: number,
  Inner: FflateDecoderClass | null,
  pending: { current: EntryState | null },
): FflateDecoderClass & { compression: number } {
  return class SwitchedDecoder implements FflateDecoder {
    static compression = compression;
    ondata: FflateDecoder['ondata'] = () => undefined;
    private readonly entry: EntryState;
    private readonly inner: FflateDecoder | null;

    constructor(name: string, size?: number, originalSize?: number) {
      this.entry = pending.current ?? { drop: true };
      this.inner = Inner && !this.entry.drop ? new Inner(name, size, originalSize) : null;
      if (this.inner) this.inner.ondata = (err, data, final) => this.ondata(err, data, final);
    }

    push(chunk: Uint8Array, final: boolean): void {
      if (this.entry.drop || !this.inner) return;
      this.inner.push(chunk, final);
    }
  };
}

// =============================================================================
// expandZipArchive
// =============================================================================

/** An entry's verdict before any byte is read. */
function classify(rawName: string): { skip: ArchiveEntryRejectReason | 'directory' | null; inner: string | null } {
  const posix = rawName.replace(/\\/g, '/');
  if (posix.endsWith('/')) return { skip: 'directory', inner: null };
  const segments = posix.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) return { skip: 'unsafe_path', inner: null };
  if (segments.some((segment) => segment === '__MACOSX' || segment.startsWith('.'))) {
    return { skip: 'system_file', inner: null };
  }
  const name = segments[segments.length - 1] ?? '';
  if (name.startsWith('~$') || name === 'Thumbs.db' || name === 'desktop.ini') return { skip: 'system_file', inner: null };
  const inner = normalizeLibraryPath(posix);
  if (inner === null) return { skip: 'unsafe_path', inner: null };
  const extension = extensionOf(name);
  if (NESTED_ARCHIVE_EXTENSIONS.has(extension)) return { skip: 'nested_archive', inner };
  if (noteImportMimeTypeForExtension(extension) === null) return { skip: 'in_archive_unsupported', inner };
  return { skip: null, inner };
}

/**
 * Unpacks a ZIP archive into importable `File`s, streaming, under limits. See the file
 * header for the skip rules and the limits.
 *
 * @param file - The archive.
 * @param options - Limits, signal and progress.
 * @returns The files taken (each with its upload path), the entries skipped and counts.
 * @throws {@link NoteArchiveError} when the archive is too large or not a readable ZIP;
 *   the signal's reason when aborted.
 *
 * @stability experimental
 */
export async function expandZipArchive(
  file: File,
  options: ExpandZipArchiveOptions = {},
): Promise<ArchiveExpandResult> {
  const limits = {
    maxEntries: options.maxEntries ?? ARCHIVE_EXPAND_LIMITS.maxEntries,
    maxEntryBytes: options.maxEntryBytes ?? ARCHIVE_EXPAND_LIMITS.maxEntryBytes,
    maxTotalBytes: options.maxTotalBytes ?? ARCHIVE_EXPAND_LIMITS.maxTotalBytes,
    maxArchiveBytes: options.maxArchiveBytes ?? ARCHIVE_EXPAND_LIMITS.maxArchiveBytes,
    maxRatio: options.maxRatio ?? ARCHIVE_EXPAND_LIMITS.maxRatio,
  };
  const { signal, onProgress } = options;
  if (signal?.aborted) throw abortReason(signal);
  if (file.size > limits.maxArchiveBytes) {
    throw new NoteArchiveError('archive_limit', 'The archive is larger than the limit.');
  }

  const stem = archiveStem(file.name);
  const central = await readCentralDirectory(file);
  const files: ArchiveExpandedFile[] = [];
  const rejected: ArchiveRejectedEntry[] = [];
  const totals: ArchiveExpandTotals = { entries: 0, accepted: 0, importable: 0, inflatedBytes: 0, stopped: false };
  let stop = false;
  // Kept-but-unfinished entries count toward `accepted` so the limit holds while they inflate.
  let reserved = 0;
  // Importable entries dropped only because `maxEntries` was reached.
  let overLimit = 0;

  const pending: { current: EntryState | null } = { current: null };
  const unzip = new Unzip();
  unzip.register(switchedDecoder(0, UnzipPassThrough as unknown as FflateDecoderClass, pending));
  unzip.register(switchedDecoder(8, UnzipInflate as unknown as FflateDecoderClass, pending));
  const registered = new Set([0, 8]);

  const reject = (path: string, name: string, reason: ArchiveEntryRejectReason, size?: number) =>
    rejected.push({ name, path, reason, ...(size !== undefined ? { size } : {}) });

  unzip.onfile = (entry: UnzipFile) => {
    const state: EntryState = { drop: true };
    const info = central?.get(entry.name)?.shift();
    const { skip, inner } = classify(entry.name);
    const name = basename(entry.name.replace(/\\/g, '/'));
    const path = inner ? `${stem}/${inner}` : entry.name;
    const knownSize = info?.size ?? entry.originalSize;
    const knownCompressed = info?.compressedSize ?? entry.size;

    if (skip !== 'directory') totals.entries += 1;
    if (stop) {
      // Past the total limit: not read. Reported once, below, as the archive stopping.
    } else if (skip === 'directory') {
      // Nothing to say.
    } else if (skip !== null) {
      reject(path, name, skip, knownSize);
    } else if (info?.encrypted || entry.compression === 99) {
      reject(path, name, 'encrypted', knownSize);
    } else if (entry.compression !== 0 && entry.compression !== 8) {
      reject(path, name, 'unreadable', knownSize);
    } else if (files.length + reserved >= limits.maxEntries) {
      overLimit += 1;
      reject(path, name, 'archive_limit', knownSize);
    } else if (knownSize !== undefined && knownSize > limits.maxEntryBytes) {
      reject(path, name, 'too_large', knownSize);
    } else if (
      knownSize !== undefined &&
      knownCompressed !== undefined &&
      knownSize >= ARCHIVE_EXPAND_LIMITS.ratioFloorBytes &&
      knownSize > Math.max(knownCompressed, 1) * limits.maxRatio
    ) {
      reject(path, name, 'archive_limit', knownSize);
    } else {
      state.drop = false;
    }

    if (!registered.has(entry.compression)) {
      registered.add(entry.compression);
      unzip.register(switchedDecoder(entry.compression, null, pending));
    }

    if (state.drop) {
      entry.ondata = () => undefined;
    } else {
      reserved += 1;
      const chunks: Uint8Array[] = [];
      let inflated = 0;
      const settle = () => {
        reserved -= 1;
        state.drop = true;
      };
      entry.ondata = (err, data, final) => {
        if (state.drop) return;
        if (err) {
          settle();
          reject(path, name, 'unreadable', knownSize);
          return;
        }
        if (data && data.byteLength > 0) {
          inflated += data.byteLength;
          if (inflated > limits.maxEntryBytes) {
            settle();
            reject(path, name, 'too_large');
            return;
          }
          if (
            knownCompressed !== undefined &&
            inflated >= ARCHIVE_EXPAND_LIMITS.ratioFloorBytes &&
            inflated > Math.max(knownCompressed, 1) * limits.maxRatio
          ) {
            settle();
            reject(path, name, 'archive_limit');
            return;
          }
          if (totals.inflatedBytes + inflated > limits.maxTotalBytes) {
            settle();
            stop = true;
            totals.stopped = true;
            reject(path, name, 'archive_limit');
            return;
          }
          chunks.push(data.slice());
        }
        if (final) {
          settle();
          if (inflated === 0) {
            reject(path, name, 'empty', 0);
            return;
          }
          const mime = noteImportMimeTypeForExtension(extensionOf(name)) ?? '';
          totals.inflatedBytes += inflated;
          files.push({
            file: new File(chunks as BlobPart[], name, {
              type: mime,
              lastModified: info?.mtime ?? file.lastModified,
            }),
            path,
          });
        }
      };
    }
    pending.current = state;
    try {
      entry.start();
    } catch {
      if (!state.drop) {
        reserved -= 1;
        state.drop = true;
        reject(path, name, 'unreadable', knownSize);
      }
    } finally {
      pending.current = null;
    }
  };

  let bytesRead = 0;
  let sawData = false;
  onProgress?.(0, file.size);
  try {
    for await (const chunk of chunksOf(file, options.chunkBytes ?? 4 * 1024 * 1024)) {
      if (signal?.aborted) throw abortReason(signal);
      sawData = true;
      unzip.push(chunk, false);
      bytesRead += chunk.byteLength;
      onProgress?.(Math.min(bytesRead, file.size), file.size);
      if (stop) break;
      // Let the page breathe between chunks (and a signal be raised).
      await Promise.resolve();
    }
    if (signal?.aborted) throw abortReason(signal);
    if (!stop) unzip.push(new Uint8Array(0), true);
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    if (totals.entries === 0) {
      throw new NoteArchiveError('unreadable', 'The archive could not be read. It may be damaged or not a ZIP file.');
    }
    // A damaged tail: keep what was read; the entry that was cut off is dropped.
  }
  if (!sawData || (totals.entries === 0 && central === null) || !(await hasZipMagic(file))) {
    throw new NoteArchiveError('unreadable', 'The archive could not be read. It may be damaged or not a ZIP file.');
  }

  totals.accepted = files.length;
  totals.importable = files.length + overLimit;
  return { files, rejected, totals };
}
