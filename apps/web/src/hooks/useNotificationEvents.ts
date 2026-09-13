/**
 * The notification event registry, read from the API.
 *
 * Issue #126, epic #109. Deliberately a plain fetch hook in the shape of
 * `useEmailSettings` / `useSystemSettings` — same `isMounted` discipline, same
 * "error is a string the page renders" contract — because that is all this is:
 * one GET of a static, per-deployment list.
 *
 * WHY THIS IS FETCHED AT ALL, RATHER THAN IMPORTED FROM A CONSTANT
 * ----------------------------------------------------------------
 * The registry lives once, in `apps/api/src/notifications/notification-events.ts`,
 * and the web app reads the server's answer instead of keeping a copy. Two
 * things follow, and both are the point:
 *
 *   1. An event added to the API registry appears on `/settings/notifications`
 *      with NO web change — epic #109's promise that a notification costs one
 *      registry entry.
 *   2. `mandatory` — a security flag — has exactly one declaration. A mirrored
 *      copy is a second place for it to be wrong, and the wrong direction is an
 *      enabled toggle on a security alert.
 *
 * The cost is a second request on this one page and a real loading state, which
 * is why the page renders a spinner rather than an empty matrix: an empty
 * matrix is indistinguishable from "this app notifies you about nothing".
 *
 * NOT CACHED ACROSS MOUNTS, on purpose. The list is small and this page is
 * rarely visited; a module-level cache would be one more thing that can serve a
 * stale `mandatory` after a deploy, for a saving nobody can perceive.
 */

import { useCallback, useEffect, useState } from 'react';
import { ApiError, getNotificationEvents } from '../services/api';
import type { NotificationEventDef } from '../types';
import { useIsMounted } from './useIsMounted';

interface UseNotificationEventsReturn {
  /**
   * The registry, IN SERVER ORDER — that order is meaningful (it is the order
   * the preferences matrix renders) and is never re-sorted here.
   *
   * `null` until the first read resolves, which is NOT the same as `[]`. An
   * empty array is a real answer ("this deployment declares no events") and the
   * page says so; `null` means "we do not know yet" and the page shows a
   * spinner. Collapsing the two would render "nothing to configure" during
   * every load.
   */
  events: NotificationEventDef[] | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useNotificationEvents(): UseNotificationEventsReturn {
  const [events, setEvents] = useState<NotificationEventDef[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Every `setState` past an `await` is guarded: a request that settles after
  // the component is gone must not schedule an update on it. Same rule as the
  // other fetch hooks in this directory.
  const isMounted = useIsMounted();

  const fetchEvents = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const data = await getNotificationEvents();
      if (isMounted()) setEvents(data);
    } catch (err) {
      if (isMounted()) {
        setError(
          err instanceof ApiError ? err.message : 'Failed to load notification events',
        );
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    void fetchEvents();
  }, [fetchEvents]);

  return { events, isLoading, error, refresh: fetchEvents };
}
