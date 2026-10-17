/**
 * `useGraphMentions` — the notes and transcripts that mention one entity
 * (#370's additive `GET /api/graph/entities/:id/mentions`), paged.
 */

import { useCallback, useEffect, useState } from 'react';

import { getEntityMentions } from '../clients/graph.js';
import type { EntityMention } from '../clients/graph.js';
import { graphErrorMessage, isAbortError, useAbortControllers } from './graphHookUtils.js';

import { useIsMounted, useKvoxHost } from '../../../core/headless/index.js';
/**
 * What {@link useGraphMentions} returns.
 *
 * @stability experimental
 */
export interface UseGraphMentionsResult {
  /** The notes and transcripts loaded so far, across all pages. */
  data: EntityMention[];
  /** Cursor for the next page, or `null` on the last one. */
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
 * Lists the notes and transcripts that mention one entity, paged. Does nothing while `id` is undefined.
 *
 * @stability experimental
 */
export function useGraphMentions(id: string | undefined): UseGraphMentionsResult {
  const host = useKvoxHost();
  const [data, setData] = useState<EntityMention[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isMounted = useIsMounted();
  const nextController = useAbortControllers();

  const load = useCallback(async () => {
    if (!id) return;
    const controller = nextController();
    setIsLoading(true);
    try {
      const page = await getEntityMentions(host, id, undefined, controller.signal);
      if (!isMounted() || controller.signal.aborted) return;
      setData(page.items);
      setNextCursor(page.nextCursor);
      setError(null);
    } catch (err) {
      if (!isMounted() || isAbortError(err) || controller.signal.aborted) return;
      setError(graphErrorMessage(err, 'Failed to load mentions'));
    } finally {
      if (isMounted() && !controller.signal.aborted) setIsLoading(false);
    }
  }, [id, isMounted, nextController]);

  useEffect(() => {
    setData([]);
    setNextCursor(null);
    void load();
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!id || !nextCursor || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const page = await getEntityMentions(host, id, nextCursor);
      if (!isMounted()) return;
      setData((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (!isMounted() || isAbortError(err)) return;
      setError(graphErrorMessage(err, 'Failed to load more mentions'));
    } finally {
      if (isMounted()) setIsLoadingMore(false);
    }
  }, [id, isLoadingMore, isMounted, nextCursor]);

  return { data, nextCursor, isLoading, isLoadingMore, error, loadMore, refresh: load };
}
