/**
 * Load `GET /api/admin/about` for the About page — issue #126, epic #118.
 *
 * Shaped after the read half of `useMaintenance` (#258): same `isMounted`
 * discipline, same "an error is a string the page renders" contract, same
 * 403-named-explicitly rule. There is no write half — nothing on the About
 * page is editable, and "trigger an update from the browser" is out of scope
 * for the epic permanently (the CLI runs on the server as root).
 *
 * NO POLL, ON PURPOSE. `useMaintenance` polls because a window can be opened
 * from another tab and an administrator being let through one is refused
 * nothing. Nothing on this page changes until somebody deploys, and when they
 * do the operator is standing at the terminal that did it. So the page fetches
 * once and offers a manual Refresh; `refresh()` is that button, and it keeps
 * the last good answer on screen while the new one is in flight rather than
 * dropping the page back to a skeleton.
 */

import { useCallback, useEffect, useState } from 'react';
import { ApiError, getAbout } from '../services/api';
import type { AboutResponse } from '../types';
import { useIsMounted } from './useIsMounted';

export interface UseAboutReturn {
  /** The last successful answer, or `null` before the first one. */
  about: AboutResponse | null;
  /** True while any fetch — the first or a refresh — is in flight. */
  isLoading: boolean;
  /**
   * The most recent fetch failure, or `null`. With `about` still set, this is a
   * refresh that did not land and the page keeps showing the previous answer;
   * with `about` null, there is nothing to show but the error and a retry.
   */
  loadError: string | null;
  refresh: () => Promise<void>;
}

export function useAbout(): UseAboutReturn {
  const [about, setAbout] = useState<AboutResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Every `setState` past an `await` is guarded, the rule every fetching hook
  // in this app follows: a request that settles after the component is gone
  // must not schedule an update on it.
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    try {
      setIsLoading(true);
      setLoadError(null);
      const data = await getAbout();
      if (isMounted()) setAbout(data);
    } catch (err) {
      if (isMounted()) {
        // 403 is named explicitly because it is the one failure whose remedy is
        // a permission rather than a fix.
        if (err instanceof ApiError && err.status === 403) {
          setLoadError('You do not have permission to view this deployment’s details');
        } else {
          setLoadError(
            err instanceof ApiError ? err.message : 'Failed to load deployment details',
          );
        }
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { about, isLoading, loadError, refresh };
}
