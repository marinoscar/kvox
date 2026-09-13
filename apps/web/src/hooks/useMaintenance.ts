/**
 * The two maintenance hooks — issue #258, epic #254.
 *
 * They sit in one file because they are two views of one feature, but they read
 * from OPPOSITE ENDS of it and share no state:
 *
 *   * `useMaintenanceBlock()` reads the module store in `services/maintenance.ts`
 *     — what the API told a caller it had just refused. Its subscriber is
 *     `MaintenanceGate`, and it never makes a request of its own: by definition
 *     the viewer is being blocked, so asking the API anything is the one thing
 *     that cannot work.
 *
 *   * `useMaintenance()` reads `GET /api/admin/maintenance` — the operator's
 *     view, including every contributing layer. Its consumers are the admin page
 *     and the banner, both of which are rendered by somebody who is NOT blocked.
 *
 * The second is shaped after `useEmailSettings` (#124): same `isMounted`
 * discipline, same "an error is a string the page renders" contract, same
 * `save` that resolves a boolean instead of throwing, because every caller is a
 * click handler that needs to branch rather than a place to handle an exception
 * already captured for rendering.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { ApiError, getMaintenanceStatus, updateMaintenance } from '../services/api';
import {
  clearMaintenanceBlock,
  getMaintenanceBlock,
  subscribeToMaintenanceBlock,
} from '../services/maintenance';
import type { MaintenanceBlock } from '../services/maintenance';
import type { MaintenanceStatus, UpdateMaintenanceInput } from '../types';
import { useIsMounted } from './useIsMounted';

/**
 * How often `MaintenanceBanner` re-asks whether the window is still open.
 *
 * A POLL IS NECESSARY HERE AND NOWHERE ELSE IN THIS FEATURE. Everybody else
 * learns about a window by being refused, which arrives by itself; an
 * administrator who is being let THROUGH one is refused nothing and would
 * otherwise never find out — including the administrator who opened the window
 * on another tab, or a colleague who did. Sixty seconds is well inside the
 * period over which forgetting matters, and it is one cheap request a minute on
 * a page only `system_settings:read` holders render at all.
 */
export const MAINTENANCE_POLL_INTERVAL_MS = 60_000;

export interface UseMaintenanceBlockReturn {
  /** What the API said when it refused a request, or `null` when nothing is blocked. */
  block: MaintenanceBlock | null;
  /** Forget the block, so the application renders again and its pages re-fetch. */
  clear: () => void;
}

/**
 * Subscribe to the maintenance block recorded centrally by `services/api.ts`.
 *
 * `useSyncExternalStore` rather than `useState` + an effect: the store is
 * written from a `fetch` handler outside React's knowledge, and this is the
 * supported way to read one without tearing under concurrent rendering. It is
 * also why `getMaintenanceBlock` must return a stable reference between
 * changes — see its own comment.
 */
export function useMaintenanceBlock(): UseMaintenanceBlockReturn {
  const block = useSyncExternalStore(subscribeToMaintenanceBlock, getMaintenanceBlock);

  return {
    block,
    clear: clearMaintenanceBlock,
  };
}

export interface UseMaintenanceOptions {
  /**
   * Whether to talk to the API at all. Default `true`.
   *
   * `false` is for a caller that already knows the request would 403 — the
   * banner, mounted in the app shell for EVERY user, of whom most hold no
   * `system_settings:read`. Rendering nothing but still firing the request
   * would buy a 403 per minute per viewer and fill the audit-adjacent logs of
   * every deployment with failures that were predictable from the session.
   */
  enabled?: boolean;
  /** Re-fetch on this interval, in ms. `0` (the default) never polls. */
  pollIntervalMs?: number;
}

export interface UseMaintenanceReturn {
  /** The effective state and its layers, or `null` before the first successful load. */
  status: MaintenanceStatus | null;
  isLoading: boolean;
  /** Failure to LOAD. Distinct from `saveError`: one means "nothing to show", the other "your change did not stick". */
  loadError: string | null;
  isSaving: boolean;
  saveError: string | null;
  /** Resolves `true` when the write landed, `false` when it did not — never throws. */
  save: (input: UpdateMaintenanceInput) => Promise<boolean>;
  refresh: () => Promise<void>;
}

export function useMaintenance(options: UseMaintenanceOptions = {}): UseMaintenanceReturn {
  const { enabled = true, pollIntervalMs = 0 } = options;

  const [status, setStatus] = useState<MaintenanceStatus | null>(null);
  // Starts `false` when disabled: a hook that will never fetch must not report
  // a load that is permanently in progress, or the banner would sit forever in
  // a state its consumer reads as "not known yet".
  const [isLoading, setIsLoading] = useState(enabled);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Every `setState` past an `await` is guarded, the same rule
  // `useEmailSettings` and `useSystemSettings` follow: a request that settles
  // after the component is gone must not schedule an update on it. Only the
  // state write is skipped; what these functions return is unchanged.
  const isMounted = useIsMounted();

  const fetchStatus = useCallback(async () => {
    if (!enabled) return;

    try {
      setIsLoading(true);
      setLoadError(null);
      const data = await getMaintenanceStatus();
      if (isMounted()) setStatus(data);
    } catch (err) {
      if (isMounted()) {
        // 403 is named explicitly because it is the one failure whose remedy is
        // a permission rather than a fix — the same treatment
        // `useEmailSettings` gives it.
        if (err instanceof ApiError && err.status === 403) {
          setLoadError('You do not have permission to view maintenance mode');
        } else {
          setLoadError(
            err instanceof ApiError ? err.message : 'Failed to load maintenance mode',
          );
        }
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [enabled, isMounted]);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    if (!enabled || pollIntervalMs <= 0) return;

    const timer = setInterval(() => {
      void fetchStatus();
    }, pollIntervalMs);

    return () => clearInterval(timer);
  }, [enabled, pollIntervalMs, fetchStatus]);

  /**
   * Write the window, and adopt whatever the server says the state now is.
   *
   * THE RESPONSE IS THE NEW BASELINE, NEVER THE INPUT, and here that is more
   * than the usual hygiene it is in `useEmailSettings`. An environment override
   * outranks anything this writes, so `save({ enabled: false })` can correctly
   * come back `enabled: true, source: 'env'` — and a page that trusted its own
   * payload would then tell the operator the window is closed while the
   * application is still refusing every request. `source` and `layers` are
   * exactly what that operator has to see, and only the response carries them.
   */
  const save = useCallback(
    async (input: UpdateMaintenanceInput): Promise<boolean> => {
      try {
        setIsSaving(true);
        setSaveError(null);
        const data = await updateMaintenance(input);
        if (isMounted()) setStatus(data);

        // The one place in the app that KNOWS a window closed, so the one place
        // entitled to drop a recorded block. Keyed on the server's effective
        // answer rather than on `input.enabled`: with an env override forcing
        // the window open, the save succeeded and the application is still out
        // of service, and clearing the gate then would show this operator an
        // application that immediately blocks them again.
        if (!data.enabled) {
          clearMaintenanceBlock();
        }

        return true;
      } catch (err) {
        if (isMounted()) {
          setSaveError(
            err instanceof ApiError ? err.message : 'Failed to update maintenance mode',
          );
        }
        return false;
      } finally {
        if (isMounted()) setIsSaving(false);
      }
    },
    [isMounted],
  );

  return {
    status,
    isLoading,
    loadError,
    isSaving,
    saveError,
    save,
    refresh: fetchStatus,
  };
}
