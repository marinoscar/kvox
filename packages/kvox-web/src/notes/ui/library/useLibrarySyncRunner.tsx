/**
 * The page side of a library sync (issue #720): runs `runLibrarySync` with the
 * device's file access, shows `ScanConfirmDialog` when the scan has something to
 * upload, and keeps the progress of the one sync in flight for the page to draw.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import {
  KvoxFileAccessError,
  isKvoxApiError,
  useIsMounted,
  useKvoxFileAccess,
  useKvoxHost,
} from '../../../core/headless/index.js';
import type { KvoxFolderRef } from '../../../core/headless/index.js';
import { runLibrarySync } from '../../headless/index.js';
import type { LibrarySyncPlan, LibrarySyncProgress, LibrarySyncResult, NoteLibrary } from '../../headless/index.js';
import { ScanConfirmDialog } from '../components/ScanConfirmDialog.js';

/**
 * What {@link useLibrarySyncRunner} returns.
 *
 * @stability experimental
 */
export interface LibrarySyncRunner {
  /**
   * Syncs `library` with `ref`. Resolves with the result, or `null` when it failed or
   * was stopped (the failure is in `error`).
   */
  start: (library: Pick<NoteLibrary, 'id' | 'name' | 'autoExtract'>, ref: KvoxFolderRef) => Promise<LibrarySyncResult | null>;
  /** Stops the sync in flight. */
  stop: () => void;
  /** The library being synced, or `null`. */
  runningLibraryId: string | null;
  /** Its progress. */
  progress: LibrarySyncProgress | null;
  /** The last failure, as a sentence. */
  error: string | null;
  /** The library the last failure belongs to. */
  errorLibraryId: string | null;
  /** Clears `error`. */
  clearError: () => void;
  /** The confirmation dialog; render it once on the page. */
  dialog: ReactNode;
}

/**
 * The sentence for a sync that could not run.
 *
 * @param error - What the sync rejected with.
 * @returns A sentence for a person.
 *
 * @stability experimental
 */
export function syncErrorMessage(error: unknown): string {
  if (error instanceof KvoxFileAccessError) {
    switch (error.code) {
      case 'permission_denied':
        return 'KVox was not allowed to read the folder. Connect it again and allow access.';
      case 'unknown_folder':
      case 'not_found':
        return 'The folder is no longer available on this device. Connect it again.';
      case 'unsupported':
        return 'This browser cannot read folders. Use a recent Chrome or Edge, or KVox Desktop.';
    }
  }
  if (isKvoxApiError(error)) {
    if (error.status === 404) return 'This library no longer exists.';
    if (error.status === 0) return 'The scan could not reach the server. Check your connection and try again.';
  }
  return error instanceof Error && error.message
    ? `The folder could not be scanned: ${error.message}`
    : 'The folder could not be scanned.';
}

/**
 * Options of {@link useLibrarySyncRunner}.
 *
 * @stability experimental
 */
export interface LibrarySyncRunnerOptions {
  /** Upload one file at a time. */
  sequential?: boolean;
}

interface PendingConfirm {
  plan: LibrarySyncPlan;
  libraryName: string;
  autoExtract: boolean;
  resolve: (go: boolean) => void;
}

/**
 * Runs library syncs for a page.
 *
 * @param options - `sequential` uploads one file at a time.
 * @returns The runner.
 *
 * @stability experimental
 */
export function useLibrarySyncRunner(options: LibrarySyncRunnerOptions = {}): LibrarySyncRunner {
  const host = useKvoxHost();
  const port = useKvoxFileAccess();
  const isMounted = useIsMounted();
  const [runningLibraryId, setRunningLibraryId] = useState<string | null>(null);
  const [progress, setProgress] = useState<LibrarySyncProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorLibraryId, setErrorLibraryId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const controller = useRef<AbortController | null>(null);
  const { sequential } = options;

  useEffect(() => () => controller.current?.abort(), []);

  const start = useCallback<LibrarySyncRunner['start']>(
    async (library, ref) => {
      if (controller.current) return null;
      const abort = new AbortController();
      controller.current = abort;
      setRunningLibraryId(library.id);
      setProgress(null);
      setError(null);
      setErrorLibraryId(null);
      try {
        const result = await runLibrarySync({
          host,
          port,
          library,
          ref,
          signal: abort.signal,
          ...(sequential ? { sequential } : {}),
          onProgress: (next) => {
            if (isMounted()) setProgress(next);
          },
          confirm: (plan) =>
            new Promise<boolean>((resolve) => {
              if (!isMounted()) {
                resolve(false);
                return;
              }
              setPending({ plan, libraryName: library.name, autoExtract: library.autoExtract, resolve });
            }),
        });
        return result;
      } catch (err) {
        if (!abort.signal.aborted && isMounted()) {
          setError(syncErrorMessage(err));
          setErrorLibraryId(library.id);
        }
        return null;
      } finally {
        controller.current = null;
        if (isMounted()) {
          setRunningLibraryId(null);
          setPending(null);
        }
      }
    },
    [host, isMounted, port, sequential],
  );

  const stop = useCallback(() => {
    controller.current?.abort();
  }, []);

  const answer = (go: boolean) => {
    pending?.resolve(go);
    setPending(null);
  };

  const dialog = (
    <ScanConfirmDialog
      open={pending !== null}
      plan={pending?.plan ?? null}
      libraryName={pending?.libraryName ?? ''}
      autoExtract={pending?.autoExtract ?? true}
      onConfirm={() => answer(true)}
      onCancel={() => answer(false)}
    />
  );

  return {
    start,
    stop,
    runningLibraryId,
    progress,
    error,
    errorLibraryId,
    clearError: () => {
      setError(null);
      setErrorLibraryId(null);
    },
    dialog,
  };
}
