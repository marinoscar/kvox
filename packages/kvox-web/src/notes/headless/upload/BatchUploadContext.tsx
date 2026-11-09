/**
 * The app-wide note import uploads (issue #814, epic #811).
 *
 * WHY A PROVIDER: a bulk import of hundreds of files takes minutes. The person is sent to
 * the batch page as soon as the batch exists, and may then open a note, the graph or
 * settings; every one of those is a route change that would unmount whatever component
 * started the upload. Mounted once, around the authenticated shell (next to the
 * transcripts slice's `KvoxUploadManagerProvider`, for the same reason), the engines live
 * in a ref that survives every navigation.
 *
 * OPTIONAL: a host that does not mount it (KVox Desktop today) keeps the in-hook upload of
 * `useAdHocNoteImport`; `useOptionalBatchUploads()` answers `null` there, and
 * `useBatchUpload(batchId)` answers `null` too, so the batch page renders the server's
 * items only.
 *
 * While any upload is pending, leaving the page asks first (`beforeunload`): the `File`
 * handles exist only in this tab.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { useKvoxHost } from '../../../core/headless/index.js';
import { createNoteImportBatch } from '../clients/noteLibraries.js';
import type { NoteImportManifest } from '../sync/prepareNoteImport.js';
import { createBatchUploadEngine } from './batchUploadEngine.js';
import type { BatchUpload, BatchUploadEngine, BatchUploadEntry } from './batchUploadEngine.js';

/**
 * What the batch upload context offers.
 *
 * @stability experimental
 */
export interface BatchUploadsContextValue {
  /** Every upload of this tab, oldest first. */
  uploads: BatchUpload[];
  /**
   * Opens a batch and starts uploading into it. Resolves with the batch id as soon as the
   * batch exists (the uploads go on in the background), so the caller can navigate to
   * the batch page at once.
   *
   * @throws When the batch cannot be opened.
   */
  start: (input: NoteImportManifest | readonly BatchUploadEntry[], options?: { concurrency?: number }) => Promise<string>;
  /** No new file of that batch starts. */
  pause: (batchId: string) => void;
  /** Starts the files of that batch again. */
  resume: (batchId: string) => void;
  /** Stops that batch's upload and closes the batch. */
  cancel: (batchId: string) => Promise<void>;
  /** Uploads that batch's failed files again: all of them, or only `paths`. */
  retry: (batchId: string, paths?: readonly string[]) => Promise<void>;
  /** Forgets a settled upload (and its `File` handles). */
  dismiss: (batchId: string) => void;
}

const BatchUploadContext = createContext<BatchUploadsContextValue | null>(null);

/**
 * Props of {@link BatchUploadProvider}.
 *
 * @stability experimental
 */
export interface BatchUploadProviderProps {
  /** The app. */
  children: ReactNode;
  /** Parallel uploads per batch. Default 3. */
  concurrency?: number;
}

function isPending(upload: BatchUpload): boolean {
  return upload.status === 'uploading' || (upload.status === 'paused' && upload.counts.queued + upload.counts.uploading > 0);
}

/**
 * Holds the note import uploads of this tab. Mount it ONCE, around the authenticated shell.
 *
 * @param props - See {@link BatchUploadProviderProps}.
 * @returns The provider.
 *
 * @stability experimental
 */
export function BatchUploadProvider({ children, concurrency }: BatchUploadProviderProps) {
  const host = useKvoxHost();
  const engines = useRef(new Map<string, BatchUploadEngine>());
  const [uploads, setUploads] = useState<BatchUpload[]>([]);

  const put = useCallback((upload: BatchUpload) => {
    setUploads((previous) => {
      const at = previous.findIndex((item) => item.batchId === upload.batchId);
      if (at < 0) return [...previous, upload];
      const next = previous.slice();
      next[at] = upload;
      return next;
    });
  }, []);

  const start = useCallback<BatchUploadsContextValue['start']>(
    async (input, options) => {
      const entries: readonly BatchUploadEntry[] = Array.isArray(input)
        ? (input as readonly BatchUploadEntry[])
        : (input as NoteImportManifest).accepted.map((item) => ({ file: item.file, path: item.path, kind: item.kind }));
      const batchId = await createNoteImportBatch(host);
      const engine = createBatchUploadEngine({
        host,
        batchId,
        entries,
        concurrency: options?.concurrency ?? concurrency,
        onChange: put,
      });
      engines.current.set(batchId, engine);
      put(engine.snapshot());
      void engine.run();
      return batchId;
    },
    [concurrency, host, put],
  );

  const pause = useCallback((batchId: string) => engines.current.get(batchId)?.pause(), []);
  const resume = useCallback((batchId: string) => engines.current.get(batchId)?.resume(), []);
  const cancel = useCallback(async (batchId: string) => {
    await engines.current.get(batchId)?.cancel();
  }, []);
  const retry = useCallback(async (batchId: string, paths?: readonly string[]) => {
    await engines.current.get(batchId)?.retry(paths);
  }, []);
  const dismiss = useCallback((batchId: string) => {
    const engine = engines.current.get(batchId);
    if (engine && isPending(engine.snapshot())) return;
    engines.current.delete(batchId);
    setUploads((previous) => previous.filter((upload) => upload.batchId !== batchId));
  }, []);

  const pending = uploads.some(isPending);
  useEffect(() => {
    if (!pending) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Some browsers still need a value to show their prompt.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [pending]);

  const value = useMemo<BatchUploadsContextValue>(
    () => ({ uploads, start, pause, resume, cancel, retry, dismiss }),
    [uploads, start, pause, resume, cancel, retry, dismiss],
  );
  return <BatchUploadContext.Provider value={value}>{children}</BatchUploadContext.Provider>;
}

/**
 * The note import uploads of this tab, or `null` where no {@link BatchUploadProvider} is
 * mounted.
 *
 * @returns The context, or `null`.
 *
 * @stability experimental
 */
export function useOptionalBatchUploads(): BatchUploadsContextValue | null {
  return useContext(BatchUploadContext);
}

/**
 * The note import uploads of this tab.
 *
 * @returns The context.
 * @throws Outside a {@link BatchUploadProvider}.
 *
 * @stability experimental
 */
export function useBatchUploads(): BatchUploadsContextValue {
  const context = useContext(BatchUploadContext);
  if (!context) throw new Error('useBatchUploads must be used within a BatchUploadProvider');
  return context;
}

/**
 * What {@link useBatchUpload} returns.
 *
 * @stability experimental
 */
export interface UseBatchUploadResult {
  /** The upload's snapshot. */
  upload: BatchUpload;
  /** No new file starts. */
  pause: () => void;
  /** Starts files again. */
  resume: () => void;
  /** Stops the upload and closes the batch. */
  cancel: () => Promise<void>;
  /** Uploads failed files again: all, or only `paths`. */
  retry: (paths?: readonly string[]) => Promise<void>;
}

/**
 * The upload of one batch in this tab, or `null` (no provider, or the batch was not
 * uploaded from this tab).
 *
 * @param batchId - The batch.
 * @returns The upload and its actions, or `null`.
 *
 * @stability experimental
 */
export function useBatchUpload(batchId: string | undefined): UseBatchUploadResult | null {
  const context = useContext(BatchUploadContext);
  const upload = batchId ? context?.uploads.find((item) => item.batchId === batchId) : undefined;
  return useMemo(() => {
    if (!context || !upload || !batchId) return null;
    return {
      upload,
      pause: () => context.pause(batchId),
      resume: () => context.resume(batchId),
      cancel: () => context.cancel(batchId),
      retry: (paths?: readonly string[]) => context.retry(batchId, paths),
    };
  }, [batchId, context, upload]);
}
