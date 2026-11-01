/**
 * `useGraphSelf` — who the user is in their own graph (#778): the chosen Person
 * (resolved by the API: merges followed, a stale choice reads as none) and, while
 * none is chosen, Persons matching their profile name.
 *
 * READ plus the two writes the settings control needs. The choice itself lives in
 * the `graph` user-settings namespace (`useGraphPreferences`, `self.entityId`);
 * `choose` is that write followed by a re-read, and `createAndChoose` adds a
 * Person by hand first. Nothing is ever chosen without a call here.
 *
 * Resolves rather than throws, like every graph hook: a failure is a string.
 */

import { useCallback, useEffect, useState } from 'react';

import { createSelfPerson, getGraphSelf, type GraphSelf } from '../clients/graph.js';
import { graphErrorMessage, isAbortError, useAbortControllers } from './graphHookUtils.js';
import { useIsMounted, useKvoxHost } from '../../../core/headless/index.js';

/**
 * What {@link useGraphSelf} returns.
 *
 * @stability experimental
 */
export interface UseGraphSelfResult {
  /** The latest answer, or `null` until the first read settles. */
  data: GraphSelf | null;
  /** The first read has not settled yet. */
  isLoading: boolean;
  /** A message when the last read or write failed, else `null`. */
  error: string | null;
  /** Re-read without the loading state. */
  refresh: () => Promise<void>;
  /** Adds a Person to stand for the user and returns its id, or `null` on failure (see `error`). */
  create: (label: string) => Promise<string | null>;
}

/**
 * Reads who the user is in their graph.
 *
 * @param enabled - `false` issues no request (no `graph:read`).
 * @stability experimental
 */
export function useGraphSelf(enabled = true): UseGraphSelfResult {
  const host = useKvoxHost();
  const [data, setData] = useState<GraphSelf | null>(null);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();
  const nextController = useAbortControllers();

  const load = useCallback(
    async (showLoading: boolean) => {
      const controller = nextController();
      if (showLoading) setIsLoading(true);
      try {
        const next = await getGraphSelf(host, controller.signal);
        if (!isMounted() || controller.signal.aborted) return;
        setData(next);
        setError(null);
      } catch (err) {
        if (!isMounted() || isAbortError(err) || controller.signal.aborted) return;
        setError(graphErrorMessage(err, 'Failed to load who you are in the graph'));
      } finally {
        if (isMounted() && !controller.signal.aborted && showLoading) setIsLoading(false);
      }
    },
    [host, isMounted, nextController],
  );

  useEffect(() => {
    if (enabled) void load(true);
    else setIsLoading(false);
  }, [enabled, load]);

  const create = useCallback(
    async (label: string): Promise<string | null> => {
      try {
        const person = await createSelfPerson(host, label);
        return person.id;
      } catch (err) {
        if (isMounted()) setError(graphErrorMessage(err, 'Could not add a Person for you'));
        return null;
      }
    },
    [host, isMounted],
  );

  const refresh = useCallback(() => load(false), [load]);
  return { data, isLoading, error, refresh, create };
}
