/**
 * Read what of the signed-in user's library is semantically searchable, and ask
 * for the rest of it to be indexed — issue #191, epic #165.
 *
 * Shaped after `hooks/useUserData.ts`: the same `isMounted` discipline (every
 * `setState` past an `await` is guarded), the same "an error is a STRING THE
 * PAGE RENDERS, never a rejected promise" contract, and the same split into
 * per-action flag groups so the indexing button does not spin the control that
 * merely loads.
 *
 * THERE IS NO PERMISSION TO CHECK. The API gates both routes on `@Auth()` with
 * no permission string, because the resource is the caller's own content and
 * the caller's own vendor account, scoped by `ownerId` in the query itself. So
 * nothing here consults `usePermissions`, and a page built on this hook must
 * not either.
 *
 * =============================================================================
 * THE POLL EXISTS BECAUSE INDEXING IS A QUEUE JOB, AND IT USES
 * `useVisiblePolling` WHERE THE DANGER ZONE DELIBERATELY DOES NOT
 * =============================================================================
 *
 * `POST /api/search/index` answers **202**: it enqueues up to two hundred jobs
 * and returns. Nothing pushes progress to this tab, so the only way the numbers
 * on screen become true again is to ask. While any document is `pending` this
 * hook re-reads the status every `SEARCH_INDEX_POLL_INTERVAL_MS` and stops the
 * instant nothing is.
 *
 * `useUserData` argues ITSELF out of `useVisiblePolling`, and the difference is
 * the shape of the work rather than a difference of opinion. A deletion is one
 * job the user is standing in front of, measured in seconds to a couple of
 * minutes; pausing it would mean coming back to stale counts for a full
 * interval. An index run is up to two hundred jobs against a remote provider
 * and can legitimately take many minutes — long enough that a tab left open on
 * a second monitor is exactly the overnight-dashboard case
 * `useVisiblePolling`'s own header does the arithmetic for. Its immediate
 * catch-up fetch on return is what makes the pause invisible.
 *
 * ⚠ THE INTERVAL IS DERIVED FROM STATE, not started imperatively inside
 * `requestIndex`. Starting it there would leave a user who RELOADS mid-run (or
 * opens a second tab) looking at a page that says "indexing" and never updates,
 * because the code that would have started the timer ran in a tab that is gone.
 * Deriving it makes the mounted-into-a-running-batch case and the
 * just-pressed-the-button case literally the same path.
 *
 * The tick calls the loading-silent `readStatus`, never `refresh`: a poll that
 * flipped `isLoading` back to `true` would replace the whole page with a
 * spinner on a repeating cycle.
 */

import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '../services/api';
import {
  getSearchIndexStatus,
  hasPendingIndexing,
  requestSearchIndex,
} from '../services/searchIndex';
import type { SearchIndexRequestResult, SearchIndexStatus } from '../services/searchIndex';
import { useIsMounted } from './useIsMounted';
import { useVisiblePolling } from './useVisiblePolling';

/**
 * How often the status is re-read while anything is pending.
 *
 * Five seconds. One request per user per tick against a two-query read, and the
 * thing being watched is a queue draining one document at a time — slower and
 * the counters visibly lag the work, faster and the page is asking about a
 * number that cannot have moved. Exported so a test asserts the interval it
 * advances a fake clock by rather than re-typing it.
 */
export const SEARCH_INDEX_POLL_INTERVAL_MS = 5000;

function messageFor(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    return err.message || fallback;
  }
  return fallback;
}

export interface UseSearchIndexReturn {
  /** `null` until the first read lands, or when it failed. */
  status: SearchIndexStatus | null;
  isLoading: boolean;
  /** Failure to LOAD — "nothing to show", as distinct from "indexing did not start". */
  loadError: string | null;

  isIndexing: boolean;
  /** The last refused request, including the API's own 409 message. */
  indexError: string | null;
  /** The 202 body of the last accepted request, for the "200 of 900 queued" line. */
  lastResult: SearchIndexRequestResult | null;
  /** Resolves `true` when the request was accepted, `false` when it was not — never throws. */
  requestIndex: () => Promise<boolean>;
  clearIndexError: () => void;

  /** True while the server reports documents queued or being indexed. */
  isRunning: boolean;

  refresh: () => Promise<void>;
}

export function useSearchIndex(): UseSearchIndexReturn {
  const [status, setStatus] = useState<SearchIndexStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isIndexing, setIsIndexing] = useState(false);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<SearchIndexRequestResult | null>(null);

  const isMounted = useIsMounted();

  /**
   * Read the status WITHOUT touching `isLoading`.
   *
   * This is the one the poll calls, and the separation is why it exists:
   * `isLoading` gates the page's first paint, so a background refresh that set
   * it would unmount the whole page on every tick.
   */
  const readStatus = useCallback(async () => {
    try {
      const next = await getSearchIndexStatus();
      if (isMounted()) {
        setStatus(next);
        setLoadError(null);
      }
    } catch (err) {
      if (isMounted()) {
        setLoadError(messageFor(err, 'Failed to load your indexing status'));
      }
    }
  }, [isMounted]);

  /** The visible read: the first load, and anything the user asked for by hand. */
  const refresh = useCallback(async () => {
    if (isMounted()) setIsLoading(true);
    await readStatus();
    if (isMounted()) setIsLoading(false);
  }, [isMounted, readStatus]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const isRunning = hasPendingIndexing(status);

  // `0` DISABLES THE POLL ENTIRELY — see `useVisiblePolling`, which treats a
  // non-positive interval as "do not poll". So the page asks for nothing at all
  // once the queue has drained, which is the overwhelmingly common state.
  useVisiblePolling(
    () => void readStatus(),
    isRunning ? SEARCH_INDEX_POLL_INTERVAL_MS : 0,
  );

  /**
   * Ask for the library to be indexed.
   *
   * ⚠ NEVER THROWS. A 409 ("you have saved no key", "this deployment has no AI
   * provider") is an ordinary, reachable outcome — a key removed in another
   * tab, an administrator switching AI off — and the API's own message says so
   * far better than a generic string, so it is surfaced verbatim.
   *
   * The status is re-read either way: on success the counters have started
   * moving, and on a refusal the reason the button should have been disabled is
   * exactly what the caller needs to see.
   */
  const requestIndex = useCallback(async (): Promise<boolean> => {
    try {
      setIsIndexing(true);
      setIndexError(null);
      const result = await requestSearchIndex();
      if (isMounted()) setLastResult(result);
      void readStatus();
      return true;
    } catch (err) {
      if (isMounted()) {
        setIndexError(messageFor(err, 'Failed to start indexing'));
        void readStatus();
      }
      return false;
    } finally {
      if (isMounted()) setIsIndexing(false);
    }
  }, [isMounted, readStatus]);

  const clearIndexError = useCallback(() => setIndexError(null), []);

  return {
    status,
    isLoading,
    loadError,
    isIndexing,
    indexError,
    lastResult,
    requestIndex,
    clearIndexError,
    isRunning,
    refresh,
  };
}
