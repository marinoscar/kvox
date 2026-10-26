/**
 * Entity merges from the UI (#765, API #364):
 *
 *   - `useEntityMerges(id)` — the entities merged INTO one entity (its page's
 *     "Merged from" section), the `useGraphEntity` read shape.
 *   - `useEntityMergeActions()` — merge, undo a merge, record "not the same".
 *
 * Like every graph hook these RESOLVE rather than throw: a failure is a string
 * the caller renders, and a mutation returns `null`.
 */

import { useCallback, useEffect, useState } from 'react';

import { listEntityMerges, mergeEntity, recordDistinctPair, reverseMerge } from '../clients/graph.js';
import type { DistinctPairResult, EntityMergeRow, MergeEntityResult, ReverseMergeResult } from '../clients/graph.js';
import { graphErrorMessage, isAbortError, useAbortControllers } from './graphHookUtils.js';

import { KvoxApiError, useIsMounted, useKvoxHost } from '../../../core/headless/index.js';

/**
 * Copy for a merge refused because the two entities are of different types (`details.reason: "type_mismatch"`).
 *
 * @stability experimental
 */
export const MERGE_TYPE_MISMATCH_MESSAGE = 'Only entities of the same type can be merged.';

/**
 * Copy for an undo refused because the survivor was merged again since (`details.reason: "revert_conflict"`).
 *
 * @stability experimental
 */
export const MERGE_REVERT_CONFLICT_MESSAGE =
  'This merge can no longer be undone: the entity it merged into has since been merged into another one. Undo that merge first.';

/**
 * Turns a failed merge, undo or "not the same" call into the sentence the UI shows: the two merge-specific refusals get their own copy, anything else the graph's usual message.
 *
 * @stability experimental
 */
export function mergeErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof KvoxApiError) {
    if (err.reason === 'type_mismatch') return MERGE_TYPE_MISMATCH_MESSAGE;
    if (err.reason === 'revert_conflict') return MERGE_REVERT_CONFLICT_MESSAGE;
  }
  return graphErrorMessage(err, fallback);
}

/**
 * What {@link useEntityMerges} returns.
 *
 * @stability experimental
 */
export interface UseEntityMergesResult {
  /** The merges into the entity, newest first; empty until loaded or when it failed. */
  data: EntityMergeRow[];
  /** The list is loading. */
  isLoading: boolean;
  /** A message when loading failed, else `null`. */
  error: string | null;
  /** Reads the list again. */
  refresh: () => Promise<void>;
}

/**
 * Loads the entities merged INTO `id`. Does nothing while `id` is undefined.
 *
 * @stability experimental
 */
export function useEntityMerges(id: string | undefined): UseEntityMergesResult {
  const host = useKvoxHost();
  const isMounted = useIsMounted();
  const nextController = useAbortControllers();
  const [data, setData] = useState<EntityMergeRow[]>([]);
  const [isLoading, setIsLoading] = useState(Boolean(id));
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    const controller = nextController();
    try {
      const rows = await listEntityMerges(host, id, controller.signal);
      if (!isMounted() || controller.signal.aborted) return;
      setData(rows);
      setError(null);
    } catch (err) {
      if (!isMounted() || isAbortError(err) || controller.signal.aborted) return;
      setError(graphErrorMessage(err, 'Could not load the merged entities'));
    } finally {
      if (isMounted() && !controller.signal.aborted) setIsLoading(false);
    }
  }, [host, id, isMounted, nextController]);

  useEffect(() => {
    setData([]);
    setError(null);
    setIsLoading(Boolean(id));
    void load();
  }, [id, load]);

  return { data, isLoading, error, refresh: load };
}

/**
 * What {@link useEntityMergeActions} returns.
 *
 * @stability experimental
 */
export interface UseEntityMergeActionsResult {
  /** Merges `mergedId` INTO `intoId`; `null` when it failed (see `error`). */
  merge: (mergedId: string, intoId: string) => Promise<MergeEntityResult | null>;
  /** Undoes a merge; `null` when it failed (see `error`). */
  reverse: (mergeId: string) => Promise<ReverseMergeResult | null>;
  /** Records that two entities are not the same; `null` when it failed (see `error`). */
  markDistinct: (aId: string, bId: string) => Promise<DistinctPairResult | null>;
  /** A call is in flight. */
  isSaving: boolean;
  /** The last failure's message, or `null`. Cleared when a call starts. */
  error: string | null;
  /** Clears `error`. */
  clearError: () => void;
}

/**
 * The merge mutations: merge, undo, "not the same".
 *
 * @stability experimental
 */
export function useEntityMergeActions(): UseEntityMergeActionsResult {
  const host = useKvoxHost();
  const isMounted = useIsMounted();
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async <T,>(call: () => Promise<T>, fallback: string): Promise<T | null> => {
      setIsSaving(true);
      setError(null);
      try {
        return await call();
      } catch (err) {
        if (isMounted()) setError(mergeErrorMessage(err, fallback));
        return null;
      } finally {
        if (isMounted()) setIsSaving(false);
      }
    },
    [isMounted],
  );

  const merge = useCallback(
    (mergedId: string, intoId: string) => run(() => mergeEntity(host, mergedId, intoId), 'Could not merge these entities'),
    [host, run],
  );
  const reverse = useCallback(
    (mergeId: string) => run(() => reverseMerge(host, mergeId), 'Could not undo this merge'),
    [host, run],
  );
  const markDistinct = useCallback(
    (aId: string, bId: string) => run(() => recordDistinctPair(host, aId, bId), 'Could not save this'),
    [host, run],
  );
  const clearError = useCallback(() => setError(null), []);

  return { merge, reverse, markDistinct, isSaving, error, clearError };
}
