/**
 * Possible duplicates (#766):
 *
 *   - `useGraphDuplicates(params)` — the caller's possible-duplicate pairs
 *     (`GET /api/graph/duplicates`), with `reload` and an optimistic
 *     `removePair` for a pair the person has just merged or told apart.
 *   - `useScanDuplicates()` — queues the deeper scan
 *     (`POST /api/graph/duplicates/scan`).
 *
 * Like every graph hook these RESOLVE rather than throw: a failure is a string
 * the caller renders. Plain state plus an abort per request, no cache.
 */

import { useCallback, useEffect, useState } from 'react';

import { listDuplicates, scanDuplicates } from '../clients/graph.js';
import type { DuplicatePair, DuplicatesScanResult, ListDuplicatesParams } from '../clients/graph.js';
import { graphConflictReason } from '../clients/graph.js';
import { graphErrorMessage, isAbortError, useAbortControllers } from './graphHookUtils.js';

import { useIsMounted, useKvoxHost } from '../../../core/headless/index.js';

/**
 * The key of a pair, the same whichever side is `a`.
 *
 * @stability experimental
 */
export function duplicatePairKey(pair: Pick<DuplicatePair, 'a' | 'b'>): string {
  return pair.a.id < pair.b.id ? `${pair.a.id}:${pair.b.id}` : `${pair.b.id}:${pair.a.id}`;
}

/**
 * Options of {@link useGraphDuplicates}.
 *
 * @stability experimental
 */
export interface UseGraphDuplicatesOptions {
  /** `false` skips the request (and reports an empty list); default `true`. */
  enabled?: boolean;
}

/**
 * What {@link useGraphDuplicates} returns.
 *
 * @stability experimental
 */
export interface UseGraphDuplicatesResult {
  /** The pairs, best first; empty until loaded or when loading failed. */
  pairs: DuplicatePair[];
  /** The first load, or a `reload`, is in flight. */
  isLoading: boolean;
  /** A message when loading failed, else `null`. */
  error: string | null;
  /** Reads the list again. */
  reload: () => Promise<void>;
  /**
   * Drops a pair from the list without a request; with `entityId`, also every
   * other pair that names that entity (it was merged away, so they are stale).
   */
  removePair: (pair: Pick<DuplicatePair, 'a' | 'b'>, entityId?: string) => void;
}

/**
 * Loads the caller's possible-duplicate pairs.
 *
 * @stability experimental
 */
export function useGraphDuplicates(
  params: ListDuplicatesParams = {},
  options: UseGraphDuplicatesOptions = {},
): UseGraphDuplicatesResult {
  const host = useKvoxHost();
  const isMounted = useIsMounted();
  const nextController = useAbortControllers();
  const enabled = options.enabled ?? true;
  const { type, limit } = params;
  const [pairs, setPairs] = useState<DuplicatePair[]>([]);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!enabled) return;
    const controller = nextController();
    setIsLoading(true);
    try {
      const rows = await listDuplicates(host, { type, limit }, controller.signal);
      if (!isMounted() || controller.signal.aborted) return;
      setPairs(rows);
      setError(null);
    } catch (err) {
      if (!isMounted() || isAbortError(err) || controller.signal.aborted) return;
      setError(graphErrorMessage(err, 'Could not load the possible duplicates'));
    } finally {
      if (isMounted() && !controller.signal.aborted) setIsLoading(false);
    }
  }, [enabled, host, isMounted, limit, nextController, type]);

  useEffect(() => {
    setPairs([]);
    setError(null);
    setIsLoading(enabled);
    void reload();
  }, [enabled, reload]);

  const removePair = useCallback((pair: Pick<DuplicatePair, 'a' | 'b'>, entityId?: string) => {
    const key = duplicatePairKey(pair);
    setPairs((current) =>
      current.filter(
        (row) =>
          duplicatePairKey(row) !== key && (entityId === undefined || (row.a.id !== entityId && row.b.id !== entityId)),
      ),
    );
  }, []);

  return { pairs, isLoading, error, reload, removePair };
}

/**
 * Copy for a scan refused because connected knowledge is switched off (`409`, `details.reason: "graph_disabled"`).
 *
 * @stability experimental
 */
export const DUPLICATES_GRAPH_DISABLED_MESSAGE = 'Connected knowledge is switched off on this deployment.';

/**
 * What {@link useScanDuplicates} returns.
 *
 * @stability experimental
 */
export interface UseScanDuplicatesResult {
  /** Queues the scan; resolves to the API's answer, or `null` when it failed (see `error`). */
  scan: () => Promise<DuplicatesScanResult | null>;
  /** The request is in flight. */
  isScanning: boolean;
  /** The last failure's message, or `null`. Cleared when a scan starts. */
  error: string | null;
  /** Clears `error`. */
  clearError: () => void;
}

/**
 * Queues the deeper duplicate scan (`kg.resolve`).
 *
 * @stability experimental
 */
export function useScanDuplicates(): UseScanDuplicatesResult {
  const host = useKvoxHost();
  const isMounted = useIsMounted();
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scan = useCallback(async () => {
    setIsScanning(true);
    setError(null);
    try {
      return await scanDuplicates(host);
    } catch (err) {
      if (isMounted()) {
        setError(
          graphConflictReason(err) === 'graph_disabled'
            ? DUPLICATES_GRAPH_DISABLED_MESSAGE
            : graphErrorMessage(err, 'Could not start looking for duplicates'),
        );
      }
      return null;
    } finally {
      if (isMounted()) setIsScanning(false);
    }
  }, [host, isMounted]);

  const clearError = useCallback(() => setError(null), []);

  return { scan, isScanning, error, clearError };
}
