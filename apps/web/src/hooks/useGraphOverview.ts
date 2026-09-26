/**
 * `useGraphOverview` — the whole-graph overview snapshot (#375, epic #347;
 * spec §22.3): `{ overview, isLoading, error, refresh, requestRecompute }`.
 *
 * READ-ONLY BY DEFAULT. `GET /api/graph/overview` never recomputes a layout;
 * a stale snapshot is reported (`stale: true`) and only a person pressing
 * Refresh — `requestRecompute()`, `POST /api/graph/overview/refresh`,
 * `graph:write` — queues a new one.
 *
 * POLLING. While the server says a layout job is `pending`, the hook re-reads
 * every `OVERVIEW_POLL_MS` through `useVisiblePolling` (so a hidden tab never
 * polls), and stops when `pending` turns false or after `OVERVIEW_POLL_MAX_MS`
 * of pending — a wedged job must not keep a forgotten tab polling forever.
 * A successful `requestRecompute()` marks the snapshot pending locally (the
 * server has just queued the job) and restarts that budget.
 *
 * Resolves rather than throws, like every graph hook: a failure is a string.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { getGraphOverview, refreshGraphOverview, type GraphOverview } from '../services/graph';
import { graphErrorMessage, isAbortError, useAbortControllers } from './graphHookUtils';
import { useIsMounted } from './useIsMounted';
import { useVisiblePolling } from './useVisiblePolling';

/** How often a pending overview is re-read. */
export const OVERVIEW_POLL_MS = 10_000;
/** How long a pending overview is polled before giving up. */
export const OVERVIEW_POLL_MAX_MS = 15 * 60_000;

export interface UseGraphOverviewResult {
  overview: GraphOverview | null;
  isLoading: boolean;
  error: string | null;
  /** Re-read the snapshot without the loading state. */
  refresh: () => Promise<void>;
  /** Queue a re-layout. Resolves `true` when the server accepted it. */
  requestRecompute: () => Promise<boolean>;
  /** A `requestRecompute()` is in flight. */
  isRequesting: boolean;
  /** Why the last `requestRecompute()` failed, if it did. */
  requestError: string | null;
  /** Polling gave up after `OVERVIEW_POLL_MAX_MS` while still pending. */
  pollingStopped: boolean;
}

export function useGraphOverview(): UseGraphOverviewResult {
  const [overview, setOverview] = useState<GraphOverview | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isRequesting, setIsRequesting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [pollingStopped, setPollingStopped] = useState(false);

  const isMounted = useIsMounted();
  const nextController = useAbortControllers();
  /** When the current run of `pending` answers began (ms), or null. */
  const pendingSince = useRef<number | null>(null);

  const load = useCallback(
    async (showLoading: boolean) => {
      const controller = nextController();
      if (showLoading) setIsLoading(true);
      try {
        const next = await getGraphOverview(controller.signal);
        if (!isMounted() || controller.signal.aborted) return;
        setOverview(next);
        setError(null);
      } catch (err) {
        if (!isMounted() || isAbortError(err) || controller.signal.aborted) return;
        setError(graphErrorMessage(err, 'Failed to load the overview'));
      } finally {
        if (isMounted() && !controller.signal.aborted && showLoading) setIsLoading(false);
      }
    },
    [isMounted, nextController],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  const pending = overview?.pending === true;
  useEffect(() => {
    if (!pending) {
      pendingSince.current = null;
      setPollingStopped(false);
    } else if (pendingSince.current === null) {
      pendingSince.current = Date.now();
    }
  }, [pending]);

  const poll = useCallback(() => {
    if (pendingSince.current !== null && Date.now() - pendingSince.current >= OVERVIEW_POLL_MAX_MS) {
      setPollingStopped(true);
      return;
    }
    void load(false);
  }, [load]);

  useVisiblePolling(poll, pending && !pollingStopped ? OVERVIEW_POLL_MS : 0);

  const refresh = useCallback(() => load(false), [load]);

  const requestRecompute = useCallback(async () => {
    setIsRequesting(true);
    setRequestError(null);
    try {
      await refreshGraphOverview();
      if (!isMounted()) return true;
      pendingSince.current = Date.now();
      setPollingStopped(false);
      setOverview((current) => (current ? { ...current, pending: true } : current));
      return true;
    } catch (err) {
      if (isMounted()) setRequestError(graphErrorMessage(err, 'Could not refresh the overview'));
      return false;
    } finally {
      if (isMounted()) setIsRequesting(false);
    }
  }, [isMounted]);

  return {
    overview,
    isLoading,
    error,
    refresh,
    requestRecompute,
    isRequesting,
    requestError,
    pollingStopped,
  };
}
