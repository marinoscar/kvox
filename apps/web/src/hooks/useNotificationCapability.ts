/**
 * CAN THIS DEVICE SHOW A BROWSER NOTIFICATION, AND IF NOT — WHAT FIXES IT?
 *
 * Issue #221, epic #215. A LAYER OVER `useBrowserNotificationPermission`, never
 * a replacement for it: that hook still owns the one question the Web API
 * actually answers ("what is `Notification.permission` right now?"). Neither
 * hook requests permission — since #365 the shell's `usePushSubscriptionSync`
 * does that, once per load, when push is enabled. This
 * module adds the questions the Web API does not answer, which turn out to be
 * the ones the user needs answered.
 *
 * =============================================================================
 * WHY FOUR STATES WERE NOT ENOUGH
 * =============================================================================
 *
 * `BrowserNotificationPermission` collapses `unsupported` over at least four
 * genuinely different situations whose remedies have nothing in common:
 *
 *   * AN iOS SAFARI TAB. `window.Notification` is undefined there, so the
 *     4-state hook says `unsupported` and the UI says "your browser does not
 *     support notifications" — which is FALSE and, worse, unactionable. iOS
 *     supports web notifications; it just only supports them for a web app the
 *     user has ADDED TO THE HOME SCREEN. The remedy is Share → Add to Home
 *     Screen, and a user told their browser is incapable will never find it.
 *   * AN INSECURE CONTEXT. Plain HTTP has no `Notification` either, and it is
 *     indistinguishable from a browser genuinely lacking the API — but the
 *     remedy is "serve this over HTTPS", which is nobody's browser's fault.
 *   * AN ADMINISTRATOR TURNED IT OFF. #225 shipped that switch. It had no
 *     representation here at all, so the UI could only describe the browser's
 *     opinion of a feature the server had already withdrawn.
 *   * THE SERVICE WORKER DID NOT REGISTER (#218). DEGRADED, NOT BLOCKED — the
 *     page-level `Notification` fallback may still work on desktop — so
 *     rendering it as "blocked" would be as wrong as rendering it as "fine".
 *
 * Every one of those rendered identically before this file existed. The whole
 * point of the 8-state union is that each arm names a DIFFERENT thing to do.
 *
 * =============================================================================
 * THE PRECEDENCE ORDER, AND WHY IT IS THIS ORDER
 * =============================================================================
 *
 * These conditions are not mutually exclusive — an iPad in a Safari tab on
 * plain HTTP satisfies three of them at once — so the order is not a detail,
 * it IS the behaviour. It is ordered by WHICH REMEDY IS WORTH SHOWING, i.e.
 * outermost obstacle first: fixing an inner one while an outer one still holds
 * changes nothing the user can see, so advertising the inner remedy first sends
 * them off to do work that cannot possibly help.
 *
 *   1. `admin-disabled`    — an administrator kill switch makes EVERY
 *                            downstream remedy unactionable. Telling somebody
 *                            to install the app to the Home Screen, or to
 *                            un-block the site, when the server will not send
 *                            browser notifications to anyone, is wasted effort
 *                            ending in a feature that still does nothing.
 *   2. `insecure-context`  — over plain HTTP the APIs are not merely absent,
 *                            they CANNOT be present. No browser change, no
 *                            install, and no permission grant reaches them, so
 *                            this outranks every capability question below it.
 *   3. `unsupported`       — no `Notification` AND no `serviceWorker`. This is
 *                            the genuinely hopeless case, and it is checked
 *                            BEFORE the iOS arm on purpose: iOS Safari in a tab
 *                            has NO `Notification` but DOES have
 *                            `serviceWorker`, so requiring both to be missing
 *                            is exactly what stops an iPhone from falling in
 *                            here and being told the lie #221 exists to delete.
 *   4. `ios-needs-install` — iOS/iPadOS, not installed. A real, specific,
 *                            achievable remedy, and it must outrank the
 *                            permission-shaped states below: on iOS there is no
 *                            permission to grant until the app is installed, so
 *                            "allow notifications" is not yet a thing that can
 *                            be done.
 *
 * The remaining four are NOT a continuation of that list — they are decided
 * TOGETHER, from the permission, because they are all permission-shaped:
 *
 *   5. `denied`            — the browser refused. Per-platform remedy, owned by
 *                            the user, not by this app.
 *   6. `default`           — not asked yet. The ONLY state in which the app may
 *                            prompt — automatically (#365) or from a button.
 *   7. `sw-unavailable`    — permission GRANTED, but no service worker
 *                            registration. Delivery may be limited; see below.
 *   8. `granted`           — permission granted and a worker is registered.
 *
 * =============================================================================
 * WHY `sw-unavailable` SITS WITH THE PERMISSION ARMS AND NOT ABOVE THEM
 * =============================================================================
 *
 * The obvious ordering — worker trouble outranks everything permission-shaped,
 * since on Android the Notifications API is service-worker-only — was written
 * first and is WRONG. It deadlocks a real user:
 *
 *   * The button that opens the browser's permission prompt renders in the
 *     `default` state and nowhere else (see `NotificationSettings.tsx`).
 *   * So if a missing registration preempted `default`, a user whose worker
 *     failed to register could never reach the prompt, and therefore could
 *     never move off `default` at all.
 *   * And #222's `showAppNotification` tries `registration.showNotification()`
 *     FIRST and falls back to `new Notification()` when there is no
 *     registration — a fallback that exists precisely for this case. The
 *     ordering would have made that fallback unreachable on every profile that
 *     had not already granted permission: the capability model would be
 *     forbidding the exact situation the delivery path is built to handle.
 *
 * `sw-unavailable` is DEGRADED, NOT BLOCKED — which is also why it is the one
 * problem state that leaves its control enabled. It therefore describes a
 * granted-but-degraded device, not a pre-permission one:
 *
 *     denied                          -> denied
 *     default                         -> default          (prompt offered)
 *     granted + no registration       -> sw-unavailable   (degraded)
 *     granted + registration          -> granted
 *
 * Granting is a prerequisite for BOTH delivery paths, so offering the prompt in
 * `default` costs nothing even when the worker is missing: the page-level
 * `Notification` fallback can still use the result.
 *
 * `admin-disabled`, `insecure-context`, `unsupported` and `ios-needs-install`
 * keep their position ahead of all four, because each is either genuinely
 * unactionable or has a DIFFERENT remedy that must be done first — which is the
 * distinction that justifies preempting the permission at all.
 *
 * =============================================================================
 * DEFENSIVE POSTURE — INHERITED, NOT REINVENTED
 * =============================================================================
 *
 * Same rules as the hook underneath: feature-detect BY ACCESS inside `try`
 * (hardened browsers define these objects and throw on touching them), never
 * throw out of a probe, and re-read rather than snapshot at module scope. The
 * permission itself is not re-derived here at all — it is consumed from
 * `useBrowserNotificationPermission`, which already tracks it through both
 * `visibilitychange` and `navigator.permissions.query({name:'notifications'})`.
 * Duplicating that tracking would give this file a second, subtly-different
 * answer to a question that already has one.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  useBrowserNotificationPermission,
  type BrowserNotificationPermission,
} from './useBrowserNotificationPermission';

/**
 * What this device can do about browser notifications, and therefore what the
 * UI must tell the user to do. Every arm has a DISTINCT remedy — see
 * `browserChannelState` in `components/settings/NotificationSettings.tsx`,
 * which is the one place these are turned into copy.
 */
export type NotificationCapability =
  /** An administrator turned browser notifications off for everyone (#225). */
  | 'admin-disabled'
  /** Served over plain HTTP; the APIs cannot exist here. */
  | 'insecure-context'
  /** Neither `Notification` nor `serviceWorker`. Nothing to configure. */
  | 'unsupported'
  /** iOS/iPadOS, not installed to the Home Screen. */
  | 'ios-needs-install'
  /**
   * Permission is GRANTED but there is no service worker registration.
   * DEGRADED, not blocked — #222's page-level `new Notification()` fallback may
   * still deliver, and on Android it is the worker or nothing.
   */
  | 'sw-unavailable'
  | 'denied'
  | 'default'
  | 'granted';

/**
 * Everything the decision depends on, as plain data.
 *
 * SEPARATED FROM THE HOOK so the precedence order above is testable as a table
 * rather than only through eight different global-object stubs, and so the
 * order lives in one readable function instead of being spread across effects.
 */
export interface NotificationCapabilityInputs {
  /** #225's kill switch. See `useNotificationCapability`'s options. */
  adminDisabled: boolean;
  /** `window.isSecureContext`, as far as it can be determined. */
  isSecureContext: boolean;
  /** A `Notification` constructor exists AND is safe to touch. */
  hasNotificationApi: boolean;
  /** `navigator.serviceWorker` exists. */
  hasServiceWorkerApi: boolean;
  /** iPhone, iPod, or iPad — including an iPad claiming to be a Mac. */
  isIos: boolean;
  /** Running as an installed/standalone web app rather than in a tab. */
  isStandalone: boolean;
  /**
   * A service worker registration exists (or its presence is not yet known —
   * see `useNotificationCapability`, which reports "unknown" as `true`).
   */
  hasServiceWorkerRegistration: boolean;
  /** The live value from `useBrowserNotificationPermission`. */
  permission: BrowserNotificationPermission;
}

/**
 * The precedence order, executed. Pure — no globals, no React.
 *
 * Read top to bottom: this function IS the ordered list documented in the file
 * header, and the two must never disagree.
 */
export function resolveNotificationCapability(
  inputs: NotificationCapabilityInputs,
): NotificationCapability {
  // 1. The kill switch outranks everything: no remedy below it can produce a
  //    notification while it is on.
  if (inputs.adminDisabled) return 'admin-disabled';

  // 2. Plain HTTP. The APIs below cannot exist here regardless of browser.
  if (!inputs.isSecureContext) return 'insecure-context';

  // 3. Genuinely nothing to work with. BOTH must be missing — an iOS Safari
  //    tab has `serviceWorker` but no `Notification`, and must reach the arm
  //    below rather than being told its browser is incapable.
  if (!inputs.hasNotificationApi && !inputs.hasServiceWorkerApi) return 'unsupported';

  // 4. iOS only grants notifications to an installed web app.
  if (inputs.isIos && !inputs.isStandalone) return 'ios-needs-install';

  // 5-8. THE PERMISSION-SHAPED STATES, decided together.
  //
  // A permission that cannot be READ at this point (a browser with
  // `serviceWorker` but no usable `Notification`, which rule 3 deliberately let
  // through) is honestly reported as unsupported: there is no other
  // permission-shaped answer to give.
  if (inputs.permission === 'unsupported') return 'unsupported';

  // `denied` and `default` are reported REGARDLESS of the worker. `default` in
  // particular must survive a missing registration, or the user can never reach
  // the prompt and therefore never leaves `default` — see the header. Granting
  // is a prerequisite for both delivery paths, including #222's page-level
  // `new Notification()` fallback, which exists for exactly this case.
  if (inputs.permission !== 'granted') return inputs.permission;

  // Granted. NOW the worker matters: it is the only thing that can still
  // degrade delivery, and on Android it is the only path at all.
  if (!inputs.hasServiceWorkerRegistration) return 'sw-unavailable';

  return 'granted';
}

// =============================================================================
// Environment probes — every one of them non-throwing
// =============================================================================

/**
 * Is this a secure context?
 *
 * ONLY AN EXPLICIT `false` COUNTS. `window.isSecureContext` is `undefined` in
 * environments that never implemented it — jsdom under this repo's test runner,
 * and browsers old enough to predate the flag — and `!undefined` would send
 * every one of them to "switch to HTTPS", which is the wrong remedy stated with
 * total confidence. Nothing is lost by the leniency: every browser that has a
 * `Notification` constructor also has this flag, so an environment that lacks
 * it falls through to `unsupported` a line later, which is the honest answer.
 */
function readIsSecureContext(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.isSecureContext !== false;
  } catch {
    return true;
  }
}

/** Is there a `Notification` constructor, and is touching it safe? */
function readHasNotificationApi(): boolean {
  if (typeof window === 'undefined' || !('Notification' in window)) return false;
  try {
    // THE ACCESS IS THE TEST, not the presence of the key — some embedded and
    // privacy-hardened browsers expose `Notification` and throw here. Same
    // defence as `useBrowserNotificationPermission.readPermission`.
    void window.Notification.permission;
    return true;
  } catch {
    return false;
  }
}

/** Is there a `navigator.serviceWorker`? */
function readHasServiceWorkerApi(): boolean {
  try {
    return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
  } catch {
    return false;
  }
}

/**
 * iPhone / iPod / iPad — INCLUDING an iPad that says it is a Mac.
 *
 * =============================================================================
 * WHY A NAIVE USER-AGENT TEST IS WRONG HERE
 * =============================================================================
 *
 * Since iPadOS 13, Safari on iPad requests desktop sites BY DEFAULT and reports
 * a Macintosh user agent with `navigator.platform === 'MacIntel'`. There is no
 * "iPad" substring left to match on. So `/iPad|iPhone|iPod/.test(userAgent)` —
 * the idiom every older answer suggests — silently classifies every modern iPad
 * as a desktop Mac, which is precisely the device most likely to be browsing in
 * a tab and most in need of the "Add to Home Screen" remedy. The bug would only
 * ever appear on hardware the developer does not have.
 *
 * The standard separator is TOUCH: no Mac reports more than one touch point
 * (they report 0, including Macs with a Touch Bar, because that is not a
 * touchscreen for the purposes of this API), while every iPad reports 5. So a
 * Mac-like platform WITH multi-touch is an iPad, and it is the only thing it
 * can be.
 *
 * `navigator.platform` is deprecated but not removed and remains the reliable
 * signal for exactly this check; `userAgentData` deliberately does not expose
 * enough to replace it, and Safari does not implement it at all. Both signals
 * are read, so a UA-spoofing extension that changes one of them still lands on
 * the right answer as long as the other is intact.
 */
function readIsIos(): boolean {
  try {
    if (typeof navigator === 'undefined') return false;

    const platform = typeof navigator.platform === 'string' ? navigator.platform : '';
    const userAgent = typeof navigator.userAgent === 'string' ? navigator.userAgent : '';

    // iPhone and iPod still identify themselves honestly, and so does an iPad
    // that has been switched to "Request Mobile Website".
    if (/iPad|iPhone|iPod/.test(platform) || /iPad|iPhone|iPod/.test(userAgent)) {
      return true;
    }

    // The iPadOS-as-Mac case. Touch is the discriminator; see above.
    const isMacLike = platform === 'MacIntel' || /Mac/.test(platform) || /Macintosh/.test(userAgent);
    const touchPoints = typeof navigator.maxTouchPoints === 'number' ? navigator.maxTouchPoints : 0;
    return isMacLike && touchPoints > 1;
  } catch {
    return false;
  }
}

/**
 * Is this an installed web app rather than a browser tab?
 *
 * Two signals because neither is universal: `display-mode: standalone` is the
 * standard and is what Chrome/Edge/Android answer, while `navigator.standalone`
 * is Safari's own non-standard flag and is the ONLY one older iOS answers — and
 * iOS is the entire reason this function exists.
 */
function readIsStandalone(): boolean {
  if (typeof window === 'undefined') return false;

  try {
    if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  } catch {
    // A matchMedia that throws (or is absent) is not evidence either way; fall
    // through to the Safari flag below.
  }

  try {
    // Non-standard, Safari-only, and absent everywhere else — hence the cast
    // rather than a lib declaration this app would then have to maintain.
    return (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

/**
 * Whether a service worker registration exists.
 *
 * `'unknown'` is a real state, not a placeholder: `getRegistration()` is async,
 * so on the very first render the answer genuinely is not known yet, and it is
 * reported as PRESENT (see the hook below). Reporting it as absent instead
 * would flash a "notifications may be limited" warning on every load of
 * `/settings/notifications` that then vanishes — a warning that appears and
 * retracts itself teaches users to ignore warnings.
 */
type ServiceWorkerPresence = 'unknown' | 'present' | 'absent';

export interface UseNotificationCapabilityOptions {
  /**
   * An administrator has turned browser notifications off for everyone (#225).
   *
   * AN INPUT FOR NOW, DELIBERATELY. #227 wires the real value from
   * `GET /api/notifications/config` through to this prop; until then it
   * defaults to `false` ("not disabled"), so the capability is decided entirely
   * by the device — which is exactly what it was before this hook existed. When
   * #227 lands, only the CALLER changes: the precedence rule above is already
   * correct and needs no edit.
   */
  adminDisabled?: boolean;
}

export interface UseNotificationCapabilityResult {
  /** The single answer the UI renders. See `NotificationCapability`. */
  capability: NotificationCapability;
  /**
   * The raw 4-state permission underneath, passed through unchanged.
   *
   * Exposed because "the browser has denied us" and "the capability is
   * `denied`" are not the same claim — the capability can be `admin-disabled`
   * while the browser says `granted` — and a caller that genuinely needs the
   * browser's own opinion should not have to reach around this hook for it.
   */
  permission: BrowserNotificationPermission;
  /**
   * Force a re-read of everything: the permission (delegated downwards) and
   * the service worker registration.
   *
   * Called by the prompt handlers in `pages/UserNotificationsPage.tsx` and
   * `hooks/usePushSubscriptionSync.ts` in a `finally` after
   * `Notification.requestPermission()` settles, for the reason
   * given in `useBrowserNotificationPermission`: re-reading is right in every
   * case, including the one where the user dismissed the prompt and nothing
   * changed at all.
   */
  refresh: () => void;
}

export function useNotificationCapability(
  options: UseNotificationCapabilityOptions = {},
): UseNotificationCapabilityResult {
  const { adminDisabled = false } = options;

  // THE PERMISSION IS NOT RE-DERIVED HERE. This hook consumes the existing one
  // whole — including its `visibilitychange` and Permissions API `change`
  // tracking — so there is exactly one implementation of "what does the browser
  // say".
  const { permission, refresh: refreshPermission } = useBrowserNotificationPermission();

  const [swPresence, setSwPresence] = useState<ServiceWorkerPresence>('unknown');
  // Bumped by `refresh()` to re-run the registration probe below. A counter
  // rather than a boolean so consecutive refreshes each trigger one.
  const [swProbe, setSwProbe] = useState(0);

  const refresh = useCallback(() => {
    refreshPermission();
    setSwProbe((n) => n + 1);
  }, [refreshPermission]);

  useEffect(() => {
    if (!readHasServiceWorkerApi()) {
      setSwPresence('absent');
      return;
    }

    let cancelled = false;

    const check = () => {
      try {
        // A controlling worker is proof of registration and needs no await —
        // which also means the common case never renders the 'unknown' state
        // for a frame.
        if (navigator.serviceWorker.controller) {
          if (!cancelled) setSwPresence('present');
          return;
        }

        void navigator.serviceWorker
          .getRegistration()
          .then((registration) => {
            if (!cancelled) setSwPresence(registration ? 'present' : 'absent');
          })
          .catch(() => {
            // Registration lookup can reject outright — a blocked or
            // partitioned storage context, notably. Treated as absent: that is
            // the DEGRADED arm, not a blocked one, so guessing wrong here costs
            // an explanatory note rather than a disabled control.
            if (!cancelled) setSwPresence('absent');
          });
      } catch {
        if (!cancelled) setSwPresence('absent');
      }
    };

    check();

    // The worker may finish registering AFTER this page mounted — the
    // `registerSW.js` injected by vite-plugin-pwa registers on window load —
    // so a one-shot check at mount would report `sw-unavailable` on a cold
    // first visit and never take it back.
    const onControllerChange = () => check();
    try {
      navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
    } catch {
      // Nothing to fall back to; the mount-time answer stands.
    }

    return () => {
      cancelled = true;
      try {
        navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      } catch {
        // Removing a listener that was never added is not an error worth
        // taking a settings page down for.
      }
    };
  }, [swProbe]);

  // Computed on every render rather than held in state. These facts are read
  // from live globals and are cheap; snapshotting them would add a second
  // source of truth that can only ever be more stale than the globals it copies
  // — and `display-mode` in particular changes when an installed app is
  // launched.
  const capability = resolveNotificationCapability({
    adminDisabled,
    isSecureContext: readIsSecureContext(),
    hasNotificationApi: readHasNotificationApi(),
    hasServiceWorkerApi: readHasServiceWorkerApi(),
    isIos: readIsIos(),
    isStandalone: readIsStandalone(),
    // 'unknown' reports as PRESENT — see `ServiceWorkerPresence`.
    hasServiceWorkerRegistration: swPresence !== 'absent',
    permission,
  });

  return { capability, permission, refresh };
}
