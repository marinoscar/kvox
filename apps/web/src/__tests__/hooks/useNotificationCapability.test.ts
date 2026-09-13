import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  useNotificationCapability,
  resolveNotificationCapability,
  type NotificationCapability,
  type NotificationCapabilityInputs,
} from '../../hooks/useNotificationCapability';

/**
 * Issue #221, epic #215.
 *
 * The 4-state `BrowserNotificationPermission` collapsed four situations with
 * completely different remedies into one `unsupported`, and the most damaging
 * of them is an iOS Safari TAB: `window.Notification` is undefined there, so
 * the user was told their browser could not show notifications when the actual
 * fix is Add to Home Screen. This suite's job is to prove each of the eight
 * states is reachable and, more importantly, that the PRECEDENCE between them
 * is the documented one - they are not mutually exclusive (an iPad on plain
 * HTTP satisfies three at once), so the order is the behaviour.
 *
 * It follows the idiom of `useBrowserNotificationPermission.test.ts`: the
 * globals are replaced per-test with hand-rolled fakes and restored in
 * `afterEach`, because the hook feature-detects BY ACCESS on every read
 * (hardened browsers throw on `Notification.permission`) and a module-level
 * snapshot would be unpatchable.
 */

// ---------------------------------------------------------------------------
// Global stubbing. Everything defined here is torn down in afterEach.
// ---------------------------------------------------------------------------

// `Notification` and `navigator.serviceWorker` are no longer captured/restored
// here - `setup.ts` installs a fresh neutral default for both before every
// test (issue #232), so this file's `setNotification`/`setServiceWorker`
// overrides below simply reassign over that default per test, and the next
// test starts clean without this file having to remember or restore
// anything. `platform`/`userAgent`/`maxTouchPoints`/`standalone` have no such
// global default, so they still need their own capture-free teardown
// (`delete` is correct for all four: jsdom's real `navigator` never defines
// any of them, so there is no "original" value to restore).
const originalMatchMedia = window.matchMedia;
const OVERRIDDEN_NAVIGATOR_KEYS = [
  'platform',
  'userAgent',
  'maxTouchPoints',
  'standalone',
] as const;

function setNavigator(key: string, value: unknown) {
  Object.defineProperty(window.navigator, key, { value, configurable: true, writable: true });
}

function setSecureContext(value: boolean | undefined) {
  if (value === undefined) {
    delete (window as any).isSecureContext;
    return;
  }
  Object.defineProperty(window, 'isSecureContext', { value, configurable: true, writable: true });
}

/** The `Notification` fake. Returns its `requestPermission` spy for assertions. */
function setNotification(
  permission: 'granted' | 'denied' | 'default' | 'absent',
  opts: { throwOnRead?: boolean } = {},
) {
  if (permission === 'absent') {
    delete (window as any).Notification;
    return vi.fn();
  }

  const requestPermission = vi.fn();

  if (opts.throwOnRead) {
    (window as any).Notification = {
      get permission(): string {
        throw new Error('blocked by privacy hardening');
      },
      requestPermission,
    };
  } else {
    (window as any).Notification = { permission, requestPermission };
  }

  return requestPermission;
}

/**
 * `navigator.serviceWorker`.
 *
 * `'absent'` deletes it entirely (the API is missing); `'unregistered'` keeps
 * the API but resolves `getRegistration()` with `undefined`, which is the real
 * shape of "the worker failed to register" - a distinction the hook cares
 * about because only the first can ever be `unsupported`.
 */
function setServiceWorker(state: 'absent' | 'registered' | 'unregistered' | 'rejects') {
  if (state === 'absent') {
    delete (window.navigator as any).serviceWorker;
    return null;
  }

  const fake = {
    controller: null as unknown,
    getRegistration: vi.fn(() =>
      state === 'rejects'
        ? Promise.reject(new Error('storage partitioned'))
        : Promise.resolve(state === 'registered' ? ({} as ServiceWorkerRegistration) : undefined),
    ),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };

  setNavigator('serviceWorker', fake);
  return fake;
}

/** A plain desktop Chrome on HTTPS with a registered worker: everything fine. */
function setHealthyDesktop(permission: 'granted' | 'denied' | 'default' = 'granted') {
  setSecureContext(true);
  const requestPermission = setNotification(permission);
  setServiceWorker('registered');
  setNavigator('platform', 'Linux x86_64');
  setNavigator(
    'userAgent',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  );
  setNavigator('maxTouchPoints', 0);
  setNavigator('standalone', undefined);
  return requestPermission;
}

/** An iPhone in a Safari TAB: no `Notification`, but `serviceWorker` exists. */
function setIphoneTab() {
  setSecureContext(true);
  setNotification('absent');
  setServiceWorker('registered');
  setNavigator('platform', 'iPhone');
  setNavigator(
    'userAgent',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
  );
  setNavigator('maxTouchPoints', 5);
  setNavigator('standalone', false);
}

/**
 * A modern iPad. THE HARD CASE: since iPadOS 13 it requests desktop sites by
 * default and reports a MACINTOSH user agent with `platform === 'MacIntel'`,
 * so there is no "iPad" substring anywhere to match on.
 */
function setIpadClaimingToBeAMac() {
  setSecureContext(true);
  setNotification('absent');
  setServiceWorker('registered');
  setNavigator('platform', 'MacIntel');
  setNavigator(
    'userAgent',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  );
  // The ONLY thing separating it from a real Mac. Every iPad reports 5; no Mac
  // reports more than 1, Touch Bar included.
  setNavigator('maxTouchPoints', 5);
  setNavigator('standalone', false);
}

afterEach(() => {
  for (const key of OVERRIDDEN_NAVIGATOR_KEYS) {
    delete (window.navigator as any)[key];
  }

  delete (window as any).isSecureContext;
  window.matchMedia = originalMatchMedia;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The pure resolver: the precedence order as a table
// ---------------------------------------------------------------------------

/**
 * The inputs of a device where nothing is wrong. Each case below breaks
 * exactly the fields it is about, so a test reads as "this and only this".
 */
const HEALTHY: NotificationCapabilityInputs = {
  adminDisabled: false,
  isSecureContext: true,
  hasNotificationApi: true,
  hasServiceWorkerApi: true,
  isIos: false,
  isStandalone: false,
  hasServiceWorkerRegistration: true,
  permission: 'granted',
};

describe('resolveNotificationCapability (the precedence order)', () => {
  const cases: Array<{
    name: string;
    inputs: Partial<NotificationCapabilityInputs>;
    expected: NotificationCapability;
  }> = [
    { name: 'granted', inputs: {}, expected: 'granted' },
    { name: 'default', inputs: { permission: 'default' }, expected: 'default' },
    { name: 'denied', inputs: { permission: 'denied' }, expected: 'denied' },
    {
      name: 'sw-unavailable',
      inputs: { hasServiceWorkerRegistration: false },
      expected: 'sw-unavailable',
    },
    {
      name: 'ios-needs-install',
      inputs: { isIos: true, isStandalone: false },
      expected: 'ios-needs-install',
    },
    {
      name: 'unsupported',
      inputs: { hasNotificationApi: false, hasServiceWorkerApi: false, permission: 'unsupported' },
      expected: 'unsupported',
    },
    { name: 'insecure-context', inputs: { isSecureContext: false }, expected: 'insecure-context' },
    { name: 'admin-disabled', inputs: { adminDisabled: true }, expected: 'admin-disabled' },
  ];

  for (const { name, inputs, expected } of cases) {
    it(`resolves ${name}`, () => {
      expect(resolveNotificationCapability({ ...HEALTHY, ...inputs })).toBe(expected);
    });
  }

  // =========================================================================
  // The pairs where two conditions hold at once. These are the whole reason
  // the order is written down: fixing an inner obstacle while an outer one
  // still holds changes nothing the user can see, so the outer remedy is the
  // only one worth showing.
  // =========================================================================

  it('admin-disabled beats every device condition - no local remedy can help while it is on', () => {
    expect(
      resolveNotificationCapability({
        ...HEALTHY,
        adminDisabled: true,
        isSecureContext: false,
        hasNotificationApi: false,
        hasServiceWorkerApi: false,
        isIos: true,
        hasServiceWorkerRegistration: false,
        permission: 'denied',
      }),
    ).toBe('admin-disabled');
  });

  it('an insecure context on iOS in a tab reports insecure-context, NOT ios-needs-install', () => {
    // Installing to the Home Screen over plain HTTP fixes nothing, so sending
    // the user through Share -> Add to Home Screen first would be wasted work
    // ending in a feature that still does not exist.
    expect(
      resolveNotificationCapability({
        ...HEALTHY,
        isSecureContext: false,
        isIos: true,
        isStandalone: false,
        hasNotificationApi: false,
        permission: 'unsupported',
      }),
    ).toBe('insecure-context');
  });

  it('an iOS tab is ios-needs-install, never unsupported - it HAS serviceWorker, only Notification is missing', () => {
    expect(
      resolveNotificationCapability({
        ...HEALTHY,
        isIos: true,
        isStandalone: false,
        hasNotificationApi: false,
        hasServiceWorkerApi: true,
        permission: 'unsupported',
      }),
    ).toBe('ios-needs-install');
  });

  it('an INSTALLED iOS app falls through to the permission, which is the point of installing', () => {
    expect(
      resolveNotificationCapability({
        ...HEALTHY,
        isIos: true,
        isStandalone: true,
        permission: 'default',
      }),
    ).toBe('default');
  });

  it('ios-needs-install beats denied - there is no permission to un-block until it is installed', () => {
    expect(
      resolveNotificationCapability({
        ...HEALTHY,
        isIos: true,
        isStandalone: false,
        permission: 'denied',
      }),
    ).toBe('ios-needs-install');
  });

  // =========================================================================
  // THE REGISTRATION IS EVALUATED AGAINST THE PERMISSION, NOT AHEAD OF IT
  // =========================================================================
  // The first draft of this hook let a missing registration preempt every
  // permission state, and that deadlocks a real user: the "Allow notifications"
  // button renders in `default` and NOWHERE else, so a user whose worker failed
  // to register could never reach the prompt and therefore never leave
  // `default`. #222's `showAppNotification` falls back to `new Notification()`
  // when there is no registration - a fallback built for exactly this case -
  // and that ordering would have made it unreachable on any profile that had
  // not already granted. Granting is a prerequisite for BOTH delivery paths.

  it('default + NO registration is still default - the prompt must stay reachable', () => {
    expect(
      resolveNotificationCapability({
        ...HEALTHY,
        permission: 'default',
        hasServiceWorkerRegistration: false,
      }),
    ).toBe('default');
  });

  it('denied + NO registration is still denied - un-blocking is the remedy that comes first', () => {
    expect(
      resolveNotificationCapability({
        ...HEALTHY,
        permission: 'denied',
        hasServiceWorkerRegistration: false,
      }),
    ).toBe('denied');
  });

  it('granted + NO registration is sw-unavailable - granted-but-degraded', () => {
    expect(
      resolveNotificationCapability({
        ...HEALTHY,
        permission: 'granted',
        hasServiceWorkerRegistration: false,
      }),
    ).toBe('sw-unavailable');
  });

  it('granted + a registration is plain granted', () => {
    expect(
      resolveNotificationCapability({
        ...HEALTHY,
        permission: 'granted',
        hasServiceWorkerRegistration: true,
      }),
    ).toBe('granted');
  });

  it('unsupported requires BOTH APIs missing - one of the two present is not hopeless', () => {
    // Notification present, serviceWorker gone: a desktop browser with no
    // worker, which is degraded (the page-level fallback still works), not
    // incapable. HEALTHY's permission is `granted`, so it lands on the
    // granted-but-degraded arm rather than on `unsupported`.
    expect(
      resolveNotificationCapability({
        ...HEALTHY,
        hasServiceWorkerApi: false,
        hasServiceWorkerRegistration: false,
      }),
    ).toBe('sw-unavailable');

    // ...and the same device before permission has been asked for is plain
    // `default`, so the prompt is offered and the fallback becomes usable.
    expect(
      resolveNotificationCapability({
        ...HEALTHY,
        hasServiceWorkerApi: false,
        hasServiceWorkerRegistration: false,
        permission: 'default',
      }),
    ).toBe('default');
  });

  it('an unreadable permission at the end of the chain is reported as unsupported, not as default', () => {
    // The one case rule 3 deliberately lets through: `serviceWorker` exists so
    // it is not "hopeless", but `Notification.permission` cannot be read, and
    // guessing `default` there would offer a prompt that cannot be raised.
    expect(
      resolveNotificationCapability({
        ...HEALTHY,
        hasNotificationApi: false,
        permission: 'unsupported',
      }),
    ).toBe('unsupported');
  });
});

// ---------------------------------------------------------------------------
// The hook, over real (stubbed) globals
// ---------------------------------------------------------------------------

describe('useNotificationCapability', () => {
  it('reports granted on a healthy desktop', async () => {
    setHealthyDesktop('granted');

    const { result } = renderHook(() => useNotificationCapability());

    await waitFor(() => expect(result.current.capability).toBe('granted'));
  });

  it('reports default, and passes the raw permission through unchanged', async () => {
    setHealthyDesktop('default');

    const { result } = renderHook(() => useNotificationCapability());

    await waitFor(() => expect(result.current.capability).toBe('default'));
    expect(result.current.permission).toBe('default');
  });

  it('reports denied', async () => {
    setHealthyDesktop('denied');

    const { result } = renderHook(() => useNotificationCapability());

    await waitFor(() => expect(result.current.capability).toBe('denied'));
  });

  it('reports admin-disabled when the option says so, whatever the browser thinks', async () => {
    setHealthyDesktop('granted');

    const { result } = renderHook(() => useNotificationCapability({ adminDisabled: true }));

    await waitFor(() => expect(result.current.capability).toBe('admin-disabled'));
    // The browser's own opinion is still readable - the two claims are not the
    // same, and a caller that needs the raw one should not have to reach
    // around this hook.
    expect(result.current.permission).toBe('granted');
  });

  it('reports insecure-context when window.isSecureContext is explicitly false', async () => {
    setHealthyDesktop('granted');
    setSecureContext(false);

    const { result } = renderHook(() => useNotificationCapability());

    await waitFor(() => expect(result.current.capability).toBe('insecure-context'));
  });

  it('does NOT report insecure-context merely because isSecureContext is unimplemented', async () => {
    // jsdom (and any pre-2016 browser) has no such property. `!undefined`
    // would send every one of them to "switch to HTTPS", which is the wrong
    // remedy stated with total confidence.
    setHealthyDesktop('granted');
    setSecureContext(undefined);

    const { result } = renderHook(() => useNotificationCapability());

    await waitFor(() => expect(result.current.capability).toBe('granted'));
  });

  it('reports unsupported when neither Notification nor serviceWorker exists', async () => {
    setHealthyDesktop('granted');
    setNotification('absent');
    setServiceWorker('absent');

    const { result } = renderHook(() => useNotificationCapability());

    await waitFor(() => expect(result.current.capability).toBe('unsupported'));
  });

  it('reports unsupported when reading Notification.permission throws and there is no worker API', async () => {
    setHealthyDesktop('granted');
    setNotification('granted', { throwOnRead: true });
    setServiceWorker('absent');

    const { result } = renderHook(() => useNotificationCapability());

    await waitFor(() => expect(result.current.capability).toBe('unsupported'));
  });

  it('reports ios-needs-install for an iPhone in a Safari tab - not unsupported', async () => {
    setIphoneTab();

    const { result } = renderHook(() => useNotificationCapability());

    await waitFor(() => expect(result.current.capability).toBe('ios-needs-install'));
  });

  // THE CASE A NAIVE USER-AGENT TEST GETS WRONG, and the one most likely to
  // ship broken: since iPadOS 13 Safari reports a Macintosh UA and
  // `platform === 'MacIntel'`, so `/iPad/.test(userAgent)` classifies every
  // modern iPad as a desktop Mac - on hardware the developer does not have.
  it('detects an iPadOS device that reports itself as a Mac (MacIntel + maxTouchPoints > 1)', async () => {
    setIpadClaimingToBeAMac();

    const { result } = renderHook(() => useNotificationCapability());

    await waitFor(() => expect(result.current.capability).toBe('ios-needs-install'));
  });

  it('does not mistake a REAL Mac for an iPad - same platform, no touch', async () => {
    setHealthyDesktop('granted');
    setNavigator('platform', 'MacIntel');
    setNavigator(
      'userAgent',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    );
    setNavigator('maxTouchPoints', 0);

    const { result } = renderHook(() => useNotificationCapability());

    await waitFor(() => expect(result.current.capability).toBe('granted'));
  });

  it('an iOS device launched from the Home Screen (navigator.standalone) falls through to the permission', async () => {
    setIphoneTab();
    // Installed: `Notification` exists there, and Safari's own non-standard
    // flag is the only signal older iOS gives.
    setNotification('default');
    setNavigator('standalone', true);

    const { result } = renderHook(() => useNotificationCapability());

    await waitFor(() => expect(result.current.capability).toBe('default'));
  });

  it('an installed app detected through display-mode: standalone also falls through', async () => {
    setIphoneTab();
    setNotification('granted');
    window.matchMedia = ((query: string) =>
      ({
        media: query,
        matches: query.includes('display-mode: standalone'),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        onchange: null,
        dispatchEvent: vi.fn(),
      })) as unknown as typeof window.matchMedia;

    const { result } = renderHook(() => useNotificationCapability());

    await waitFor(() => expect(result.current.capability).toBe('granted'));
  });

  describe('the service worker registration', () => {
    it('reports sw-unavailable when getRegistration resolves with nothing', async () => {
      setHealthyDesktop('granted');
      setServiceWorker('unregistered');

      const { result } = renderHook(() => useNotificationCapability());

      await waitFor(() => expect(result.current.capability).toBe('sw-unavailable'));
    });

    // The end-to-end shape of the deadlock the precedence fix avoids: a user
    // whose worker never registered must still be offered the prompt, or they
    // can never grant permission and #222's page-level fallback can never run.
    it('a device with NO registration that has not been asked yet reports default, not sw-unavailable', async () => {
      setHealthyDesktop('default');
      const sw = setServiceWorker('unregistered')!;

      const { result } = renderHook(() => useNotificationCapability());

      // Waited until the probe has actually reported "no registration", so
      // this cannot pass merely because the answer was still unknown - which
      // is the only way it could pass for the wrong reason.
      await waitFor(() => expect(sw.getRegistration).toHaveBeenCalled());
      await act(async () => {});

      expect(result.current.capability).toBe('default');
    });

    it('reports sw-unavailable when getRegistration rejects outright', async () => {
      setHealthyDesktop('granted');
      setServiceWorker('rejects');

      const { result } = renderHook(() => useNotificationCapability());

      await waitFor(() => expect(result.current.capability).toBe('sw-unavailable'));
    });

    it('reports sw-unavailable when the serviceWorker API is missing but Notification is not', async () => {
      setHealthyDesktop('granted');
      setServiceWorker('absent');

      const { result } = renderHook(() => useNotificationCapability());

      await waitFor(() => expect(result.current.capability).toBe('sw-unavailable'));
    });

    // A warning that appears on every load and then retracts itself teaches
    // users to ignore warnings, so the not-yet-known answer must render as
    // "fine" rather than as "degraded".
    it('does not flash sw-unavailable on the first render while getRegistration is still in flight', () => {
      setHealthyDesktop('granted');
      setServiceWorker('unregistered');

      const { result } = renderHook(() => useNotificationCapability());

      expect(result.current.capability).toBe('granted');
    });

    it('a controlling worker is proof of registration without awaiting anything', async () => {
      setHealthyDesktop('granted');
      const sw = setServiceWorker('unregistered')!;
      sw.controller = {};

      const { result } = renderHook(() => useNotificationCapability());

      await waitFor(() => expect(result.current.capability).toBe('granted'));
      expect(sw.getRegistration).not.toHaveBeenCalled();
    });

    it('refresh() re-probes the registration, so a worker that registers late is picked up', async () => {
      setHealthyDesktop('granted');
      const sw = setServiceWorker('unregistered')!;

      const { result } = renderHook(() => useNotificationCapability());
      await waitFor(() => expect(result.current.capability).toBe('sw-unavailable'));

      sw.getRegistration.mockResolvedValue({} as ServiceWorkerRegistration);
      act(() => {
        result.current.refresh();
      });

      await waitFor(() => expect(result.current.capability).toBe('granted'));
    });
  });

  it('re-reads on visibilitychange, inheriting the underlying hook\'s tracking rather than repeating it', async () => {
    setHealthyDesktop('default');
    const { result } = renderHook(() => useNotificationCapability());

    await waitFor(() => expect(result.current.capability).toBe('default'));

    (window as any).Notification.permission = 'granted';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await waitFor(() => expect(result.current.capability).toBe('granted'));
  });

  // =========================================================================
  // THE GUARANTEE THIS LAYER MUST NOT BREAK
  // =========================================================================
  // `useBrowserNotificationPermission` has a dedicated test asserting it never
  // calls `requestPermission()`; that test still passes, but it cannot see
  // this file. A layer added ON TOP of it could reintroduce exactly the bug
  // that hook was written to prevent - a prompt fired on mount, spending a
  // one-shot and effectively permanent resource on a user who never asked -
  // so the prohibition is re-asserted here, through the composed hook.
  it('never calls Notification.requestPermission - not on mount, refresh, or visibilitychange', async () => {
    const requestPermission = setHealthyDesktop('default');

    const { result } = renderHook(() => useNotificationCapability());
    await waitFor(() => expect(result.current.capability).toBe('default'));
    expect(requestPermission).not.toHaveBeenCalled();

    act(() => {
      result.current.refresh();
    });
    expect(requestPermission).not.toHaveBeenCalled();

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('never calls Notification.requestPermission in the ios-needs-install state either', async () => {
    setIphoneTab();
    // An installed-app-shaped Notification present alongside the iOS signals,
    // so there is something that COULD be called if the hook were careless.
    const requestPermission = setNotification('default');

    const { result } = renderHook(() => useNotificationCapability());

    await waitFor(() => expect(result.current.capability).toBe('ios-needs-install'));
    expect(requestPermission).not.toHaveBeenCalled();
  });
});
