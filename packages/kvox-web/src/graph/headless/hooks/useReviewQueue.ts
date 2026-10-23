/**
 * `useReviewQueue` and `useCommitBatch` (#721): the grouped review queue
 * (`GET /api/graph/review-queue`) and the safe-policy batch commit
 * (`POST /api/graph/proposals/commit-batch`).
 *
 * Not to be confused with `useGraphReviewQueue`, the flat, paged list of draft
 * proposals behind `/graph/review`: this one is grouped by library and import
 * batch and carries the safe and waiting counts a batch commit acts on.
 *
 * Like every graph hook they resolve rather than throw: a failure is a string.
 */

import { useCallback, useEffect, useState } from 'react';

import { useIsMounted, useKvoxHost } from '../../../core/headless/index.js';
import { commitBatch, getReviewQueue } from '../clients/reviewQueue.js';
import type { CommitBatchResult, CommitBatchTarget, ReviewQueueResponse } from '../clients/reviewQueue.js';
import { summarizeCommitBatch } from '../utils/reviewQueue.js';
import type { CommitBatchSummary } from '../utils/reviewQueue.js';
import { graphErrorMessage, isAbortError, useAbortControllers } from './graphHookUtils.js';

/**
 * Options of {@link useReviewQueue}.
 *
 * @stability experimental
 */
export interface UseReviewQueueOptions {
  /** `false` reads nothing (no `graph:read`, connected knowledge off). Default `true`. */
  enabled?: boolean;
  /** At most this many proposals; the server's default is its maximum. */
  limit?: number;
}

/**
 * What {@link useReviewQueue} returns.
 *
 * @stability experimental
 */
export interface UseReviewQueueResult {
  /** The last answer, or `null` before the first one settles (or when disabled). */
  queue: ReviewQueueResponse | null;
  /** The first read is in flight. */
  isLoading: boolean;
  /** Why the last read failed, or `null`. */
  error: string | null;
  /** Re-reads the queue, keeping the current answer on screen meanwhile. */
  refresh: () => Promise<void>;
}

/**
 * The caller's open drafts, grouped by library, import batch or neither.
 *
 * @param options - See {@link UseReviewQueueOptions}.
 * @returns The queue, the load state and `refresh`.
 *
 * @stability experimental
 */
export function useReviewQueue(options: UseReviewQueueOptions = {}): UseReviewQueueResult {
  const { enabled = true, limit } = options;
  const host = useKvoxHost();
  const isMounted = useIsMounted();
  const nextController = useAbortControllers();
  const [queue, setQueue] = useState<ReviewQueueResponse | null>(null);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (showLoading: boolean) => {
      if (!enabled) return;
      const controller = nextController();
      if (showLoading) setIsLoading(true);
      try {
        const next = await getReviewQueue(host, limit, controller.signal);
        if (!isMounted() || controller.signal.aborted) return;
        setQueue(next);
        setError(null);
      } catch (err) {
        if (!isMounted() || isAbortError(err) || controller.signal.aborted) return;
        setError(graphErrorMessage(err, 'Failed to load the review queue'));
      } finally {
        if (isMounted() && !controller.signal.aborted) setIsLoading(false);
      }
    },
    [enabled, host, isMounted, limit, nextController],
  );

  useEffect(() => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }
    void load(true);
  }, [enabled, load]);

  const refresh = useCallback(() => load(false), [load]);

  return { queue, isLoading, error, refresh };
}

/**
 * Where a batch commit stands.
 *
 * @stability experimental
 */
export type CommitBatchState = 'idle' | 'running' | 'done' | 'error';

/**
 * Options of {@link useCommitBatch}.
 *
 * @stability experimental
 */
export interface UseCommitBatchOptions {
  /** Called after a commit answered (typically the queue's `refresh`). */
  onCommitted?: (results: CommitBatchResult[]) => void;
}

/**
 * What {@link useCommitBatch} returns.
 *
 * @stability experimental
 */
export interface UseCommitBatchResult {
  /** Where the commit stands. */
  state: CommitBatchState;
  /** The per-proposal outcomes of the last commit, or `null`. */
  results: CommitBatchResult[] | null;
  /** Those outcomes counted, or `null`. */
  summary: CommitBatchSummary | null;
  /** Why the request itself failed, or `null`. */
  error: string | null;
  /** Commits the safe rows of a library, a batch or a list of proposals. Resolves `true` when the request answered. */
  commit: (target: CommitBatchTarget) => Promise<boolean>;
  /** Back to `idle`, forgetting the last outcome. */
  reset: () => void;
}

/**
 * Applies the safe policy to many drafts at once.
 *
 * @param options - See {@link UseCommitBatchOptions}.
 * @returns The state, the outcomes and `commit`.
 *
 * @stability experimental
 */
export function useCommitBatch(options: UseCommitBatchOptions = {}): UseCommitBatchResult {
  const { onCommitted } = options;
  const host = useKvoxHost();
  const isMounted = useIsMounted();
  const [state, setState] = useState<CommitBatchState>('idle');
  const [results, setResults] = useState<CommitBatchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const commit = useCallback(
    async (target: CommitBatchTarget) => {
      setState('running');
      setResults(null);
      setError(null);
      try {
        const answer = await commitBatch(host, target);
        if (!isMounted()) return true;
        setResults(answer);
        setState('done');
        onCommitted?.(answer);
        return true;
      } catch (err) {
        if (!isMounted()) return false;
        setError(graphErrorMessage(err, 'Could not commit the safe rows'));
        setState('error');
        return false;
      }
    },
    [host, isMounted, onCommitted],
  );

  const reset = useCallback(() => {
    setState('idle');
    setResults(null);
    setError(null);
  }, []);

  return { state, results, summary: results ? summarizeCommitBatch(results) : null, error, commit, reset };
}
