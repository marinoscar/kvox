/**
 * Keep the screen on while an upload is running — issue #22, epic #19.
 *
 * =============================================================================
 * WHAT THIS BUYS, AND WHAT IT CANNOT
 * =============================================================================
 *
 * On a phone, the screen locking is the single most common reason a long
 * upload stalls: Android throttles background pages hard, and **iOS suspends
 * network activity for a backgrounded tab outright, wake lock or not.** The
 * Screen Wake Lock API only prevents the screen from dimming and locking while
 * the page is VISIBLE — it is not a background-execution permit, and no web API
 * is. So this hook makes "phone on the desk, screen on, uploading" work
 * reliably; it does nothing for "phone in pocket". That limitation is why the
 * toggle is worded as *keep screen on* rather than *keep uploading in the
 * background*, which would be a promise the platform does not let us keep.
 *
 * =============================================================================
 * THE RE-ACQUIRE ON `visibilitychange` IS NOT OPTIONAL
 * =============================================================================
 *
 * The browser RELEASES the sentinel itself whenever the document becomes
 * hidden — switching apps, an incoming call, the user glancing at a
 * notification. It is never re-granted automatically. Without the
 * `visibilitychange` listener below, the first time a user looks away the lock
 * is gone for the rest of the upload and the toggle silently stops meaning
 * anything. A wake-lock implementation without this listener looks correct in
 * every test that never hides the document, which is every test that does not
 * go looking for it.
 *
 * Entirely feature-detected: where `navigator.wakeLock` is missing (Safari
 * before 16.4, Firefox for a long time, any embedded webview) `supported` is
 * `false`, nothing is called, and nothing throws.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseScreenWakeLockOptions {
  /** The user's preference — the "Keep screen on while uploading" toggle. */
  enabled: boolean;
  /** Whether there is anything worth holding the screen on FOR. */
  active: boolean;
}

export interface UseScreenWakeLockResult {
  /** Whether this browser has the API at all. Drives disabling the toggle. */
  supported: boolean;
  /** Whether a sentinel is currently held. */
  held: boolean;
}

/** Feature detection. `navigator.wakeLock` is typed non-optional, so `in` it is. */
export function isWakeLockSupported(): boolean {
  try {
    return (
      typeof navigator !== 'undefined' &&
      'wakeLock' in navigator &&
      typeof (navigator as Navigator).wakeLock?.request === 'function'
    );
  } catch {
    return false;
  }
}

export function useScreenWakeLock({
  enabled,
  active,
}: UseScreenWakeLockOptions): UseScreenWakeLockResult {
  const [supported] = useState(() => isWakeLockSupported());
  const [held, setHeld] = useState(false);
  const sentinelRef = useRef<WakeLockSentinel | null>(null);
  /**
   * The latest intent, readable from the `visibilitychange` listener without
   * re-registering it on every render. A listener that closed over `enabled`
   * and `active` would have to be torn down and rebuilt constantly, and a
   * `visibilitychange` that arrives during that gap is exactly the event this
   * hook exists to catch.
   */
  const wantRef = useRef(false);
  wantRef.current = supported && enabled && active;

  const release = useCallback(async () => {
    const sentinel = sentinelRef.current;
    sentinelRef.current = null;
    setHeld(false);
    if (!sentinel) return;
    try {
      await sentinel.release();
    } catch {
      // Already released by the browser (the usual case on hide). Nothing to do.
    }
  }, []);

  const acquire = useCallback(async () => {
    if (!wantRef.current) return;
    if (sentinelRef.current) return;
    // The request is REJECTED on a hidden document, by spec. Checking first
    // keeps the console clean rather than relying on the catch below.
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;

    try {
      const sentinel = await navigator.wakeLock.request('screen');
      if (!wantRef.current) {
        // The intent changed while the request was in flight (upload finished,
        // toggle switched off). Hand the lock straight back.
        try {
          await sentinel.release();
        } catch {
          /* nothing to do */
        }
        return;
      }
      sentinelRef.current = sentinel;
      setHeld(true);
      sentinel.addEventListener('release', () => {
        if (sentinelRef.current === sentinel) {
          sentinelRef.current = null;
          setHeld(false);
        }
      });
    } catch {
      // Denied (battery saver, policy) or unsupported in this context. Silent
      // by design: the upload is unaffected, and there is nothing the user
      // could usefully do about it.
      setHeld(false);
    }
  }, []);

  useEffect(() => {
    if (!supported) return;
    if (enabled && active) {
      void acquire();
    } else {
      void release();
    }
  }, [supported, enabled, active, acquire, release]);

  useEffect(() => {
    if (!supported || typeof document === 'undefined') return;

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && wantRef.current) {
        void acquire();
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [supported, acquire]);

  // Release on unmount, whatever the intent was. A sentinel outliving the tree
  // that asked for it keeps a user's screen awake with nothing left to show.
  useEffect(() => {
    return () => {
      void release();
    };
  }, [release]);

  return { supported, held };
}
