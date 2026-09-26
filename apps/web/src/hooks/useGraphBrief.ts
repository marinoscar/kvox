/**
 * `useGraphBrief` — one entity's cited brief (#372), for `EntityBriefCard`.
 *
 * =============================================================================
 * THE FIRST READ MARKS THE VIEW; NOTHING AFTER IT DOES
 * =============================================================================
 *
 * `GET …/brief` upserts `kg_entity_views.last_viewed_at` when `markViewed` is
 * true, and "since you last looked" is computed against the PREVIOUS visit.
 * So the page's first read passes `markViewed: true` — this visit counts — and
 * every refresh after it (the Refresh button, the digest poll, a save) passes
 * `false`: re-reading the same page three times in a minute is one look, and
 * moving the mark on each of them would shrink tomorrow's "since" window to
 * the last poll.
 *
 * =============================================================================
 * POLLING WHILE A DIGEST IS BEING WRITTEN — AND ONLY FOR TWO MINUTES
 * =============================================================================
 *
 * The page never asks for AI prose (#372): the GET enqueues `kg.entity_digest`
 * when the stored digest is stale and reports `digestPending: true`. This hook
 * then re-reads every 5 s through `useVisiblePolling` until the new digest
 * lands — and gives up after two minutes, so a job stuck behind a busy queue
 * cannot hold an open tab polling forever. The "Updating summary…" caption
 * stays; a manual Refresh starts a fresh two-minute window.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { getEntityBrief } from '../services/graph';
import type { EntityBrief } from '../services/graph';
import { graphErrorMessage, isAbortError, useAbortControllers } from './graphHookUtils';
import { useIsMounted } from './useIsMounted';
import { useVisiblePolling } from './useVisiblePolling';

export const BRIEF_DIGEST_POLL_MS = 5_000;
export const BRIEF_DIGEST_POLL_MAX_MS = 2 * 60_000;

export interface UseGraphBriefOptions {
  /** Override the poll interval — `0` disables polling (tests). */
  pollIntervalMs?: number;
  /** Override the give-up window (tests). */
  pollMaxMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

export interface UseGraphBriefResult {
  data: EntityBrief | null;
  isLoading: boolean;
  error: string | null;
  /** Re-read with `markViewed: false`, restarting the digest poll window. */
  refresh: () => Promise<void>;
  /** Whether the hook is still polling for a pending digest. */
  isPolling: boolean;
}

export function useGraphBrief(
  id: string | undefined,
  options: UseGraphBriefOptions = {},
): UseGraphBriefResult {
  const {
    pollIntervalMs = BRIEF_DIGEST_POLL_MS,
    pollMaxMs = BRIEF_DIGEST_POLL_MAX_MS,
    now = Date.now,
  } = options;

  const [data, setData] = useState<EntityBrief | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pollStartedAt, setPollStartedAt] = useState<number | null>(null);
  const [pollExpired, setPollExpired] = useState(false);

  const isMounted = useIsMounted();
  const nextController = useAbortControllers();
  const nowRef = useRef(now);
  nowRef.current = now;

  const load = useCallback(
    async (markViewed: boolean, showLoading: boolean) => {
      if (!id) return;
      const controller = nextController();
      if (showLoading) setIsLoading(true);
      try {
        const next = await getEntityBrief(id, { markViewed }, controller.signal);
        if (!isMounted() || controller.signal.aborted) return;
        setData(next);
        setError(null);
      } catch (err) {
        if (!isMounted() || isAbortError(err) || controller.signal.aborted) return;
        setError(graphErrorMessage(err, 'Failed to load the brief'));
      } finally {
        if (isMounted() && !controller.signal.aborted && showLoading) setIsLoading(false);
      }
    },
    [id, isMounted, nextController],
  );

  useEffect(() => {
    setData(null);
    setError(null);
    setPollStartedAt(null);
    setPollExpired(false);
    void load(true, true);
  }, [load]);

  const pending = data?.digestPending === true;

  // Start (or clear) the two-minute window as `digestPending` comes and goes.
  useEffect(() => {
    if (pending) {
      setPollStartedAt(nowRef.current());
    } else {
      setPollStartedAt(null);
      setPollExpired(false);
    }
  }, [pending]);

  const isPolling = pending && !pollExpired && pollIntervalMs > 0;

  useVisiblePolling(
    () => {
      if (pollStartedAt !== null && nowRef.current() - pollStartedAt >= pollMaxMs) {
        setPollExpired(true);
        return;
      }
      void load(false, false);
    },
    isPolling ? pollIntervalMs : 0,
  );

  const refresh = useCallback(async () => {
    // A person asked: a fresh two-minute window. The `pending` effect above
    // only fires on a transition, so a still-pending digest is restarted here.
    setPollStartedAt(nowRef.current());
    setPollExpired(false);
    await load(false, false);
  }, [load]);

  return { data, isLoading, error, refresh, isPolling };
}
