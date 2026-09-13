/**
 * The broadcast list and the four writes (issue #325, epic #319).
 *
 * Two exports in one file, in the shape `hooks/useJobs.ts` establishes for an
 * admin resource page: a list hook whose `refresh` does NOT raise the loading
 * flag, and an actions hook with one in-flight flag and one error string. What
 * they share is the contract — every function RESOLVES rather than throws, and
 * a failure is a STRING the page renders — because every caller is a click
 * handler that needs to branch, not a place to handle an exception that has
 * already been captured for display.
 *
 * =============================================================================
 * `useVisiblePolling` — RE-EXPORTED, NOT DEFINED HERE
 * =============================================================================
 *
 * Same arrangement as `useJobs.ts` and `useWorkerNodes.ts`: there is exactly
 * one implementation, in `hooks/useVisiblePolling.ts`, and it is re-exported
 * from here so `BroadcastsPage` takes its polling from the hook module it
 * already depends on — which is also what keeps a page test that mocks
 * `hooks/useBroadcasts` in control of the poll.
 *
 * =============================================================================
 * WHY THIS PAGE POLLS LESS EAGERLY THAN JOBS
 * =============================================================================
 *
 * A queue is never at rest; a broadcast list usually is. Most of the time every
 * row is `sent`, `canceled` or `failed` — terminal states that cannot change
 * with nobody touching them — and polling those is a request per ten seconds
 * for an answer that is known in advance. So `BroadcastsPage` passes `0` (which
 * `useVisiblePolling` treats as "off") unless a row is actually `scheduled` or
 * `sending`, and the interval below is what it passes when one is.
 */

import { useCallback, useRef, useState } from 'react';
import { ApiError } from '../services/api';
import { useVisiblePolling } from './useVisiblePolling';
import {
  cancelBroadcast,
  createBroadcast,
  deleteBroadcast,
  getBroadcasts,
  sendTestBroadcast,
} from '../services/broadcasts';
import type {
  Broadcast,
  BroadcastCreateResult,
  BroadcastListParams,
  BroadcastTestResult,
  CreateBroadcastRequest,
} from '../services/broadcasts';
import { useIsMounted } from './useIsMounted';

// See the file header: one implementation, in `hooks/useVisiblePolling.ts`.
export { useVisiblePolling };

/**
 * How often the broadcasts page re-asks while something is in flight.
 *
 * The same ten seconds the jobs page uses, and for the same reason: the thing
 * being watched is `recipientsDispatched` climbing through an audience in
 * chunks, which a faster poll does not observe any better. Unlike Jobs, this
 * interval is only ever REACHED while a row is `scheduled` or `sending` — see
 * the file header.
 */
export const BROADCASTS_POLL_INTERVAL_MS = 10_000;

/** Turn any thrown value into the sentence the page will render. */
function messageFor(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    // Named explicitly because their remedies are not a retry — the same
    // treatment `useJobs` gives 403.
    if (err.status === 403) return 'You do not have permission to manage broadcasts';
    // 409 is this surface's characteristic refusal: a cancel that lost the race
    // with the fan-out, or a delete of something already sending. The API's own
    // message says which, so it is passed through rather than replaced.
    return err.message;
  }
  return fallback;
}

// =============================================================================
// The list
// =============================================================================

export interface UseBroadcastsResult {
  broadcasts: Broadcast[];
  total: number;
  isLoading: boolean;
  error: string | null;
  /** Run a query, and remember it so `refresh` can repeat it. */
  fetchBroadcasts: (params?: BroadcastListParams) => Promise<void>;
  /** Re-run the last query. What the poll calls, and what a write calls after it lands. */
  refresh: () => Promise<void>;
}

export function useBroadcasts(): UseBroadcastsResult {
  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Every `setState` past an `await` is guarded: a request that settles after
  // the component is gone must not schedule an update on it.
  const isMounted = useIsMounted();

  /**
   * The last query, so a poll repeats the CURRENT view rather than an
   * unfiltered one. A ref and not state: a re-render on every query would be a
   * re-render that changes nothing on screen, and the value is only ever read
   * from inside a callback.
   */
  const lastParams = useRef<BroadcastListParams>({});

  const runQuery = useCallback(
    async (params: BroadcastListParams, showLoading: boolean) => {
      // A POLL DOES NOT RAISE THE LOADING FLAG. The rows stay on screen and the
      // table keeps its scroll offset, its expansion and its focus — which
      // matters more here than on the jobs page, because the thing an operator
      // is watching during a send is one row's progress counter.
      if (showLoading) setIsLoading(true);
      setError(null);
      try {
        const response = await getBroadcasts(params);
        if (isMounted()) {
          setBroadcasts(response.items);
          setTotal(response.total);
        }
      } catch (err) {
        if (isMounted()) {
          setError(messageFor(err, 'Failed to load broadcasts'));
          // Cleared, not left standing: rows from the previous successful query
          // under an error banner read as the current state of the list.
          setBroadcasts([]);
          setTotal(0);
        }
      } finally {
        if (isMounted() && showLoading) setIsLoading(false);
      }
    },
    [isMounted],
  );

  const fetchBroadcasts = useCallback(
    async (params: BroadcastListParams = {}) => {
      lastParams.current = params;
      await runQuery(params, true);
    },
    [runQuery],
  );

  const refresh = useCallback(async () => {
    await runQuery(lastParams.current, false);
  }, [runQuery]);

  return { broadcasts, total, isLoading, error, fetchBroadcasts, refresh };
}

// =============================================================================
// The writes
// =============================================================================

export interface UseBroadcastActionsResult {
  /** True while any one of the four writes is in flight. */
  isWorking: boolean;
  /** The last failure, or `null`. Cleared when a write starts. */
  error: string | null;
  clearError: () => void;
  /** The created row plus its non-fatal warnings, or `null` when it failed. */
  create: (body: CreateBroadcastRequest) => Promise<BroadcastCreateResult | null>;
  /** `true` when the write landed. Never throws. */
  cancel: (id: string) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  /** What was dispatched to the caller themselves, or `null` when it failed. */
  sendTest: (body: CreateBroadcastRequest) => Promise<BroadcastTestResult | null>;
}

/**
 * The four writes, sharing one in-flight flag and one error.
 *
 * ONE FLAG FOR ALL FOUR, as `useJobActions` does: they all mutate the same
 * list, the page re-reads it after any of them, and a second write started
 * while the first is landing would report its result over the top of the
 * first's. Disabling the whole action set for the duration is the honest
 * reading of "these are not independent".
 *
 * `sendTest` is in this set even though it mutates NOTHING — it stores no row
 * and queues no job. It shares the flag anyway because it shares the composer:
 * a test send and a real send are the same form, and letting the admin submit
 * for real while a test of the same composition is in flight is how you get two
 * conflicting snackbars over one dialog.
 */
export function useBroadcastActions(onChanged?: () => void): UseBroadcastActionsResult {
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  // Held in a ref for the same reason `useVisiblePolling` holds its callback:
  // the page passes a fresh closure over the current query on every render, and
  // depending on it would rebuild all four callbacks each time.
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  const run = useCallback(
    async <T,>(
      operation: () => Promise<T>,
      fallback: string,
      { notifiesChange = true }: { notifiesChange?: boolean } = {},
    ): Promise<T | null> => {
      setIsWorking(true);
      setError(null);
      try {
        const result = await operation();
        // The list changed, so whatever is on screen is now stale. Fired AFTER
        // the write resolves and never in parallel with it: a refresh racing
        // its own mutation is how a canceled broadcast flickers back to
        // `scheduled` for one frame.
        //
        // `notifiesChange: false` is the test send's case — it writes no row,
        // so refetching the list would be a request that can only ever return
        // what is already on screen.
        if (notifiesChange) onChangedRef.current?.();
        return result;
      } catch (err) {
        if (isMounted()) setError(messageFor(err, fallback));
        return null;
      } finally {
        if (isMounted()) setIsWorking(false);
      }
    },
    [isMounted],
  );

  const create = useCallback(
    (body: CreateBroadcastRequest) =>
      run(() => createBroadcast(body), 'Failed to create broadcast'),
    [run],
  );

  const cancel = useCallback(
    async (id: string) =>
      (await run(() => cancelBroadcast(id), 'Failed to cancel broadcast')) !== null,
    [run],
  );

  const remove = useCallback(
    async (id: string) =>
      (await run(async () => {
        await deleteBroadcast(id);
        // `deleteBroadcast` resolves `undefined` (the endpoint answers 204),
        // and `run` reports failure as `null` — so a literal is returned to
        // keep "succeeded" distinguishable from "failed".
        return true;
      }, 'Failed to delete broadcast')) !== null,
    [run],
  );

  const sendTest = useCallback(
    (body: CreateBroadcastRequest) =>
      run(() => sendTestBroadcast(body), 'Failed to send the test notification', {
        notifiesChange: false,
      }),
    [run],
  );

  const clearError = useCallback(() => setError(null), []);

  return { isWorking, error, clearError, create, cancel, remove, sendTest };
}
