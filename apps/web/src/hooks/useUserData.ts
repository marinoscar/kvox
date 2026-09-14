/**
 * Read what the signed-in user has stored, and ask for some of it to be
 * deleted — issue #80.
 *
 * Shaped after `hooks/useAiCredential.ts`: the same `isMounted` discipline
 * (every `setState` past an `await` is guarded), the same "an error is a STRING
 * THE PAGE RENDERS, never a rejected promise" contract via `messageFor`, and
 * the same split into per-action flag groups so a destructive action does not
 * spin the control that merely loads.
 *
 * THERE IS NO PERMISSION TO CHECK. The API gates both routes on `@Auth()` with
 * no permission string, because the resource is the caller's own data scoped by
 * `userId` in the query itself — the identical posture `/api/ai-credentials`
 * and `/api/user-settings` take. So nothing here consults `usePermissions`, and
 * a page built on this hook must not either.
 *
 * =============================================================================
 * THE POLL EXISTS BECAUSE THE DELETION IS A QUEUE JOB
 * =============================================================================
 *
 * `POST /api/user-data/deletions` answers **202**: it enqueues work and
 * returns. Nothing pushes progress to this tab, so the only way the counts on
 * screen ever become true again is to ask. While `summary.activeDeletion` is
 * non-null this hook re-reads the summary every `POLL_INTERVAL_MS`, and stops
 * the instant it clears.
 *
 * ⚠ THE INTERVAL IS DRIVEN BY AN EFFECT KEYED ON WHETHER A DELETION IS ACTIVE,
 * not started imperatively inside `requestDeletion`. Starting it there would
 * mean a user who RELOADS mid-run (or opens a second tab) gets a page that
 * shows "deletion in progress" and then never updates, because the code that
 * would have started the timer ran in a tab that is gone. Deriving it from
 * state makes the mounted-into-an-active-deletion case and the
 * just-pressed-the-button case literally the same path.
 *
 * The effect's cleanup clears the interval on unmount AND on every transition
 * of that flag, so there is exactly one timer at a time and none after the
 * component goes away. The polling tick calls the loading-silent
 * `readSummary`, never `refresh` — a poll that flipped `isLoading` back to
 * `true` every five seconds would replace the whole page with a spinner on a
 * repeating cycle, which is the specific bug `isLoading` guarding the first
 * paint invites.
 *
 * ⚠ DELIBERATELY NOT `useVisiblePolling`. That hook stops polling in a hidden
 * tab, which is right for an admin dashboard left open overnight against a
 * database other work is competing for. Here the poll is bounded by the
 * lifetime of one short background job the user just started and is waiting
 * on, and pausing it would mean a user who switches tabs while a deletion runs
 * comes back to stale counts and a still-disabled page for up to a full
 * interval. The tradeoff runs the other way at this scale.
 */

import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '../services/api';
import { createUserDataDeletion, getUserDataSummary } from '../services/userData';
import type { UserDataScope, UserDataSummary } from '../services/userData';
import { useIsMounted } from './useIsMounted';

/**
 * How often the summary is re-read while a deletion is running.
 *
 * Five seconds: the work is a queue job measured in seconds to a few minutes,
 * and this is one request per user per tick against a summary query, not a
 * fleet dashboard. Exported so a test can assert the interval it advances a
 * fake clock by rather than re-typing the number.
 */
export const USER_DATA_POLL_INTERVAL_MS = 5000;

function messageFor(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    return err.message || fallback;
  }
  return fallback;
}

export interface UseUserDataReturn {
  /** `null` until the first read lands, or when it failed. */
  summary: UserDataSummary | null;
  isLoading: boolean;
  /** Failure to LOAD — "nothing to show", as distinct from "your deletion did not start". */
  loadError: string | null;

  isDeleting: boolean;
  /** The last failed deletion request, including the API's own 409 message. */
  deleteError: string | null;
  /** Resolves `true` when the request was accepted, `false` when it was not — never throws. */
  requestDeletion: (scope: UserDataScope) => Promise<boolean>;
  clearDeleteError: () => void;

  /** True while the server reports a deletion job in flight for this user. */
  isDeletionActive: boolean;

  refresh: () => Promise<void>;
}

export function useUserData(): UseUserDataReturn {
  const [summary, setSummary] = useState<UserDataSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const isMounted = useIsMounted();

  /**
   * Read the summary WITHOUT touching `isLoading`.
   *
   * This is the one the poll calls, and the separation is the whole reason it
   * exists: `isLoading` gates the page's first paint (`if (isLoading) return
   * <LoadingSpinner />`), so a background refresh that set it would unmount the
   * entire page — dialogs, typed confirmations and all — on every tick.
   */
  const readSummary = useCallback(async () => {
    try {
      const next = await getUserDataSummary();
      if (isMounted()) {
        setSummary(next);
        setLoadError(null);
      }
    } catch (err) {
      if (isMounted()) {
        setLoadError(messageFor(err, 'Failed to load what is stored for your account'));
      }
    }
  }, [isMounted]);

  /** The visible read: the first load, and anything the user asked for by hand. */
  const refresh = useCallback(async () => {
    if (isMounted()) setIsLoading(true);
    await readSummary();
    if (isMounted()) setIsLoading(false);
  }, [isMounted, readSummary]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const isDeletionActive = !!summary?.activeDeletion;

  // The poll. Keyed on `isDeletionActive` so it is started by STATE rather than
  // by the button press — see the file header for why that distinction matters
  // to a user who reloads mid-run. Cleanup runs on unmount and on every change
  // of the flag, so there is never more than one timer and never one left over.
  useEffect(() => {
    if (!isDeletionActive) return;

    const timer = setInterval(() => {
      void readSummary();
    }, USER_DATA_POLL_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [isDeletionActive, readSummary]);

  /**
   * Ask for a scope to be deleted, then adopt the server's account of what is
   * now running.
   *
   * THE RESPONSE IS THE NEW BASELINE. The 202 body is the same row
   * `summary.activeDeletion` carries, so it is patched straight in: that flips
   * `isDeletionActive` in the same render the request settles, which disables
   * every button and starts the poll without waiting a round trip to learn a
   * fact the server just told us.
   *
   * ⚠ NEVER THROWS. A 409 ("a deletion is already running") is an ordinary,
   * reachable outcome — two tabs, or a reload — and the API's own message says
   * so far better than a generic string would, so it is surfaced verbatim for
   * the page to render. The summary is re-read either way: on a 409 the
   * in-flight deletion this tab did not know about is exactly what the caller
   * needs to see.
   */
  const requestDeletion = useCallback(
    async (scope: UserDataScope): Promise<boolean> => {
      try {
        setIsDeleting(true);
        setDeleteError(null);
        const deletion = await createUserDataDeletion(scope);
        if (isMounted()) {
          setSummary((current) => (current ? { ...current, activeDeletion: deletion } : current));
        }
        // Re-read regardless: the counts may already have started moving, and
        // a summary that was `null` (a failed first load) has no object above
        // to patch and would otherwise never learn a deletion had begun.
        void readSummary();
        return true;
      } catch (err) {
        if (isMounted()) {
          setDeleteError(messageFor(err, 'Failed to start the deletion'));
          void readSummary();
        }
        return false;
      } finally {
        if (isMounted()) setIsDeleting(false);
      }
    },
    [isMounted, readSummary],
  );

  const clearDeleteError = useCallback(() => setDeleteError(null), []);

  return {
    summary,
    isLoading,
    loadError,
    isDeleting,
    deleteError,
    requestDeletion,
    clearDeleteError,
    isDeletionActive,
    refresh,
  };
}
