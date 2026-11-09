/**
 * The upload of one note import batch, as an object that outlives the page that started
 * it (issue #814, epic #811). `BatchUploadProvider` keeps one per batch in a ref, so the
 * person can be sent to the batch page at once and watch every file from the first second.
 *
 * It uploads the files of a prepared manifest into an existing batch, `concurrency` at a
 * time, through the same per-file route `importFilesAdHoc` uses. It can pause (no new
 * file starts; those in flight finish), resume, cancel (aborts what is in flight, leaves
 * the rest unsent and closes the batch) and retry the files whose upload failed (the
 * `File` handles stay in memory for the life of the tab). When every file has settled it
 * closes the batch, like `importFilesAdHoc` does.
 *
 * PURE-ISH: no React. Every change is reported through `onChange` with a fresh snapshot.
 */

import { isKvoxApiError } from '../../../core/headless/index.js';
import type { KvoxWebHost } from '../../../core/headless/index.js';
import { noteImportMimeTypeForExtension } from '@marinoscar/kvox-contract/notes';
import { closeImportBatch, uploadNoteImportFile } from '../clients/noteLibraries.js';
import { noteImportUploadErrorMessage } from '../utils/noteImportFailure.js';
import type { NoteImportKind } from '../sync/prepareNoteImport.js';

// =============================================================================
// Shapes
// =============================================================================

/**
 * Where one file's upload stands.
 *
 * @stability experimental
 */
export type BatchUploadFileState = 'queued' | 'uploading' | 'uploaded' | 'skipped' | 'failed' | 'cancelled';

/**
 * One file of a batch upload.
 *
 * @stability experimental
 */
export interface BatchUploadFile {
  /** The path it is uploaded under (unique within the batch). */
  path: string;
  /** The file name. */
  name: string;
  /** Its size in bytes. */
  size: number;
  /** Its kind, when known. */
  kind?: NoteImportKind;
  /** Where it stands. */
  state: BatchUploadFileState;
  /** A sentence for a failed upload. */
  message?: string;
  /** The machine-readable reason of a failure, when the server sent one, or `too_large`. */
  reason?: string;
  /** The batch item the file became, once uploaded. */
  itemId?: string;
}

/**
 * Where a batch upload stands.
 *
 * - `uploading`: files are going up.
 * - `paused`: no new file starts.
 * - `done`: every file settled (some may have failed; they can be retried).
 * - `cancelled`: stopped by the person; unsent files stay unsent.
 *
 * @stability experimental
 */
export type BatchUploadStatus = 'uploading' | 'paused' | 'done' | 'cancelled';

/**
 * Counts of a batch upload's files by state.
 *
 * @stability experimental
 */
export type BatchUploadCounts = Record<BatchUploadFileState, number>;

/**
 * A snapshot of one batch upload. A new object on every change.
 *
 * @stability experimental
 */
export interface BatchUpload {
  /** The batch the files go into. */
  batchId: string;
  /** Where the upload stands. */
  status: BatchUploadStatus;
  /** Every file, in upload order. */
  files: BatchUploadFile[];
  /** Files by state. */
  counts: BatchUploadCounts;
  /** All files' bytes. */
  totalBytes: number;
  /** Bytes of the files uploaded (or skipped) so far. */
  uploadedBytes: number;
  /** When the upload started, epoch milliseconds. */
  startedAt: number;
  /** When it last settled (`done` or `cancelled`), epoch milliseconds. */
  finishedAt: number | null;
}

/**
 * One file to upload.
 *
 * @stability experimental
 */
export interface BatchUploadEntry {
  /** The bytes. */
  file: File;
  /** The path to upload it under. Default: the file's name. */
  path?: string;
  /** Its kind, when known. */
  kind?: NoteImportKind;
}

/**
 * Options of {@link createBatchUploadEngine}.
 *
 * @stability experimental
 */
export interface BatchUploadEngineOptions {
  /** The host whose HTTP port carries the calls. */
  host: KvoxWebHost;
  /** The batch, already created (`createNoteImportBatch`). */
  batchId: string;
  /** The files. */
  entries: readonly BatchUploadEntry[];
  /** Parallel uploads. Default {@link BATCH_UPLOAD_CONCURRENCY}. */
  concurrency?: number;
  /** Called with every snapshot. */
  onChange?: (upload: BatchUpload) => void;
  /** The clock, for tests. Default `Date.now`. */
  now?: () => number;
}

/**
 * What {@link createBatchUploadEngine} returns.
 *
 * @stability experimental
 */
export interface BatchUploadEngine {
  /** The batch. */
  readonly batchId: string;
  /** The current snapshot. */
  snapshot(): BatchUpload;
  /** Starts (or continues) uploading. Resolves when every file has settled or the upload stopped. */
  run(): Promise<void>;
  /** No new file starts; those in flight finish. */
  pause(): void;
  /** Starts files again after `pause`. */
  resume(): void;
  /** Aborts what is in flight, leaves the rest unsent, and closes the batch. */
  cancel(): Promise<void>;
  /**
   * Queues failed uploads again and runs them: all failed files, or only `paths`. A
   * cancelled upload cannot be retried.
   */
  retry(paths?: readonly string[]): Promise<void>;
}

/**
 * How many files of a batch go up at once by default.
 *
 * @stability experimental
 */
export const BATCH_UPLOAD_CONCURRENCY = 3;

// =============================================================================
// Helpers
// =============================================================================

function extensionOf(name: string): string {
  const at = name.lastIndexOf('.');
  return at < 0 ? '' : name.slice(at + 1).toLowerCase();
}

function typed(file: File): Blob {
  if (file.type) return file;
  const mime = noteImportMimeTypeForExtension(extensionOf(file.name));
  return mime ? new Blob([file], { type: mime }) : file;
}

function emptyCounts(): BatchUploadCounts {
  return { queued: 0, uploading: 0, uploaded: 0, skipped: 0, failed: 0, cancelled: 0 };
}

// =============================================================================
// createBatchUploadEngine
// =============================================================================

/**
 * An upload of prepared files into an existing batch. See the file header.
 *
 * @param options - Host, batch, files, concurrency and the change callback.
 * @returns The engine; call `run()` to start.
 *
 * @stability experimental
 */
export function createBatchUploadEngine(options: BatchUploadEngineOptions): BatchUploadEngine {
  const { host, batchId, onChange } = options;
  const now = options.now ?? Date.now;
  const limit = Math.max(1, options.concurrency ?? BATCH_UPLOAD_CONCURRENCY);
  const blobs = options.entries.map((entry) => entry.file);
  const files: BatchUploadFile[] = options.entries.map((entry) => ({
    path: entry.path ?? entry.file.name,
    name: entry.file.name,
    size: entry.file.size,
    ...(entry.kind ? { kind: entry.kind } : {}),
    state: 'queued',
  }));
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const startedAt = now();
  let status: BatchUploadStatus = 'uploading';
  let finishedAt: number | null = null;
  let active = 0;
  let controller = new AbortController();
  let waiters: Array<() => void> = [];
  let closing: Promise<void> | null = null;

  const snapshot = (): BatchUpload => {
    const counts = emptyCounts();
    let uploadedBytes = 0;
    for (const file of files) {
      counts[file.state] += 1;
      if (file.state === 'uploaded' || file.state === 'skipped') uploadedBytes += file.size;
    }
    return {
      batchId,
      status,
      files: files.map((file) => ({ ...file })),
      counts,
      totalBytes,
      uploadedBytes,
      startedAt,
      finishedAt,
    };
  };
  const emit = () => onChange?.(snapshot());

  const settle = (next: BatchUploadStatus) => {
    status = next;
    finishedAt = now();
    const done = waiters;
    waiters = [];
    for (const resolve of done) resolve();
  };

  const close = async () => {
    try {
      await closeImportBatch(host, batchId);
    } catch {
      // Best effort; the server also reads an abandoned empty batch as cancelled.
    }
  };

  const uploadOne = async (index: number) => {
    const file = files[index]!;
    const signal = controller.signal;
    file.state = 'uploading';
    delete file.message;
    delete file.reason;
    active += 1;
    emit();
    try {
      const blob = blobs[index]!;
      const answer = await uploadNoteImportFile(
        host,
        batchId,
        { body: typed(blob), filename: blob.name, path: file.path, mtime: blob.lastModified },
        signal,
      );
      file.state = answer?.skipped ? 'skipped' : 'uploaded';
      if (answer?.itemId) file.itemId = answer.itemId;
    } catch (error) {
      if (signal.aborted) {
        file.state = 'cancelled';
      } else {
        file.state = 'failed';
        file.message = noteImportUploadErrorMessage(error);
        if (isKvoxApiError(error)) {
          if (error.status === 413) file.reason = 'too_large';
          else if (error.reason) file.reason = error.reason;
        }
      }
    } finally {
      active -= 1;
    }
    pump();
    emit();
  };

  const pump = () => {
    if (status === 'cancelled') return;
    while (status === 'uploading' && active < limit) {
      const next = files.findIndex((file) => file.state === 'queued');
      if (next < 0) break;
      void uploadOne(next);
    }
    if (active === 0 && !files.some((file) => file.state === 'queued') && status !== 'done') {
      settle('done');
      closing = close();
    }
  };

  const run = () => {
    if (status === 'cancelled' || status === 'done') return Promise.resolve();
    const finished = new Promise<void>((resolve) => waiters.push(resolve));
    pump();
    emit();
    return finished;
  };

  return {
    batchId,
    snapshot,
    run,
    pause() {
      if (status !== 'uploading') return;
      status = 'paused';
      emit();
    },
    resume() {
      if (status !== 'paused') return;
      status = 'uploading';
      pump();
      emit();
    },
    async cancel() {
      if (status === 'cancelled') return;
      const wasDone = status === 'done';
      status = 'cancelled';
      controller.abort();
      for (const file of files) if (file.state === 'queued') file.state = 'cancelled';
      settle('cancelled');
      emit();
      if (closing) await closing;
      if (!wasDone) await close();
    },
    async retry(paths) {
      if (status === 'cancelled') return;
      const wanted = paths ? new Set(paths) : null;
      let any = false;
      for (const file of files) {
        if (file.state === 'failed' && (!wanted || wanted.has(file.path))) {
          file.state = 'queued';
          delete file.message;
          delete file.reason;
          any = true;
        }
      }
      if (!any) return;
      if (controller.signal.aborted) controller = new AbortController();
      status = 'uploading';
      finishedAt = null;
      await run();
    },
  };
}
