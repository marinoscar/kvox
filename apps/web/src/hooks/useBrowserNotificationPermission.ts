/**
 * The browser's CURRENT notification permission, observed — never requested.
 *
 * Issue #126, epic #109. The preferences page has a `browser` column, and a
 * stored preference for it means nothing on its own: the browser, not the app,
 * decides whether a native notification may be raised at all. This hook is how
 * that column tells the truth.
 *
 * THIS HOOK NEVER CALLS `Notification.requestPermission()` — it only observes.
 * Requesting is `services/browserNotifications.ts`'s job, and since #365 the app
 * DOES prompt without a click: `hooks/usePushSubscriptionSync.ts` auto-prompts
 * once per page load when the deployment has push enabled, and the app-wide
 * banner and the settings page offer a button for browsers that ignore a
 * gestureless request. Keeping every request out of this file means "what
 * prompts, and when?" is answered by that one service's callers.
 *
 * WHY A HOOK RATHER THAN READING `Notification.permission` INLINE
 * ---------------------------------------------------------------
 * Because the value CHANGES UNDER THE PAGE. A user who reads "blocked — allow
 * notifications in your browser settings", opens those settings in another tab,
 * flips the switch and comes back would otherwise still be looking at "blocked"
 * until a full reload — and would reasonably conclude the app is broken. So the
 * value is state, and it is re-read on the signals that can indicate a change:
 *
 *   1. The Permissions API's `change` event, where available — the exact,
 *     immediate signal.
 *   2. `visibilitychange`, as the fallback for browsers whose Permissions API
 *     does not expose `notifications` (older Safari). Coming back to the tab is
 *     precisely the moment a user who just changed the setting returns.
 *   3. `NOTIFICATION_PERMISSION_CHANGED_EVENT` (#365), which this app fires
 *     after its own requests settle, so every mounted instance — the shell's
 *     banner and the settings page — updates together.
 */

import { useCallback, useEffect, useState } from 'react';
import { NOTIFICATION_PERMISSION_CHANGED_EVENT } from '../services/browserNotifications';

/**
 * Permission as this app needs to reason about it.
 *
 * `'unsupported'` is a FOURTH state the Web API does not have, and it is not
 * the same as `'denied'`: the browser has refused nothing, it simply has no
 * `Notification` constructor (an old browser, or — the common case in this
 * repo — jsdom under the test runner, and any non-secure-context origin). The
 * UI must say "your browser does not support this", not "you blocked this",
 * because the remedies are completely different and only one of them exists.
 */
export type BrowserNotificationPermission =
  | 'unsupported'
  | 'default'
  | 'granted'
  | 'denied';

/**
 * Read the permission defensively.
 *
 * Feature-detected on every read rather than once at module load: this module
 * is imported by a lazily-loaded page, and a module-level snapshot would also
 * be unpatchable from a test that stubs `window.Notification` after import.
 *
 * The `try` is not decorative. Some embedded and privacy-hardened browsers
 * define `Notification` and THROW on the property access, and this is a
 * settings page — a permission read must never be the thing that blanks it.
 */
function readPermission(): BrowserNotificationPermission {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  try {
    const value = window.Notification.permission;
    return value === 'granted' || value === 'denied' ? value : 'default';
  } catch {
    return 'unsupported';
  }
}

export interface UseBrowserNotificationPermissionResult {
  /** What the browser says right now. See `BrowserNotificationPermission`. */
  permission: BrowserNotificationPermission;
  /**
   * Force a re-read.
   *
   * CALLED BY EVERY PROMPT HANDLER (`UserNotificationsPage`,
   * `usePushSubscriptionSync`), in a `finally`, after
   * `Notification.requestPermission()` settles — so the UI moves to its
   * `granted` or `denied` treatment without a reload.
   *
   * Unconditional there rather than driven by the request's return value: the
   * user can dismiss the prompt without choosing (permission stays `default`)
   * and some browsers resolve with nothing useful at all. Re-reading
   * `Notification.permission` is the only answer that is right in every case.
   */
  refresh: () => void;
}

export function useBrowserNotificationPermission(): UseBrowserNotificationPermissionResult {
  // Lazy initialiser, so the read happens once on mount rather than on every
  // render of a component that may re-render on each toggle.
  const [permission, setPermission] = useState<BrowserNotificationPermission>(readPermission);

  const refresh = useCallback(() => {
    setPermission(readPermission());
  }, []);

  useEffect(() => {
    // Re-read once on mount as well as in the initialiser: this page is lazily
    // loaded and the module may have been evaluated long before it mounted.
    refresh();

    const onVisibility = () => {
      // Only when the tab becomes visible. Re-reading as it HIDES is work
      // nobody can see, and the interesting transition is the return.
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    // An app-initiated request settled somewhere (#365) — see the header.
    window.addEventListener(NOTIFICATION_PERMISSION_CHANGED_EVENT, refresh);

    // The Permissions API is the precise signal, and is optional in two ways:
    // the API may be absent, and `notifications` may be an unsupported name
    // (Safari), in which case `query` REJECTS rather than returning a status.
    // Both are handled by falling back to `visibilitychange` above.
    let status: PermissionStatus | null = null;
    let cancelled = false;
    const onChange = () => refresh();

    // The `try` wraps the CALL, not just the promise: older WebKit throws a
    // synchronous `TypeError` for an unsupported permission name rather than
    // returning a rejected promise, and an exception escaping an effect would
    // take the whole settings page down over a progressive enhancement.
    try {
      void navigator.permissions
        ?.query({ name: 'notifications' as PermissionName })
        .then((result) => {
          // The component may have unmounted while this promise was in flight;
          // binding the listener then would leak it past the cleanup below.
          if (cancelled) return;
          status = result;
          result.addEventListener('change', onChange);
          refresh();
        })
        .catch(() => {
          // Not supported here. `visibilitychange` remains the fallback; this
          // is an expected outcome, not an error worth surfacing to the user.
        });
    } catch {
      // Same fallback as the rejection path above.
    }

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener(NOTIFICATION_PERMISSION_CHANGED_EVENT, refresh);
      status?.removeEventListener('change', onChange);
    };
  }, [refresh]);

  return { permission, refresh };
}
