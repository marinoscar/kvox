/**
 * `useGraphMentions` — the notes and transcripts that mention one entity
 * (#370's additive `GET /api/graph/entities/:id/mentions`), paged.
 */

import { useCallback, useEffect, useState } from 'react';

import { getEntityMentions } from '../services/graph';
import type { EntityMention } from '../services/graph';
import { graphErrorMessage, isAbortError, useAbortControllers } from './graphHookUtils';
import { useIsMounted } from './useIsMounted';

export interface UseGraphMentionsResult {
  data: EntityMention[];
  nextCursor: string | null;
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useGraphMentions(id: string | undefined): UseGraphMentionsResult {
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
      const page = await getEntityMentions(id, undefined, controller.signal);
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
      const page = await getEntityMentions(id, nextCursor);
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
