/**
 * Sync a note library with its folder, and import loose files: the orchestration both
 * hosts share (issue #720, epic #708). The web pages call it with the browser's file
 * access; KVox Desktop calls it with its own port (and `sequential: true`).
 *
 * `runLibrarySync`:
 *
 *   1. enumerate the folder (`scanFolder`), a manifest of path, size and mtime;
 *   2. `POST /notes/libraries/:id/scan` with it;
 *   3. when the server answers `hashNeeded` (known files whose size or mtime moved),
 *      hash just those (at most four at a time) and scan them again, so a file that was
 *      only touched is not uploaded;
 *   4. ask `confirm` with the cost estimate (skipped when there is nothing to upload);
 *   5. upload every file the server asked for into the batch that listed it.
 *
 * WHY "THE BATCH THAT LISTED IT": every scan that finds work opens its own batch, and a
 * batch completes when its items do. The follow-up scan of step 3 therefore carries
 * only the hashed entries (`complete: false`, so it marks nothing missing): the first
 * batch keeps the new and missing files, the second the changed ones, and neither is
 * left waiting for an upload that went elsewhere. A manifest larger than
 * `NOTE_LIBRARY_MAX_MANIFEST_ENTRIES` is sent in partial chunks the same way (a
 * library that large is never marked missing by a scan).
 *
 * PURE-ISH: no React, no DOM beyond `Blob`/`FormData`; everything external (the host,
 * the file port, the confirmation) is a parameter, so a test drives it with fakes.
 */

import {
  NOTE_IMPORT_EXTENSIONS,
  NOTE_LIBRARY_MAX_MANIFEST_ENTRIES,
  noteImportMimeTypeForExtension,
} from '@marinoscar/kvox-contract/notes';
import type { NoteLibraryManifestEntry } from '@marinoscar/kvox-contract/notes';

import { isKvoxApiError, scanFolder } from '../../../core/headless/index.js';
import type { KvoxFileAccessPort, KvoxFileEntry, KvoxFolderRef, KvoxWebHost } from '../../../core/headless/index.js';
import {
  closeImportBatch,
  createNoteImportBatch,
  scanNoteLibrary,
  uploadNoteImportFile,
} from '../clients/noteLibraries.js';
import type { NoteImportUploadResult } from '../clients/noteLibraries.js';
import { noteImportUploadErrorMessage } from '../utils/noteImportFailure.js';

// =============================================================================
// Shapes
// =============================================================================

/**
 * Where a sync or an import stands.
 *
 * @stability experimental
 */
export type LibrarySyncPhase = 'enumerating' | 'hashing' | 'uploading' | 'done';

/**
 * One file that did not go up.
 *
 * @stability experimental
 */
export interface LibrarySyncFailure {
  /** The library-relative path (or the file name, for an ad-hoc import). */
  path: string;
  /** A sentence for a person. */
  message: string;
  /** The machine-readable reason, when the server sent one (`details.reason`), or `too_large`. */
  reason?: string;
}

/**
 * A progress snapshot. A new object on every report.
 *
 * @stability experimental
 */
export interface LibrarySyncProgress {
  /** The current phase. */
  phase: LibrarySyncPhase;
  /** Files found (`enumerating`), hashed (`hashing`) or uploaded or failed (`uploading`). */
  done: number;
  /** The number of files the phase covers; while enumerating, the files found so far. */
  total: number;
  /** Bytes found (`enumerating`) or uploaded (`uploading`). */
  bytes: number;
  /** The total bytes to upload, during `uploading` and `done`. */
  totalBytes: number;
  /** The uploads that failed so far. */
  failed: LibrarySyncFailure[];
}

/**
 * What a scan found, as {@link RunLibrarySyncOptions.confirm} is asked.
 *
 * @stability experimental
 */
export interface LibrarySyncPlan {
  /** Files the library has never seen. */
  newCount: number;
  /** Known files whose content changed. */
  changedCount: number;
  /** Known files no longer in the folder. */
  missingCount: number;
  /** Known files that did not change. */
  unchangedCount: number;
  /** The paths that will be uploaded. */
  uploadPaths: string[];
  /** The server's cost estimate, summed over every scan of this sync. */
  estimate: LibrarySyncEstimate;
}

/**
 * The cost of a sync, as the server estimates it.
 *
 * @stability experimental
 */
export interface LibrarySyncEstimate {
  /** Files to upload. */
  files: number;
  /** Their total size in bytes. */
  bytes: number;
  /** Roughly how many input tokens an AI extraction of them would read. */
  approxInputTokens: number;
}

/**
 * The library a sync runs for: a `NoteLibrary`, or anything with its id.
 *
 * @stability experimental
 */
export interface LibrarySyncTarget {
  /** The library's id. */
  id: string;
}

/**
 * How a sync ended.
 *
 * @stability experimental
 */
export interface LibrarySyncResult {
  /**
   * The batch to show the person: the one with the most to watch (new files, or the
   * changed ones when there are no new ones). `null` when the scan found nothing to do.
   */
  batchId: string | null;
  /** Every batch the sync opened, in the order the scans opened them. */
  batchIds: string[];
  /** The plan the scans produced. */
  plan: LibrarySyncPlan;
  /** `confirm` said no: nothing was uploaded (the scan's batch may still list missing files). */
  cancelled: boolean;
  /** Files uploaded and queued. */
  uploaded: number;
  /** Files the server already held byte for byte (nothing queued). */
  skipped: number;
  /** The uploads that failed. */
  failed: LibrarySyncFailure[];
}

/**
 * Arguments of {@link runLibrarySync}.
 *
 * @stability experimental
 */
export interface RunLibrarySyncOptions {
  /** The host whose HTTP port carries the calls. */
  host: KvoxWebHost;
  /** The file access that reads the folder (`useKvoxFileAccess()`, or Desktop's). */
  port: KvoxFileAccessPort;
  /** The library, or just its id. */
  library: LibrarySyncTarget;
  /** The folder the library is bound to on this device. */
  ref: KvoxFolderRef;
  /** Stops the sync between files; the promise then rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Called with every progress snapshot. */
  onProgress?: (progress: LibrarySyncProgress) => void;
  /**
   * Asked once, after the scan, when there is something to upload. Resolve `false` to
   * stop before any byte is sent. Absent: proceed.
   */
  confirm?: (plan: LibrarySyncPlan) => boolean | Promise<boolean>;
  /** Upload one file at a time (KVox Desktop, which reads from disk in its main process). */
  sequential?: boolean;
  /** Parallel uploads when not `sequential`. Default 3. */
  concurrency?: number;
}

/** How many files are hashed at once. */
const HASH_CONCURRENCY = 4;
/** How many files go up at once by default. */
const DEFAULT_UPLOAD_CONCURRENCY = 3;

// =============================================================================
// Helpers
// =============================================================================

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Runs `worker` over `items` with at most `limit` in flight, in order of start. The
 * first rejection stops new starts and is rethrown once the in-flight ones settle.
 */
async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | null = null;
  const lane = async () => {
    while (failure === null && next < items.length) {
      if (signal?.aborted) {
        failure = { error: abortReason(signal) };
        return;
      }
      const index = next;
      next += 1;
      try {
        await worker(items[index]!, index);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane);
  await Promise.all(lanes);
  if (failure !== null) throw (failure as { error: unknown }).error;
}

function basename(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? path : path.slice(at + 1);
}

function extensionOf(name: string): string {
  const at = name.lastIndexOf('.');
  return at < 0 ? '' : name.slice(at + 1).toLowerCase();
}

/** The blob with a media type, when the reader left it empty (the server sniffs, but a type helps). */
function typed(blob: Blob, name: string): Blob {
  if (blob.type) return blob;
  const mime = noteImportMimeTypeForExtension(extensionOf(name));
  return mime ? new Blob([blob], { type: mime }) : blob;
}

function failureOf(path: string, error: unknown): LibrarySyncFailure {
  const failure: LibrarySyncFailure = { path, message: noteImportUploadErrorMessage(error) };
  if (isKvoxApiError(error)) {
    if (error.status === 413) failure.reason = 'too_large';
    else if (error.reason) failure.reason = error.reason;
  }
  return failure;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out.length > 0 ? out : [[]];
}

/** One upload job: a path and the batch it belongs to. */
interface UploadJob {
  path: string;
  batchId: string;
  size: number;
}

// =============================================================================
// runLibrarySync
// =============================================================================

/**
 * Brings a library up to date with its folder: enumerate, scan, hash what the server
 * asks for, confirm, upload. See the file header.
 *
 * @param options - Host, port, library, folder, signal, callbacks and concurrency.
 * @returns The batch to show, every batch opened, the plan and the per-file outcome.
 * @throws The signal's reason when aborted; a `KvoxApiError` when a scan fails; a
 *   `KvoxFileAccessError` when the folder cannot be read. A failed upload does not
 *   throw: it is collected in `failed`.
 *
 * @stability experimental
 */
export async function runLibrarySync(options: RunLibrarySyncOptions): Promise<LibrarySyncResult> {
  const batchIds: string[] = [];
  try {
    return await runLibrarySyncInner(options, batchIds);
  } finally {
    await closeBatches(options.host, batchIds);
  }
}

/** Closes every batch a run opened, best effort: an empty one must not stay `running`. */
async function closeBatches(host: KvoxWebHost, batchIds: readonly string[]): Promise<void> {
  for (const id of new Set(batchIds)) {
    try {
      await closeImportBatch(host, id);
    } catch {
      // Best effort; the server also reads an abandoned empty batch as cancelled.
    }
  }
}

async function runLibrarySyncInner(
  options: RunLibrarySyncOptions,
  batchIds: string[],
): Promise<LibrarySyncResult> {
  const { host, port, library, ref, signal, onProgress, confirm } = options;
  const failed: LibrarySyncFailure[] = [];
  const report = (progress: Omit<LibrarySyncProgress, 'failed'>) =>
    onProgress?.({ ...progress, failed: [...failed] });

  // 1. Enumerate.
  report({ phase: 'enumerating', done: 0, total: 0, bytes: 0, totalBytes: 0 });
  const found: KvoxFileEntry[] = await scanFolder(port, ref, {
    extensions: NOTE_IMPORT_EXTENSIONS,
    ...(signal ? { signal } : {}),
    onProgress: (p) => report({ phase: 'enumerating', done: p.found, total: p.found, bytes: p.bytes, totalBytes: 0 }),
  });
  throwIfAborted(signal);
  const byPath = new Map(found.map((entry) => [entry.path, entry]));
  const manifest: NoteLibraryManifestEntry[] = found.map((entry) => ({
    path: entry.path,
    size: entry.size,
    mtime: Math.trunc(entry.mtime),
  }));

  // 2. Scan, in chunks only when the manifest is larger than one request may carry.
  const chunks = chunk(manifest, NOTE_LIBRARY_MAX_MANIFEST_ENTRIES);
  const complete = chunks.length === 1;
  const jobs: UploadJob[] = [];
  const hashNeeded: string[] = [];
  let missingCount = 0;
  let unchangedCount = 0;
  let newCount = 0;
  const estimate: LibrarySyncEstimate = { files: 0, bytes: 0, approxInputTokens: 0 };

  const absorb = (answer: Awaited<ReturnType<typeof scanNoteLibrary>>, kind: 'new' | 'changed') => {
    if (answer.batchId) batchIds.push(answer.batchId);
    missingCount += answer.missing.length;
    unchangedCount += answer.unchanged;
    estimate.files += answer.estimate.files;
    estimate.bytes += answer.estimate.bytes;
    estimate.approxInputTokens += answer.estimate.approxInputTokens;
    if (kind === 'new') newCount += answer.upload.length;
    if (answer.upload.length > 0 && answer.batchId) {
      for (const path of answer.upload) {
        jobs.push({ path, batchId: answer.batchId, size: byPath.get(path)?.size ?? 0 });
      }
    }
  };

  for (const entries of chunks) {
    throwIfAborted(signal);
    const answer = await scanNoteLibrary(host, library.id, entries, complete, signal);
    absorb(answer, 'new');
    hashNeeded.push(...answer.hashNeeded);
  }

  // 3. Hash what the server could not decide on, then scan just those again.
  let changedCount = 0;
  if (hashNeeded.length > 0) {
    const hashes = new Map<string, string>();
    report({ phase: 'hashing', done: 0, total: hashNeeded.length, bytes: 0, totalBytes: 0 });
    await runPool(
      hashNeeded,
      HASH_CONCURRENCY,
      async (path) => {
        hashes.set(path, await port.hash(ref, path, signal));
        report({ phase: 'hashing', done: hashes.size, total: hashNeeded.length, bytes: 0, totalBytes: 0 });
      },
      signal,
    );
    throwIfAborted(signal);
    const hashed: NoteLibraryManifestEntry[] = hashNeeded.flatMap((path) => {
      const entry = byPath.get(path);
      const sha256 = hashes.get(path);
      return entry && sha256 ? [{ path, size: entry.size, mtime: Math.trunc(entry.mtime), sha256 }] : [];
    });
    for (const entries of chunk(hashed, NOTE_LIBRARY_MAX_MANIFEST_ENTRIES)) {
      if (entries.length === 0) continue;
      const answer = await scanNoteLibrary(host, library.id, entries, false, signal);
      changedCount += answer.upload.length;
      // A hashed file the server still calls unchanged was only touched.
      absorb({ ...answer, unchanged: entries.length - answer.upload.length }, 'changed');
    }
  }

  const plan: LibrarySyncPlan = {
    newCount,
    changedCount,
    missingCount,
    unchangedCount,
    uploadPaths: jobs.map((job) => job.path),
    estimate,
  };
  const primaryBatch = (jobs.length > 0 ? jobs[0]!.batchId : batchIds[0]) ?? null;
  const result = (overrides: Partial<LibrarySyncResult>): LibrarySyncResult => ({
    batchId: primaryBatch,
    batchIds,
    plan,
    cancelled: false,
    uploaded: 0,
    skipped: 0,
    failed,
    ...overrides,
  });

  const totalBytes = jobs.reduce((sum, job) => sum + job.size, 0);
  if (jobs.length === 0) {
    report({ phase: 'done', done: 0, total: 0, bytes: 0, totalBytes: 0 });
    return result({});
  }

  // 4. Confirm.
  throwIfAborted(signal);
  if (confirm && !(await confirm(plan))) {
    report({ phase: 'done', done: 0, total: jobs.length, bytes: 0, totalBytes });
    return result({ cancelled: true });
  }

  // 5. Upload.
  const counts = { done: 0, bytes: 0, uploaded: 0, skipped: 0 };
  const reportUpload = () =>
    report({ phase: 'uploading', done: counts.done, total: jobs.length, bytes: counts.bytes, totalBytes });
  reportUpload();
  const limit = options.sequential ? 1 : Math.max(1, options.concurrency ?? DEFAULT_UPLOAD_CONCURRENCY);
  await runPool(
    jobs,
    limit,
    async (job) => {
      try {
        const blob = await port.read(ref, job.path);
        throwIfAborted(signal);
        const name = basename(job.path);
        const entry = byPath.get(job.path);
        const answer: NoteImportUploadResult = await uploadNoteImportFile(
          host,
          job.batchId,
          {
            body: typed(blob, name),
            filename: name,
            path: job.path,
            ...(entry ? { mtime: entry.mtime } : {}),
          },
          signal,
        );
        if (answer?.skipped) counts.skipped += 1;
        else counts.uploaded += 1;
        counts.bytes += blob.size;
      } catch (error) {
        if (isAbort(error, signal)) throw signal?.aborted ? abortReason(signal) : error;
        failed.push(failureOf(job.path, error));
      }
      counts.done += 1;
      reportUpload();
    },
    signal,
  );

  report({ phase: 'done', done: counts.done, total: jobs.length, bytes: counts.bytes, totalBytes });
  return result({ uploaded: counts.uploaded, skipped: counts.skipped });
}

// =============================================================================
// importFilesAdHoc
// =============================================================================

/**
 * Arguments of {@link importFilesAdHoc}.
 *
 * @stability experimental
 */
export interface ImportFilesAdHocOptions {
  /** The host whose HTTP port carries the calls. */
  host: KvoxWebHost;
  /** The files picked or dropped. Check them first (`checkNoteImportFiles`). */
  files: readonly File[];
  /** Stops the import between files; the promise then rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Called with every progress snapshot (phase `uploading`, then `done`). */
  onProgress?: (progress: LibrarySyncProgress) => void;
  /** Parallel uploads. Default 3; 1 uploads one at a time. */
  concurrency?: number;
}

/**
 * How an ad-hoc import ended.
 *
 * @stability experimental
 */
export interface ImportFilesAdHocResult {
  /** The batch the files went into. */
  batchId: string;
  /** Files uploaded and queued. */
  uploaded: number;
  /** Files skipped by the server. */
  skipped: number;
  /** The uploads that failed. */
  failed: LibrarySyncFailure[];
}

/**
 * Imports loose files (picked or dropped) as notes: opens an ad-hoc batch and uploads
 * each file into it. A failed upload does not stop the others.
 *
 * @param options - Host, files, signal, progress and concurrency.
 * @returns The batch and the per-file outcome.
 * @throws When the batch cannot be opened, or the signal's reason when aborted.
 *
 * @stability experimental
 */
export async function importFilesAdHoc(options: ImportFilesAdHocOptions): Promise<ImportFilesAdHocResult> {
  const { host, files, signal, onProgress } = options;
  throwIfAborted(signal);
  const batchId = await createNoteImportBatch(host);
  try {
    return await importIntoBatch(options, batchId);
  } finally {
    await closeBatches(host, [batchId]);
  }
}

async function importIntoBatch(options: ImportFilesAdHocOptions, batchId: string): Promise<ImportFilesAdHocResult> {
  const { host, files, signal, onProgress } = options;
  const failed: LibrarySyncFailure[] = [];
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const counts = { done: 0, bytes: 0, uploaded: 0, skipped: 0 };
  const report = (phase: LibrarySyncPhase) =>
    onProgress?.({ phase, done: counts.done, total: files.length, bytes: counts.bytes, totalBytes, failed: [...failed] });
  report('uploading');

  await runPool(
    files,
    Math.max(1, options.concurrency ?? DEFAULT_UPLOAD_CONCURRENCY),
    async (file) => {
      // A file from a dropped or picked folder keeps its folder path; a loose file its name.
      const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
      const path = relative && relative.length > 0 ? relative : file.name;
      try {
        const answer = await uploadNoteImportFile(
          host,
          batchId,
          { body: typed(file, file.name), filename: file.name, path, mtime: file.lastModified },
          signal,
        );
        if (answer?.skipped) counts.skipped += 1;
        else counts.uploaded += 1;
        counts.bytes += file.size;
      } catch (error) {
        if (isAbort(error, signal)) throw signal?.aborted ? abortReason(signal) : error;
        failed.push(failureOf(path, error));
      }
      counts.done += 1;
      report('uploading');
    },
    signal,
  );

  report('done');
  return { batchId, uploaded: counts.uploaded, skipped: counts.skipped, failed };
}

// =============================================================================
// Client-side checks
// =============================================================================

/**
 * The default largest file the pickers accept, in bytes: 25 MiB, the server's default
 * `maxDocumentImportBytes`. The server is still the authority.
 *
 * @stability experimental
 */
export const NOTE_IMPORT_DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * A file the browser refused before upload, and why.
 *
 * @stability experimental
 */
export interface NoteImportRejectedFile {
  /** The file. */
  file: File;
  /** Why: `unsupported` extension, `empty`, or `too_large`. */
  reason: 'unsupported' | 'empty' | 'too_large';
}

/**
 * The files of a pick or a drop, split into those to upload and those refused.
 *
 * @stability experimental
 */
export interface NoteImportFileCheck {
  /** The files to upload. */
  accepted: File[];
  /** The files refused, with the reason. */
  rejected: NoteImportRejectedFile[];
}

/**
 * Checks picked or dropped files before any byte is sent: an importable extension
 * (`NOTE_IMPORT_EXTENSIONS`), not empty, not over `maxBytes`.
 *
 * @param files - The files.
 * @param maxBytes - The largest size accepted. Default {@link NOTE_IMPORT_DEFAULT_MAX_BYTES}.
 * @returns Accepted and rejected files.
 *
 * @stability experimental
 */
export function checkNoteImportFiles(
  files: Iterable<File>,
  maxBytes: number = NOTE_IMPORT_DEFAULT_MAX_BYTES,
): NoteImportFileCheck {
  const accepted: File[] = [];
  const rejected: NoteImportRejectedFile[] = [];
  for (const file of files) {
    if (noteImportMimeTypeForExtension(extensionOf(file.name)) === null) rejected.push({ file, reason: 'unsupported' });
    else if (file.size === 0) rejected.push({ file, reason: 'empty' });
    else if (file.size > maxBytes) rejected.push({ file, reason: 'too_large' });
    else accepted.push(file);
  }
  return { accepted, rejected };
}
