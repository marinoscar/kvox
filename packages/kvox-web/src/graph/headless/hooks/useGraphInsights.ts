/**
 * `useGraphInsights` — the insights of the caller's graph (GIC-16, #677; epic
 * #661): `{ insights, isLoading, error, refresh }` for a window of 30, 90 or 365
 * days.
 *
 * READ-ONLY. Themes and connectors come from the stored layout snapshot and are
 * never recomputed by this read; while the server says a layout job is pending
 * the hook re-reads every `OVERVIEW_POLL_MS` (through `useVisiblePolling`, so a
 * hidden tab never polls) until the snapshot lands, for at most
 * `OVERVIEW_POLL_MAX_MS`. Changing the window refetches and keeps the previous
 * answer on screen meanwhile.
 *
 * Resolves rather than throws, like every graph hook: a failure is a string.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { getGraphInsights, type GraphInsights, type GraphInsightsWindow } from '../clients/graph.js';
import { graphErrorMessage, isAbortError, useAbortControllers } from './graphHookUtils.js';
import { OVERVIEW_POLL_MAX_MS, OVERVIEW_POLL_MS } from './useGraphOverview.js';
import { useIsMounted, useKvoxHost, useVisiblePolling } from '../../../core/headless/index.js';

/**
 * What {@link useGraphInsights} returns.
 *
 * @stability experimental
 */
export interface UseGraphInsightsResult {
  /** The latest answer, or `null` until the first read settles. */
  insights: GraphInsights | null;
  /** A read is in flight and there is no answer to show yet. */
  isLoading: boolean;
  /** A message when the last read failed, else `null`. */
  error: string | null;
  /** Re-read without the loading state. */
  refresh: () => Promise<void>;
}

/**
 * Reads the graph insights for a window and re-reads while a layout job is pending.
 *
 * @stability experimental
 */
export function useGraphInsights(window: GraphInsightsWindow = '30d', enabled = true): UseGraphInsightsResult {
  const host = useKvoxHost();
  const [insights, setInsights] = useState<GraphInsights | null>(null);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();
  const nextController = useAbortControllers();
  const pendingSince = useRef<number | null>(null);

  const load = useCallback(
    async (showLoading: boolean) => {
      const controller = nextController();
      if (showLoading) setIsLoading(true);
      try {
        const next = await getGraphInsights(host, window, controller.signal);
        if (!isMounted() || controller.signal.aborted) return;
        setInsights(next);
        setError(null);
      } catch (err) {
        if (!isMounted() || isAbortError(err) || controller.signal.aborted) return;
        setError(graphErrorMessage(err, 'Failed to load the insights'));
      } finally {
        if (isMounted() && !controller.signal.aborted && showLoading) setIsLoading(false);
      }
    },
    [host, isMounted, nextController, window],
  );

  useEffect(() => {
    if (enabled) void load(true);
  }, [enabled, load]);

  const pending = insights?.pending === true;
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    if (!pending) {
      pendingSince.current = null;
      setGaveUp(false);
    } else if (pendingSince.current === null) {
      pendingSince.current = Date.now();
    }
  }, [pending]);

  const poll = useCallback(() => {
    if (pendingSince.current !== null && Date.now() - pendingSince.current >= OVERVIEW_POLL_MAX_MS) {
      setGaveUp(true);
      return;
    }
    void load(false);
  }, [load]);

  useVisiblePolling(poll, enabled && pending && !gaveUp ? OVERVIEW_POLL_MS : 0);

  const refresh = useCallback(() => load(false), [load]);
  return { insights, isLoading, error, refresh };
}
