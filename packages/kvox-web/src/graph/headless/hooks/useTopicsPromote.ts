/**
 * `useTopicsPromote` — the "Find topics in past meetings" run of the caller's
 * own graph (#666, epic #661; spec §11).
 *
 * `start()` POSTs `/api/graph/topics/promote` (queues `kg.topics_promote`, which
 * spends the caller's AI key, so it only ever runs on a click). The hook reads
 * `GET /api/graph/topics/promote` once when `enabled` turns on, so a run begun
 * earlier (or in another tab) is picked up, and re-reads it every
 * `pollIntervalMs` (3 s) while that run is pending or running. The count of
 * proposals waiting for review grows during the run.
 *
 * Resolves rather than throws, like every graph hook: a failure is a string.
 * Every async resolution is guarded by a run counter, so an unmount or a second
 * `start` never lets a stale answer land on newer state.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { getTopicsPromoteStatus, graphConflictReason, requestTopicsPromote } from '../clients/graph.js';
import type { TopicsPromoteStatus } from '../clients/graph.js';
import { graphErrorMessage } from './graphHookUtils.js';

import { useKvoxHost } from '../../../core/headless/index.js';

/**
 * How often a pending or running search is re-read.
 *
 * @stability experimental
 */
export const TOPICS_PROMOTE_POLL_MS = 3_000;

/**
 * Where the search is: nothing run yet (`idle`), queued or running (`working`), finished (`done`) or failed (`error`).
 *
 * @stability experimental
 */
export type TopicsPromotePhase = 'idle' | 'working' | 'done' | 'error';

/**
 * Options for {@link useTopicsPromote}; mainly for tests.
 *
 * @stability experimental
 */
export interface UseTopicsPromoteOptions {
  /** Milliseconds between reads of a working run; defaults to {@link TOPICS_PROMOTE_POLL_MS}. */
  pollIntervalMs?: number;
}

/**
 * What {@link useTopicsPromote} returns.
 *
 * @stability experimental
 */
export interface UseTopicsPromoteResult {
  /** Where the latest run is. */
  phase: TopicsPromotePhase;
  /** Topic proposals from past meetings waiting for review; grows while a run works. */
  proposedTopics: number;
  /** A message when the start or the run failed, else `null`. */
  error: string | null;
  /** Queues a run and follows it until it settles. Never throws; failures land in `error`. */
  start: () => Promise<void>;
}

const phaseOf = (status: TopicsPromoteStatus): TopicsPromotePhase => {
  switch (status.job?.status) {
    case 'pending':
    case 'running':
      return 'working';
    case 'succeeded':
      return 'done';
    case 'failed':
      return 'error';
    default:
      return 'idle';
  }
};

/**
 * Starts and follows a topics search over past meetings. Resolves rather than throws: a failure is a message in `error`.
 *
 * @param enabled - Whether to read the latest run; `false` while connected knowledge is off or the viewer cannot write.
 * @param options - Polling interval override.
 * @returns The phase, the proposals waiting, a failure message and `start`.
 *
 * @stability experimental
 */
export function useTopicsPromote(enabled: boolean, options: UseTopicsPromoteOptions = {}): UseTopicsPromoteResult {
  const host = useKvoxHost();
  const pollIntervalMs = options.pollIntervalMs ?? TOPICS_PROMOTE_POLL_MS;

  const [phase, setPhase] = useState<TopicsPromotePhase>('idle');
  const [proposedTopics, setProposedTopics] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const runId = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPolling = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const read = useCallback(
    async (run: number): Promise<void> => {
      try {
        const status = await getTopicsPromoteStatus(host);
        if (runId.current !== run) return;
        const next = phaseOf(status);
        setProposedTopics(status.proposedTopics);
        setPhase(next);
        setError(next === 'error' ? 'The search for topics did not finish. You can run it again.' : null);
        if (next === 'working') {
          timer.current = setTimeout(() => void read(run), pollIntervalMs);
        }
      } catch (err) {
        if (runId.current !== run) return;
        setPhase('error');
        setError(graphErrorMessage(err, 'The search for topics could not be read.'));
      }
    },
    [host, pollIntervalMs],
  );

  useEffect(() => {
    runId.current += 1;
    stopPolling();
    if (!enabled) {
      setPhase('idle');
      setProposedTopics(0);
      setError(null);
      return;
    }
    void read(runId.current);
    return () => {
      runId.current += 1;
      stopPolling();
    };
  }, [enabled, read, stopPolling]);

  const start = useCallback(async () => {
    runId.current += 1;
    const run = runId.current;
    stopPolling();
    setError(null);
    setPhase('working');
    try {
      await requestTopicsPromote(host);
    } catch (err) {
      if (runId.current !== run) return;
      setPhase('error');
      setError(
        graphConflictReason(err) === 'graph_disabled'
          ? 'Connected knowledge is turned off on this deployment.'
          : graphErrorMessage(err, 'The search for topics could not be started.'),
      );
      return;
    }
    if (runId.current !== run) return;
    await read(run);
  }, [host, read, stopPolling]);

  return { phase, proposedTopics, error, start };
}
