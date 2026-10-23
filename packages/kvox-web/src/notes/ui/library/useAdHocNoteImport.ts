/**
 * Picked or dropped files → an ad-hoc import batch → the batch's progress page
 * (issue #720). Shared by `ImportNotesButton` and `NotesDropZone`.
 *
 * The files are checked in the browser first (importable extension, not empty, not
 * over `maxBytes`), so a refused file costs no upload; every other refusal is the
 * server's. Uploads that fail are handed to the batch page in the router state
 * (`NoteImportNavigationState`), since they never became batch items.
 */

import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useIsMounted, useKvoxHost } from '../../../core/headless/index.js';
import {
  NOTE_IMPORT_DEFAULT_MAX_BYTES,
  checkNoteImportFiles,
  importFilesAdHoc,
  noteImportUploadErrorMessage,
} from '../../headless/index.js';
import type { LibrarySyncFailure, LibrarySyncProgress, NoteImportRejectedFile } from '../../headless/index.js';
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

function rejectionMessage(rejected: NoteImportRejectedFile, maxBytes: number): LibrarySyncFailure {
  const { file, reason } = rejected;
  switch (reason) {
    case 'unsupported':
      return {
        path: file.name,
        reason: 'unsupported_document',
        message: 'Not a file KVox can import. Use Markdown, text, PDF, Word (.docx) or PowerPoint (.pptx).',
      };
    case 'empty':
      return { path: file.name, reason: 'empty_note', message: 'The file is empty.' };
    case 'too_large':
      return {
        path: file.name,
        reason: 'too_large',
        message: `The file is ${formatImportBytes(file.size)}; the limit is ${formatImportBytes(maxBytes)}.`,
      };
  }
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
  /** Checks, uploads and, when anything went up, opens the batch page. */
  importFiles: (files: Iterable<File>) => Promise<void>;
  /** An import is in flight. */
  isImporting: boolean;
  /** Its progress. */
  progress: LibrarySyncProgress | null;
  /** Why nothing was imported, as a sentence. */
  error: string | null;
  /** Clears `error`. */
  clearError: () => void;
}

/**
 * Imports loose files as notes.
 *
 * @param maxBytes - The largest file accepted. Default 25 MiB.
 * @returns The import action and its state.
 *
 * @stability experimental
 */
export function useAdHocNoteImport(maxBytes: number = NOTE_IMPORT_DEFAULT_MAX_BYTES): AdHocNoteImport {
  const host = useKvoxHost();
  const navigate = useNavigate();
  const isMounted = useIsMounted();
  const [isImporting, setIsImporting] = useState(false);
  const [progress, setProgress] = useState<LibrarySyncProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const importFiles = useCallback(
    async (files: Iterable<File>) => {
      if (isImporting) return;
      const { accepted, rejected } = checkNoteImportFiles(files, maxBytes);
      const refused = rejected.map((item) => rejectionMessage(item, maxBytes));
      setError(null);
      if (accepted.length === 0) {
        setError(refused.length > 0 ? summarizeImportFailures(refused) : 'No files were chosen.');
        return;
      }
      setIsImporting(true);
      setProgress(null);
      try {
        const result = await importFilesAdHoc({
          host,
          files: accepted,
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
        if (isMounted()) setIsImporting(false);
      }
    },
    [host, isImporting, isMounted, maxBytes, navigate],
  );

  return { importFiles, isImporting, progress, error, clearError: () => setError(null) };
}
