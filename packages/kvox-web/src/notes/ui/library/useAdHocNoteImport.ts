/**
 * Picked or dropped files → a pre-flight manifest → an ad-hoc import batch → the batch's
 * progress page (issues #720, #813, #814). Shared by `ImportNotesButton` and
 * `NotesDropZone`.
 *
 * `review(files)` unpacks ZIP archives and checks every file in the browser
 * (`prepareNoteImport`), so a refused file costs no upload, and holds the manifest for the
 * pre-flight dialog; `confirm()` starts it. Every other refusal is the server's.
 *
 * WITH a `BatchUploadProvider` mounted (the web app), `confirm()` opens the batch and goes
 * to its page at once; the uploads go on in the background and the page shows them.
 * WITHOUT one (a host that does not mount it), the upload runs here, as before, and the
 * page opens when it is done. Uploads that fail before becoming batch items are handed to
 * the batch page in the router state (`NoteImportNavigationState`).
 */

import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useIsMounted, useKvoxHost } from '../../../core/headless/index.js';
import {
  NOTE_IMPORT_DEFAULT_MAX_BYTES,
  importFilesAdHoc,
  noteImportUploadErrorMessage,
  prepareNoteImport,
  useOptionalBatchUploads,
} from '../../headless/index.js';
import type {
  LibrarySyncFailure,
  LibrarySyncProgress,
  NoteImportManifest,
  NoteImportManifestRejection,
  NoteImportPrepareProgress,
  NoteImportRejectedFile,
  NoteImportRejectionReason,
} from '../../headless/index.js';
import { formatImportBytes } from './format.js';

/**
 * The router state the import pages hand to the batch page.
 *
 * @stability experimental
 */
export interface NoteImportNavigationState {
  /** Files that never reached the batch (refused in the browser or by the upload route). */
  uploadFailures?: LibrarySyncFailure[];
}

/**
 * The path of an import batch's progress page.
 *
 * @param batchId - The batch.
 * @returns `/notes/import-batches/:batchId`.
 *
 * @stability experimental
 */
export function noteImportBatchPath(batchId: string): string {
  return `/notes/import-batches/${encodeURIComponent(batchId)}`;
}

/** The server-side reason a browser refusal maps to, where there is one. */
const WIRE_REASON: Partial<Record<NoteImportRejectionReason, string>> = {
  unsupported: 'unsupported_document',
  in_archive_unsupported: 'unsupported_document',
  empty: 'empty_note',
};

/**
 * A short sentence for why a file will not be imported.
 *
 * @param reason - The reason.
 * @param size - The file's size, when known.
 * @param maxBytes - The largest file accepted.
 * @returns The sentence.
 *
 * @stability experimental
 */
export function noteImportRejectionText(
  reason: NoteImportRejectionReason,
  size: number | undefined,
  maxBytes: number = NOTE_IMPORT_DEFAULT_MAX_BYTES,
): string {
  switch (reason) {
    case 'unsupported':
    case 'in_archive_unsupported':
      return 'Not a file KVox can import. Use Markdown, text, PDF, Word (.docx) or PowerPoint (.pptx).';
    case 'empty':
      return 'The file is empty.';
    case 'too_large':
      return size !== undefined && size > 0
        ? `The file is ${formatImportBytes(size)}; the limit is ${formatImportBytes(maxBytes)}.`
        : `The file is over the ${formatImportBytes(maxBytes)} limit.`;
    case 'nested_archive':
      return 'An archive inside the archive. Unpack it and import it on its own.';
    case 'encrypted':
      return 'The file is password protected.';
    case 'archive_limit':
      return 'Over the archive limits (files, total size or compression).';
    case 'system_file':
      return 'A system or hidden file.';
    case 'unsafe_path':
      return 'The file’s path inside the archive is not safe.';
    case 'unreadable':
      return 'The file could not be read from the archive.';
    case 'archive_unreadable':
      return 'The archive could not be read. It may be damaged or not a ZIP file.';
    default:
      return 'This file cannot be imported.';
  }
}

/**
 * A short heading for a group of skipped files.
 *
 * @param reason - The reason.
 * @returns The heading.
 *
 * @stability experimental
 */
export function noteImportRejectionHeading(reason: NoteImportRejectionReason): string {
  switch (reason) {
    case 'unsupported':
    case 'in_archive_unsupported':
      return 'Not a supported type';
    case 'empty':
      return 'Empty';
    case 'too_large':
      return 'Too large';
    case 'nested_archive':
      return 'Archives inside the archive';
    case 'encrypted':
      return 'Password protected';
    case 'archive_limit':
      return 'Over the archive limits';
    case 'system_file':
      return 'System or hidden files';
    case 'unsafe_path':
      return 'Unsafe paths';
    case 'unreadable':
      return 'Could not be read';
    case 'archive_unreadable':
      return 'Archives that could not be opened';
    default:
      return 'Other';
  }
}

function rejectionMessage(rejected: NoteImportManifestRejection, maxBytes: number): LibrarySyncFailure {
  const failure: LibrarySyncFailure = {
    path: rejected.path,
    message: noteImportRejectionText(rejected.reason, rejected.size, maxBytes),
  };
  const wire = WIRE_REASON[rejected.reason] ?? rejected.reason;
  failure.reason = wire;
  return failure;
}

/**
 * The failure entry of a file refused by `checkNoteImportFiles`.
 *
 * @param rejected - The refused file.
 * @param maxBytes - The largest file accepted.
 * @returns The failure, for `summarizeImportFailures` or the batch page.
 *
 * @stability experimental
 */
export function noteImportRejectionFailure(
  rejected: NoteImportRejectedFile,
  maxBytes: number = NOTE_IMPORT_DEFAULT_MAX_BYTES,
): LibrarySyncFailure {
  return rejectionMessage(
    { name: rejected.file.name, path: rejected.file.name, reason: rejected.reason, size: rejected.file.size },
    maxBytes,
  );
}

/**
 * A one-paragraph summary of refused files, naming at most three.
 *
 * @param failures - The refused files.
 * @returns The sentence.
 *
 * @stability experimental
 */
export function summarizeImportFailures(failures: readonly LibrarySyncFailure[]): string {
  if (failures.length === 1) return `${failures[0]!.path}: ${failures[0]!.message}`;
  const named = failures.slice(0, 3).map((failure) => failure.path).join(', ');
  const more = failures.length > 3 ? ` and ${failures.length - 3} more` : '';
  return `${failures.length} files could not be imported (${named}${more}). ${failures[0]!.message}`;
}

/**
 * What {@link useAdHocNoteImport} returns.
 *
 * @stability experimental
 */
export interface AdHocNoteImport {
  /** Prepares and starts at once, without the pre-flight step. */
  importFiles: (files: Iterable<File>) => Promise<void>;
  /**
   * Prepares the files (unpacks archives, checks every file) and holds the manifest in
   * `manifest` for the pre-flight dialog. When nothing can be imported, sets `error`.
   */
  review: (files: Iterable<File>) => Promise<void>;
  /** Starts the manifest under review. */
  confirm: () => Promise<void>;
  /** Drops the manifest under review, or stops the preparation. */
  dismiss: () => void;
  /** Archives are being unpacked: where it stands. `null` otherwise. */
  preparing: NoteImportPrepareProgress | null;
  /** The preparation is running. */
  isPreparing: boolean;
  /** The manifest waiting for the person's go-ahead. */
  manifest: NoteImportManifest | null;
  /** An upload is in flight here (only without a `BatchUploadProvider`, or while the batch opens). */
  isImporting: boolean;
  /** Its progress. */
  progress: LibrarySyncProgress | null;
  /** Why nothing was imported, as a sentence. */
  error: string | null;
  /** Clears `error`. */
  clearError: () => void;
}

/**
 * Imports loose files and ZIP archives as notes.
 *
 * @param maxBytes - The largest file accepted. Default 25 MiB.
 * @returns The import actions and their state.
 *
 * @stability experimental
 */
export function useAdHocNoteImport(maxBytes: number = NOTE_IMPORT_DEFAULT_MAX_BYTES): AdHocNoteImport {
  const host = useKvoxHost();
  const navigate = useNavigate();
  const isMounted = useIsMounted();
  const uploads = useOptionalBatchUploads();
  const [isImporting, setIsImporting] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);
  const [preparing, setPreparing] = useState<NoteImportPrepareProgress | null>(null);
  const [manifest, setManifest] = useState<NoteImportManifest | null>(null);
  const [progress, setProgress] = useState<LibrarySyncProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const prepareAbort = useRef<AbortController | null>(null);
  const busy = useRef(false);

  const prepare = useCallback(
    async (files: Iterable<File>): Promise<NoteImportManifest | null> => {
      prepareAbort.current?.abort();
      const controller = new AbortController();
      prepareAbort.current = controller;
      setError(null);
      setIsPreparing(true);
      setPreparing(null);
      try {
        const next = await prepareNoteImport(Array.from(files), {
          maxBytes,
          signal: controller.signal,
          onProgress: (p) => {
            if (isMounted() && !controller.signal.aborted) setPreparing(p);
          },
        });
        if (!isMounted() || controller.signal.aborted) return null;
        if (next.accepted.length === 0) {
          const refused = next.rejected.map((item) => rejectionMessage(item, maxBytes));
          setError(refused.length > 0 ? summarizeImportFailures(refused) : 'No files were chosen.');
          return null;
        }
        return next;
      } catch (err) {
        if (isMounted() && !controller.signal.aborted) setError(noteImportUploadErrorMessage(err));
        return null;
      } finally {
        if (prepareAbort.current === controller) prepareAbort.current = null;
        if (isMounted() && !controller.signal.aborted) {
          setIsPreparing(false);
          setPreparing(null);
        }
      }
    },
    [isMounted, maxBytes],
  );

  const start = useCallback(
    async (prepared: NoteImportManifest) => {
      if (busy.current || prepared.refusal || prepared.accepted.length === 0) return;
      busy.current = true;
      const refused = prepared.rejected.map((item) => rejectionMessage(item, maxBytes));
      setError(null);
      setIsImporting(true);
      setProgress(null);
      try {
        if (uploads) {
          const batchId = await uploads.start(prepared);
          if (!isMounted()) return;
          const state: NoteImportNavigationState = refused.length > 0 ? { uploadFailures: refused } : {};
          navigate(noteImportBatchPath(batchId), { state });
          return;
        }
        const result = await importFilesAdHoc({
          host,
          files: prepared.accepted.map((item) => item.file),
          paths: prepared.accepted.map((item) => item.path),
          onProgress: (next) => {
            if (isMounted()) setProgress(next);
          },
        });
        if (!isMounted()) return;
        const failures = [...refused, ...result.failed];
        if (result.uploaded + result.skipped === 0) {
          setError(summarizeImportFailures(failures));
          return;
        }
        const state: NoteImportNavigationState = failures.length > 0 ? { uploadFailures: failures } : {};
        navigate(noteImportBatchPath(result.batchId), { state });
      } catch (err) {
        if (isMounted()) setError(noteImportUploadErrorMessage(err));
      } finally {
        busy.current = false;
        if (isMounted()) setIsImporting(false);
      }
    },
    [host, isMounted, maxBytes, navigate, uploads],
  );

  const importFiles = useCallback(
    async (files: Iterable<File>) => {
      if (busy.current) return;
      const prepared = await prepare(files);
      if (!prepared) return;
      if (prepared.refusal) {
        setError(prepared.refusal.message);
        return;
      }
      await start(prepared);
    },
    [prepare, start],
  );

  const review = useCallback(
    async (files: Iterable<File>) => {
      if (busy.current) return;
      setManifest(null);
      const prepared = await prepare(files);
      if (prepared && isMounted()) setManifest(prepared);
    },
    [isMounted, prepare],
  );

  const confirm = useCallback(async () => {
    const prepared = manifest;
    if (!prepared) return;
    setManifest(null);
    await start(prepared);
  }, [manifest, start]);

  const dismiss = useCallback(() => {
    prepareAbort.current?.abort();
    prepareAbort.current = null;
    setIsPreparing(false);
    setPreparing(null);
    setManifest(null);
  }, []);

  return {
    importFiles,
    review,
    confirm,
    dismiss,
    preparing,
    isPreparing,
    manifest,
    isImporting,
    progress,
    error,
    clearError: () => setError(null),
  };
}
