/**
 * `useGraphTimeline` — one entity's timeline (#370), paged by keyset cursor.
 *
 * `includeSensitive` is a HOOK ARGUMENT that resets the list: flipping the
 * "Show sensitive facts" switch is a new question (§5.6 — sensitive facts are
 * opt-in per view), so the page never mixes a sensitive-free first page with
 * a sensitive-inclusive second one. Nothing here is cached beyond the
 * component's own state — never `localStorage`.
 */

import { useCallback, useEffect, useState } from 'react';

import { getEntityTimeline } from '../clients/graph.js';
import type { TimelineEvent } from '../clients/graph.js';
import { graphErrorMessage, isAbortError, useAbortControllers } from './graphHookUtils.js';

import { useIsMounted, useKvoxHost } from '../../../core/headless/index.js';
/**
 * The use graph timeline options of the call.
 *
 * @stability experimental
 */
export interface UseGraphTimelineOptions {
  /** Whether include sensitive applies. */
  includeSensitive?: boolean;
  /** The as of. */
  asOf?: string;
  /** The kinds. */
  kinds?: readonly string[];
  /** The limit. */
  limit?: number;
}

/**
 * What use graph timeline returns.
 *
 * @stability experimental
 */
export interface UseGraphTimelineResult {
  /** The data. */
  data: TimelineEvent[];
  /** The next cursor. */
  nextCursor: string | null;
  /** Whether it is loading. */
  isLoading: boolean;
  /** Whether it is loading more. */
  isLoadingMore: boolean;
  /** The error. */
  error: string | null;
  /** The load more. */
  loadMore: () => Promise<void>;
  /** The refresh. */
  refresh: () => Promise<void>;
}

/**
 * Hook: reads graph timeline.
 *
 * @stability experimental
 */
export function useGraphTimeline(
  id: string | undefined,
  options: UseGraphTimelineOptions = {},
): UseGraphTimelineResult {
  const host = useKvoxHost();
  const { includeSensitive = false, asOf, limit } = options;
  const kindsKey = (options.kinds ?? []).join(',');

  const [data, setData] = useState<TimelineEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isMounted = useIsMounted();
  const nextController = useAbortControllers();

  const params = useCallback(
    (cursor?: string) => ({
      includeSensitive,
      asOf,
      limit,
      kinds: kindsKey ? kindsKey.split(',') : undefined,
      cursor,
    }),
    [asOf, includeSensitive, kindsKey, limit],
  );

  const load = useCallback(async () => {
    if (!id) return;
    const controller = nextController();
    setIsLoading(true);
    try {
      const page = await getEntityTimeline(host, id, params(), controller.signal);
      if (!isMounted() || controller.signal.aborted) return;
      setData(page.items);
      setNextCursor(page.nextCursor);
      setError(null);
    } catch (err) {
      if (!isMounted() || isAbortError(err) || controller.signal.aborted) return;
      setError(graphErrorMessage(err, 'Failed to load the timeline'));
    } finally {
      if (isMounted() && !controller.signal.aborted) setIsLoading(false);
    }
  }, [id, isMounted, nextController, params]);

  useEffect(() => {
    setData([]);
    setNextCursor(null);
    void load();
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!id || !nextCursor || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const page = await getEntityTimeline(host, id, params(nextCursor));
      if (!isMounted()) return;
      setData((current) => {
        const seen = new Set(current.map((event) => event.id));
        return [...current, ...page.items.filter((event) => !seen.has(event.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (!isMounted() || isAbortError(err)) return;
      setError(graphErrorMessage(err, 'Failed to load more of the timeline'));
    } finally {
      if (isMounted()) setIsLoadingMore(false);
    }
  }, [id, isLoadingMore, isMounted, nextCursor, params]);

  return { data, nextCursor, isLoading, isLoadingMore, error, loadMore, refresh: load };
}
