/**
 * This deployment's client-facing notification capabilities, read from the API.
 *
 * Issue #227, epic #215. Deliberately a plain fetch hook in the shape of
 * `useNotificationEvents` — same `isMounted` discipline, same "error is a
 * string the page renders" contract, same "not cached across mounts" choice —
 * because that is all this is: one GET of a small, per-deployment capability
 * projection.
 *
 * WHY A DEDICATED HOOK RATHER THAN INLINING `useState`/`useEffect` ON THE PAGE
 * -----------------------------------------------------------------------------
 * `UserNotificationsPage` already fetches one adjacent thing this way
 * (`useNotificationEvents`), and this config read has the exact same shape —
 * fetch on mount, loading/error/data, no params, no cache. Mirroring that
 * pattern here keeps the page's two independent fetches symmetrical instead of
 * one being a hook and the other a hand-rolled effect for no reason other than
 * which issue happened to add it.
 *
 * WHY THE DEFAULT MATTERS WHILE LOADING
 * -----------------------------------------------------------------------------
 * `useNotificationCapability`'s own `adminDisabled` option already defaults to
 * `false` ("not disabled") for exactly this reason: this hook's `config` is
 * `null` until the first read resolves, and the caller must not treat that as
 * "disabled". `!config?.browserEnabled` would get this backwards — it reads
 * `true` (disabled) during the loading window, which is the one thing the
 * issue this hook exists for says must not happen: it would flicker the
 * "Allow notifications" button (or the admin-disabled banner) in and out on
 * every page load. The correct read is `config ? !config.browserEnabled :
 * false`, or equivalently `config?.browserEnabled === false` — see the call
 * site in `pages/UserNotificationsPage.tsx`.
 */

import { useCallback, useEffect, useState } from 'react';
import { ApiError, getNotificationConfig } from '../services/api';
import type { NotificationConfigResponse } from '../types';
import { useIsMounted } from './useIsMounted';

interface UseNotificationConfigReturn {
  /**
   * `null` until the first read resolves — NOT the same as "browser
   * notifications disabled". See the file header: callers must treat a `null`
   * config as "we do not know yet", never as `adminDisabled: true`.
   */
  config: NotificationConfigResponse | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useNotificationConfig(): UseNotificationConfigReturn {
  const [config, setConfig] = useState<NotificationConfigResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Every `setState` past an `await` is guarded: a request that settles after
  // the component is gone must not schedule an update on it. Same rule as the
  // other fetch hooks in this directory.
  const isMounted = useIsMounted();

  const fetchConfig = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const data = await getNotificationConfig();
      if (isMounted()) setConfig(data);
    } catch (err) {
      if (isMounted()) {
        setError(
          err instanceof ApiError ? err.message : 'Failed to load notification config',
        );
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    void fetchConfig();
  }, [fetchConfig]);

  return { config, isLoading, error, refresh: fetchConfig };
}
