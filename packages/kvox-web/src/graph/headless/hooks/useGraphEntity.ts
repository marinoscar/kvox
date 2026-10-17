/**
 * `useGraphEntity` — one entity's detail (#373), the `useNote` shape:
 * `{ data, isLoading, error, notFound, refresh }`.
 *
 * `notFound` is surfaced separately from `error` because the page renders a
 * 404 as its own state ("This page does not exist, or you no longer have
 * access to it") with no Retry — retrying cannot change a 404's answer.
 */

import { useCallback, useEffect, useState } from 'react';

import { getGraphEntity } from '../clients/graph.js';
import type { GraphEntityDetail } from '../clients/graph.js';
import { graphErrorMessage, isAbortError, useAbortControllers } from './graphHookUtils.js';

import { KvoxApiError, useIsMounted, useKvoxHost } from '../../../core/headless/index.js';
/**
 * What use graph entity returns.
 *
 * @stability experimental
 */
export interface UseGraphEntityResult {
  /** The data. */
  data: GraphEntityDetail | null;
  /** Whether it is loading. */
  isLoading: boolean;
  /** The error. */
  error: string | null;
  /** Whether not found applies. */
  notFound: boolean;
  /** The refresh. */
  refresh: () => Promise<void>;
}

/**
 * Hook: reads graph entity.
 *
 * @stability experimental
 */
export function useGraphEntity(id: string | undefined): UseGraphEntityResult {
  const host = useKvoxHost();
  const [data, setData] = useState<GraphEntityDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const isMounted = useIsMounted();
  const nextController = useAbortControllers();

  const load = useCallback(
    async (showLoading: boolean) => {
      if (!id) return;
      const controller = nextController();
      if (showLoading) setIsLoading(true);
      try {
        const next = await getGraphEntity(host, id, controller.signal);
        if (!isMounted() || controller.signal.aborted) return;
        setData(next);
        setError(null);
        setNotFound(false);
      } catch (err) {
        if (!isMounted() || isAbortError(err) || controller.signal.aborted) return;
        setNotFound(err instanceof KvoxApiError && err.status === 404);
        setError(graphErrorMessage(err, 'Failed to load this page'));
      } finally {
        if (isMounted() && !controller.signal.aborted && showLoading) setIsLoading(false);
      }
    },
    [id, isMounted, nextController],
  );

  useEffect(() => {
    // Reset rather than keep the previous entity on screen: `/graph/entities/a`
    // → `/b` must not render a's aliases under b's heading for a frame.
    setData(null);
    setError(null);
    setNotFound(false);
    setIsLoading(true);
    void load(true);
  }, [load]);

  const refresh = useCallback(() => load(false), [load]);

  return { data, isLoading, error, notFound, refresh };
}
