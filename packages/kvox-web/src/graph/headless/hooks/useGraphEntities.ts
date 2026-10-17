/**
 * `useGraphEntities` — the `/graph` index list, Home's Knowledge section and
 * the library's entity hits (#373).
 *
 * HAND-ROLLED like every other data hook here (`useNotes`, `useTranscripts`).
 *
 * `q` IS DEBOUNCED HERE, 250 ms, because every caller feeds it straight from
 * a text box and the API ranks by trigram similarity — a request per
 * keystroke is load for answers nobody reads. A NEW QUESTION (type, q, sort)
 * resets the list; `loadMore` appends. With `q` the API returns the top
 * `limit` by similarity and `nextCursor: null`, so "Load more" disappears on
 * its own.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { listGraphEntities } from '../clients/graph.js';
import type { GraphEntitySummary } from '../clients/graph.js';
import { graphErrorMessage, isAbortError, useAbortControllers } from './graphHookUtils.js';

import { useIsMounted, useKvoxHost } from '../../../core/headless/index.js';
/**
 * Milliseconds the search text is held back before a request is made, so typing does not issue one request per keystroke.
 *
 * @stability experimental
 */
export const GRAPH_SEARCH_DEBOUNCE_MS = 250;

/**
 * Options for {@link useGraphEntities}.
 *
 * @stability experimental
 */
export interface UseGraphEntitiesOptions {
  /** Entity type keys to keep; omitted means every type. */
  type?: readonly string[];
  /** Search text over labels and aliases; debounced and trimmed. With it the API returns only the top matches and no further pages. */
  q?: string;
  /** `updated` orders by most recent change, `viewed` by the entities the caller viewed last. */
  sort?: 'updated' | 'viewed';
  /** Page size. */
  limit?: number;
  /** Only the Persons identified as a speaker in this transcript. */
  transcriptId?: string;
  /** `false` issues no request at all (no permission, or nothing to ask). */
  enabled?: boolean;
  /** Override the debounce — `0` in a test that does not want fake timers. */
  debounceMs?: number;
}

/**
 * What {@link useGraphEntities} returns.
 *
 * @stability experimental
 */
export interface UseGraphEntitiesResult {
  /** The entities loaded so far, across all pages. */
  data: GraphEntitySummary[];
  /** Cursor for the next page, or `null` when there is none (always `null` while searching). */
  nextCursor: string | null;
  /** The first page is loading. */
  isLoading: boolean;
  /** A further page is loading. */
  isLoadingMore: boolean;
  /** A message when the last request failed, else `null`. */
  error: string | null;
  /** Appends the next page; does nothing without a cursor. */
  loadMore: () => Promise<void>;
  /** Reloads the first page. */
  refresh: () => Promise<void>;
}

/**
 * Debounce a value. `0` passes it straight through.
 *
 * @stability experimental
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (delayMs <= 0) {
      setDebounced(value);
      return undefined;
    }
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return delayMs <= 0 ? value : debounced;
}

/**
 * Lists the caller's entities, paged, with a debounced search. A new question (type, search or sort) resets the list.
 *
 * @stability experimental
 */
export function useGraphEntities(options: UseGraphEntitiesOptions = {}): UseGraphEntitiesResult {
  const host = useKvoxHost();
  const {
    type,
    q = '',
    sort,
    limit,
    transcriptId,
    enabled = true,
    debounceMs = GRAPH_SEARCH_DEBOUNCE_MS,
  } = options;

  const debouncedQ = useDebouncedValue(q.trim(), debounceMs);
  // A stable key for the array so a fresh `['Person']` each render is not a new question.
  const typeKey = (type ?? []).join(',');

  const [data, setData] = useState<GraphEntitySummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(enabled);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isMounted = useIsMounted();
  const nextListController = useAbortControllers();
  const nextMoreController = useAbortControllers();

  const params = useMemo(
    () => ({
      type: typeKey ? typeKey.split(',') : undefined,
      q: debouncedQ || undefined,
      sort,
      limit,
      transcriptId,
    }),
    [typeKey, debouncedQ, sort, limit, transcriptId],
  );

  const load = useCallback(
    async (showLoading: boolean) => {
      if (!enabled) return;
      const controller = nextListController();
      if (showLoading) setIsLoading(true);
      try {
        const page = await listGraphEntities(host, params, controller.signal);
        if (!isMounted() || controller.signal.aborted) return;
        setData(page.items);
        setNextCursor(page.nextCursor);
        setError(null);
      } catch (err) {
        if (!isMounted() || isAbortError(err) || controller.signal.aborted) return;
        setError(graphErrorMessage(err, 'Failed to load your knowledge graph'));
      } finally {
        if (isMounted() && !controller.signal.aborted) setIsLoading(false);
      }
    },
    [enabled, isMounted, nextListController, params],
  );

  useEffect(() => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }
    setData([]);
    setNextCursor(null);
    void load(true);
  }, [enabled, load]);

  const loadMore = useCallback(async () => {
    if (!enabled || !nextCursor || isLoadingMore) return;
    const controller = nextMoreController();
    setIsLoadingMore(true);
    try {
      const page = await listGraphEntities(host, { ...params, cursor: nextCursor }, controller.signal);
      if (!isMounted() || controller.signal.aborted) return;
      setData((current) => {
        const seen = new Set(current.map((row) => row.id));
        return [...current, ...page.items.filter((row) => !seen.has(row.id))];
      });
      setNextCursor(page.nextCursor);
      setError(null);
    } catch (err) {
      if (!isMounted() || isAbortError(err)) return;
      setError(graphErrorMessage(err, 'Failed to load more'));
    } finally {
      if (isMounted()) setIsLoadingMore(false);
    }
  }, [enabled, isLoadingMore, isMounted, nextCursor, nextMoreController, params]);

  const refresh = useCallback(() => load(true), [load]);

  return { data, nextCursor, isLoading, isLoadingMore, error, loadMore, refresh };
}
