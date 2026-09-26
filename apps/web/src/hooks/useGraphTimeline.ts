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

import { getEntityTimeline } from '../services/graph';
import type { TimelineEvent } from '../services/graph';
import { graphErrorMessage, isAbortError, useAbortControllers } from './graphHookUtils';
import { useIsMounted } from './useIsMounted';

export interface UseGraphTimelineOptions {
  includeSensitive?: boolean;
  asOf?: string;
  kinds?: readonly string[];
  limit?: number;
}

export interface UseGraphTimelineResult {
  data: TimelineEvent[];
  nextCursor: string | null;
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useGraphTimeline(
  id: string | undefined,
  options: UseGraphTimelineOptions = {},
): UseGraphTimelineResult {
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
      const page = await getEntityTimeline(id, params(), controller.signal);
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
      const page = await getEntityTimeline(id, params(nextCursor));
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
