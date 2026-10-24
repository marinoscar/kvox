/**
 * The hooks over the note libraries API (issue #720, epic #708): the library list, one
 * library, a library's recent batches, one batch (polled while it works), and a batch's
 * items (cursor-paginated, refreshed with the batch).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { isKvoxApiError, useIsMounted, useKvoxHost, useVisiblePolling } from '../../../core/headless/index.js';
import {
  deleteNoteLibrary,
  getNoteImportBatch,
  getNoteLibrary,
  listNoteImportBatchItems,
  listNoteImportBatches,
  listNoteLibraries,
  retryNoteImportBatch,
  retryNoteImportBatchExtractions,
  updateNoteLibrary,
} from '../clients/noteLibraries.js';
import type {
  NoteImportBatch,
  NoteImportBatchItem,
  NoteImportItemStatus,
  NoteLibrary,
  UpdateNoteLibraryRequest,
} from '../clients/noteLibraries.js';

function messageFor(error: unknown, fallback: string): string {
  if (isKvoxApiError(error) && error.status === 404) return 'Not found.';
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function isNotFound(error: unknown): boolean {
  return isKvoxApiError(error) && error.status === 404;
}

// =============================================================================
// Libraries
// =============================================================================

/**
 * What {@link useNoteLibraries} returns.
 *
 * @stability experimental
 */
export interface UseNoteLibrariesResult {
  /** The caller's libraries, newest first. Empty while loading. */
  libraries: NoteLibrary[];
  /** The first load is in flight. */
  isLoading: boolean;
  /** The last load's failure, as a sentence. */
  error: string | null;
  /** Re-reads the list without the loading state. */
  refresh: () => Promise<void>;
}

/**
 * The caller's note libraries.
 *
 * @param pollMs - Re-read the list this often (while the tab is visible); 0 never. Default 0.
 * @returns The list, its loading and error state, and `refresh`.
 *
 * @stability experimental
 */
export function useNoteLibraries(pollMs = 0): UseNoteLibrariesResult {
  const host = useKvoxHost();
  const isMounted = useIsMounted();
  const [libraries, setLibraries] = useState<NoteLibrary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await listNoteLibraries(host);
      if (!isMounted()) return;
      setLibraries(next);
      setError(null);
    } catch (err) {
      if (isMounted()) setError(messageFor(err, 'Failed to load your libraries'));
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [host, isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useVisiblePolling(() => void refresh(), pollMs);

  return { libraries, isLoading, error, refresh };
}

/**
 * What {@link useNoteLibrary} returns.
 *
 * @stability experimental
 */
export interface UseNoteLibraryResult {
  /** The library, once loaded. */
  library: NoteLibrary | null;
  /** The first load is in flight. */
  isLoading: boolean;
  /** The last load's failure, as a sentence. */
  error: string | null;
  /** The library does not exist, or is not the caller's. */
  notFound: boolean;
  /** Re-reads the library. */
  refresh: () => Promise<void>;
  /** Renames it or changes its policy; the answer replaces the library. Rejects on failure. */
  update: (patch: UpdateNoteLibraryRequest) => Promise<NoteLibrary>;
  /** Deletes it (its notes are kept). Rejects on failure. */
  remove: () => Promise<void>;
}

/**
 * One note library.
 *
 * @param id - The library.
 * @returns The library, its state, and the mutations.
 *
 * @stability experimental
 */
export function useNoteLibrary(id: string | undefined): UseNoteLibraryResult {
  const host = useKvoxHost();
  const isMounted = useIsMounted();
  const [library, setLibrary] = useState<NoteLibrary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      const next = await getNoteLibrary(host, id);
      if (!isMounted()) return;
      setLibrary(next);
      setError(null);
      setNotFound(false);
    } catch (err) {
      if (!isMounted()) return;
      setNotFound(isNotFound(err));
      setError(messageFor(err, 'Failed to load this library'));
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [host, id, isMounted]);

  useEffect(() => {
    setLibrary(null);
    setIsLoading(true);
    void refresh();
  }, [refresh]);

  const update = useCallback(
    async (patch: UpdateNoteLibraryRequest) => {
      if (!id) throw new Error('No library');
      const next = await updateNoteLibrary(host, id, patch);
      if (isMounted()) setLibrary(next);
      return next;
    },
    [host, id, isMounted],
  );

  const remove = useCallback(async () => {
    if (!id) return;
    await deleteNoteLibrary(host, id);
  }, [host, id]);

  return { library, isLoading, error, notFound, refresh, update, remove };
}

// =============================================================================
// Batches
// =============================================================================

/**
 * Whether a batch is still working: importing files, or extracting graph proposals
 * from the notes it made.
 *
 * @param batch - The batch.
 * @returns `true` while its numbers can still move on their own.
 *
 * @stability experimental
 */
export function isImportBatchActive(batch: NoteImportBatch | null | undefined): boolean {
  if (!batch) return false;
  if (batch.status === 'scanning' || batch.status === 'running') return true;
  // Formatting (#730) and graph extraction both outlive the batch's own `running`.
  return (batch.stageCounts?.extracting ?? 0) > 0 || (batch.stageCounts?.formatting ?? 0) > 0;
}

/**
 * How often a working batch is re-read, in milliseconds.
 *
 * @stability experimental
 */
export const IMPORT_BATCH_POLL_MS = 2_000;

/**
 * What {@link useImportBatches} returns.
 *
 * @stability experimental
 */
export interface UseImportBatchesResult {
  /** The batches, newest first. */
  batches: NoteImportBatch[];
  /** The first load is in flight. */
  isLoading: boolean;
  /** The last load's failure, as a sentence. */
  error: string | null;
  /** Re-reads the list. */
  refresh: () => Promise<void>;
}

/**
 * The caller's recent import batches, optionally of one library. Re-read every
 * {@link IMPORT_BATCH_POLL_MS} while one of them is still working.
 *
 * @param libraryId - Only this library's batches; `undefined` for all.
 * @param limit - At most this many. Default 10.
 * @returns The batches and their state.
 *
 * @stability experimental
 */
export function useImportBatches(libraryId: string | undefined, limit = 10): UseImportBatchesResult {
  const host = useKvoxHost();
  const isMounted = useIsMounted();
  const [batches, setBatches] = useState<NoteImportBatch[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await listNoteImportBatches(host, { ...(libraryId ? { libraryId } : {}), limit });
      if (!isMounted()) return;
      setBatches(next);
      setError(null);
    } catch (err) {
      if (isMounted()) setError(messageFor(err, 'Failed to load the imports'));
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [host, isMounted, libraryId, limit]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useVisiblePolling(() => void refresh(), batches.some(isImportBatchActive) ? IMPORT_BATCH_POLL_MS : 0);

  return { batches, isLoading, error, refresh };
}

/**
 * What {@link useImportBatch} returns.
 *
 * @stability experimental
 */
export interface UseImportBatchResult {
  /** The batch, once loaded. */
  batch: NoteImportBatch | null;
  /** The first load is in flight. */
  isLoading: boolean;
  /** The last load's failure, as a sentence. */
  error: string | null;
  /** The batch does not exist, or is not the caller's. */
  notFound: boolean;
  /** The batch's numbers can still move: it is being polled. */
  isActive: boolean;
  /** Re-reads the batch. */
  refresh: () => Promise<void>;
  /** Re-queues the failed items, then re-reads. Resolves with how many. */
  retryFailed: () => Promise<number>;
  /**
   * Re-runs the failed graph extractions, then re-reads. Resolves with how many, or
   * `null` when the server has no such route (404): `retryExtractionsAvailable` turns false.
   */
  retryExtractions: () => Promise<number | null>;
  /** `false` once the server answered 404 to `retryExtractions`. */
  retryExtractionsAvailable: boolean;
}

/**
 * Options of {@link useImportBatch}.
 *
 * @stability experimental
 */
export interface UseImportBatchOptions {
  /** Poll interval while the batch works. Default {@link IMPORT_BATCH_POLL_MS}; 0 never polls. */
  pollMs?: number;
}

/**
 * One import batch, polled while it works (`scanning`, `running`, or notes still
 * extracting) and only while the tab is visible.
 *
 * @param id - The batch.
 * @param options - The poll interval.
 * @returns The batch, its state and the retry actions.
 *
 * @stability experimental
 */
export function useImportBatch(id: string | undefined, options: UseImportBatchOptions = {}): UseImportBatchResult {
  const host = useKvoxHost();
  const isMounted = useIsMounted();
  const [batch, setBatch] = useState<NoteImportBatch | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [retryExtractionsAvailable, setRetryExtractionsAvailable] = useState(true);

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      const next = await getNoteImportBatch(host, id);
      if (!isMounted()) return;
      setBatch(next);
      setError(null);
      setNotFound(false);
    } catch (err) {
      if (!isMounted()) return;
      setNotFound(isNotFound(err));
      setError(messageFor(err, 'Failed to load this import'));
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [host, id, isMounted]);

  useEffect(() => {
    setBatch(null);
    setIsLoading(true);
    void refresh();
  }, [refresh]);

  const isActive = isImportBatchActive(batch);
  useVisiblePolling(() => void refresh(), isActive ? (options.pollMs ?? IMPORT_BATCH_POLL_MS) : 0);

  const retryFailed = useCallback(async () => {
    if (!id) return 0;
    const requeued = await retryNoteImportBatch(host, id);
    await refresh();
    return requeued;
  }, [host, id, refresh]);

  const retryExtractions = useCallback(async () => {
    if (!id) return null;
    try {
      const requeued = await retryNoteImportBatchExtractions(host, id);
      await refresh();
      return requeued;
    } catch (err) {
      if (isNotFound(err)) {
        if (isMounted()) setRetryExtractionsAvailable(false);
        return null;
      }
      throw err;
    }
  }, [host, id, isMounted, refresh]);

  return {
    batch,
    isLoading,
    error,
    notFound,
    isActive,
    refresh,
    retryFailed,
    retryExtractions,
    retryExtractionsAvailable,
  };
}

/**
 * What {@link useImportBatchItems} returns.
 *
 * @stability experimental
 */
export interface UseImportBatchItemsResult {
  /** The items loaded so far, oldest first. */
  items: NoteImportBatchItem[];
  /** The first page is loading. */
  isLoading: boolean;
  /** A further page is loading. */
  isLoadingMore: boolean;
  /** The last load's failure, as a sentence. */
  error: string | null;
  /** There are more items after the loaded ones. */
  hasMore: boolean;
  /** Loads the next page. */
  loadMore: () => Promise<void>;
  /** Re-reads the loaded range (at least one page) in place. */
  refresh: () => Promise<void>;
}

/** The server's largest page. */
const MAX_PAGE = 200;

/**
 * The items of a batch, a page at a time.
 *
 * `refresh` re-reads the range already loaded (up to 200 rows in one request) so a
 * polled page keeps its place; a change of `status` starts again from the first page.
 *
 * @param id - The batch.
 * @param status - Only the items in this status; `undefined` for all.
 * @param pageSize - Items per page. Default 50.
 * @returns The items, paging and refresh.
 *
 * @stability experimental
 */
export function useImportBatchItems(
  id: string | undefined,
  status: NoteImportItemStatus | undefined,
  pageSize = 50,
): UseImportBatchItemsResult {
  const host = useKvoxHost();
  const isMounted = useIsMounted();
  const [items, setItems] = useState<NoteImportBatchItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The filter the in-flight answer belongs to: a late answer for another filter is dropped.
  const generation = useRef(0);
  const loaded = useRef(0);

  const loadFirst = useCallback(
    async (limit: number) => {
      if (!id) return;
      const mine = generation.current;
      try {
        const page = await listNoteImportBatchItems(host, id, {
          ...(status ? { status } : {}),
          limit: Math.min(MAX_PAGE, Math.max(pageSize, limit)),
        });
        if (!isMounted() || mine !== generation.current) return;
        setItems(page.items);
        loaded.current = page.items.length;
        setCursor(page.nextCursor);
        setError(null);
      } catch (err) {
        if (isMounted() && mine === generation.current) setError(messageFor(err, 'Failed to load the files'));
      } finally {
        if (isMounted() && mine === generation.current) setIsLoading(false);
      }
    },
    [host, id, isMounted, pageSize, status],
  );

  useEffect(() => {
    generation.current += 1;
    loaded.current = 0;
    setItems([]);
    setCursor(null);
    setIsLoading(true);
    void loadFirst(pageSize);
  }, [loadFirst, pageSize]);

  const loadMore = useCallback(async () => {
    if (!id || !cursor) return;
    const mine = generation.current;
    setIsLoadingMore(true);
    try {
      const page = await listNoteImportBatchItems(host, id, {
        ...(status ? { status } : {}),
        cursor,
        limit: pageSize,
      });
      if (!isMounted() || mine !== generation.current) return;
      setItems((previous) => {
        const seen = new Set(previous.map((item) => item.id));
        const merged = [...previous, ...page.items.filter((item) => !seen.has(item.id))];
        loaded.current = merged.length;
        return merged;
      });
      setCursor(page.nextCursor);
    } catch (err) {
      if (isMounted() && mine === generation.current) setError(messageFor(err, 'Failed to load more files'));
    } finally {
      if (isMounted()) setIsLoadingMore(false);
    }
  }, [cursor, host, id, isMounted, pageSize, status]);

  const refresh = useCallback(() => loadFirst(loaded.current), [loadFirst]);

  return { items, isLoading, isLoadingMore, error, hasMore: cursor !== null, loadMore, refresh };
}
