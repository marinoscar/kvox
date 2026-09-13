import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  urlBase64ToUint8Array,
  syncPushSubscription,
  requestPermissionAndSyncPush,
  removePushSubscription,
  claimAutoPermissionPrompt,
  resetPushSubscriptionStateForTests,
} from '../../services/pushSubscription';
import { subscribePushNotifications, unsubscribePushNotifications } from '../../services/api';
import { requestBrowserNotificationPermission } from '../../services/browserNotifications';
import type { NotificationConfigResponse } from '../../types';

/**
 * Issue #365, epic #215. `services/pushSubscription.ts` is the missing half
 * that made `push_subscriptions` stay empty forever: nothing ever called
 * `pushManager.subscribe()` or POSTed the result. See that file's own header
 * for the full design (why the sync runs on every boot, why nothing here
 * throws, why a definite key mismatch forces unsubscribe-then-resubscribe).
 *
 * Mocking idiom follows `browserNotifications.test.ts`: `window.Notification`
 * and `navigator.serviceWorker` are reassigned per test over the neutral
 * defaults `setup.ts` installs before every test, and `services/api` /
 * `services/browserNotifications` are mocked wholesale since this module's
 * whole job is orchestrating calls to them, not re-implementing them.
 */

vi.mock('../../services/api', () => ({
  subscribePushNotifications: vi.fn(),
  unsubscribePushNotifications: vi.fn(),
}));

vi.mock('../../services/browserNotifications', () => ({
  requestBrowserNotificationPermission: vi.fn(),
}));

const mockSubscribe = vi.mocked(subscribePushNotifications);
const mockUnsubscribe = vi.mocked(unsubscribePushNotifications);
const mockRequestPermission = vi.mocked(requestBrowserNotificationPermission);

// A real-shaped VAPID public key (URL-safe base64, no padding) so the byte
// comparisons below are exercising the actual decode path, not a trivial
// fixture.
const VAPID_KEY = 'BEl62iUYgUivxIkv69yViEuiBIa1HI0DLQCHUp2ZfmZC';

function setPermission(permission: NotificationPermission | 'absent'): void {
  if (permission === 'absent') {
    delete (window as any).Notification;
    return;
  }
  Object.defineProperty(window, 'Notification', {
    configurable: true,
    writable: true,
    value: { permission, requestPermission: vi.fn() },
  });
}

/** `'PushManager' in window` — the other half of `hasPushSupport()`. */
function setPushManagerGlobal(present: boolean): void {
  if (present) {
    (window as any).PushManager = function PushManager() {};
  } else {
    delete (window as any).PushManager;
  }
}

interface FakePushManager {
  getSubscription: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
}

function makePushManager(overrides: Partial<FakePushManager> = {}): FakePushManager {
  return {
    getSubscription: vi.fn().mockResolvedValue(null),
    subscribe: vi.fn(),
    ...overrides,
  };
}

/**
 * `navigator.serviceWorker`. `ready` drives `syncPushSubscription`;
 * `getRegistration` drives `removePushSubscription` (deliberately different —
 * see that function's own header for why it uses `getRegistration` and not
 * `.ready`).
 */
function setServiceWorker(opts: {
  ready?: Promise<any>;
  getRegistration?: ReturnType<typeof vi.fn>;
} = {}): void {
  Object.defineProperty(window.navigator, 'serviceWorker', {
    configurable: true,
    writable: true,
    value: {
      ready: opts.ready ?? new Promise(() => {}),
      controller: null,
      getRegistration: opts.getRegistration ?? vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
}

function deleteServiceWorker(): void {
  delete (window.navigator as any).serviceWorker;
}

/**
 * A fake `PushSubscription`.
 *
 * `keyBytes`: `undefined` (default) omits `options` entirely — some browsers
 * expose no `options` at all; `null` sets `options.applicationServerKey` to
 * `null` — the browser exposes `options` but not the key. Both are DEFINITE
 * NON-mismatches per `subscriptionUsesKey`'s contract (only a definite
 * mismatch counts). A `Uint8Array` sets a real key for a genuine match/mismatch
 * comparison. `hasOptions: false` removes the `options` property outright,
 * covering the "no options key at all" shape distinctly from
 * "options present, key null".
 */
function makeSubscription(opts: {
  endpoint?: string;
  keyBytes?: Uint8Array | null;
  hasOptions?: boolean;
} = {}) {
  const endpoint = opts.endpoint ?? 'https://push.example.com/sub';
  const json = { endpoint, keys: { p256dh: 'p256dh-value', auth: 'auth-value' } };
  const subscription: any = {
    endpoint,
    toJSON: vi.fn().mockReturnValue(json),
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
  if (opts.hasOptions !== false) {
    subscription.options = {
      applicationServerKey: opts.keyBytes === undefined ? undefined : opts.keyBytes ? opts.keyBytes.buffer : null,
    };
  }
  return subscription;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPushSubscriptionStateForTests();

  // Sane defaults for every test; individual tests override as needed.
  mockSubscribe.mockResolvedValue({ id: 'sub-1', endpoint: 'https://push.example.com/sub', createdAt: '2026-01-01T00:00:00.000Z' });
  mockUnsubscribe.mockResolvedValue(undefined);
  mockRequestPermission.mockResolvedValue('default');

  // `hasPushSupport()` is false by default (setup.ts provides
  // `navigator.serviceWorker` but never `window.PushManager`), so every test
  // that expects real work to happen must opt in explicitly.
  setPushManagerGlobal(false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('urlBase64ToUint8Array', () => {
  it.each([1, 2, 3, 4, 5, 16, 65])(
    'round-trips a %i-byte payload through URL-safe base64 without padding',
    (length) => {
      const original = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) original[i] = (i * 37 + 5) % 256;

      const standardB64 = window.btoa(String.fromCharCode(...original));
      const urlSafeNoPad = standardB64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

      const decoded = urlBase64ToUint8Array(urlSafeNoPad);

      expect(Array.from(decoded)).toEqual(Array.from(original));
    },
  );

  it('treats "-" as "+" and "_" as "/" — the URL-safe alphabet', () => {
    // Bytes chosen (by hand-computed base64) so the STANDARD encoding is
    // exactly "+///": 0xFB,0xFF,0xFF -> 111110 111111 111111 111111 ->
    // indices 62,63,63,63 -> '+','/','/','/'.
    const original = new Uint8Array([0xfb, 0xff, 0xff]);
    expect(window.btoa(String.fromCharCode(...original))).toBe('+///');

    const decoded = urlBase64ToUint8Array('-___');

    expect(Array.from(decoded)).toEqual([0xfb, 0xff, 0xff]);
  });

  it('adds back the padding a URL-safe key travels without', () => {
    // A single byte's standard base64 is 4 chars including "==" padding;
    // VAPID keys travel without it.
    const original = new Uint8Array([200]);
    const standardB64 = window.btoa(String.fromCharCode(...original)); // e.g. "yA=="
    const noPad = standardB64.replace(/=+$/, '');

    expect(Array.from(urlBase64ToUint8Array(noPad))).toEqual([200]);
  });
});

describe('syncPushSubscription', () => {
  describe('no-op conditions', () => {
    it('no-ops when window has no PushManager', async () => {
      setPermission('granted');
      setPushManagerGlobal(false);

      await syncPushSubscription(VAPID_KEY);

      expect(mockSubscribe).not.toHaveBeenCalled();
    });

    it('no-ops when navigator has no serviceWorker', async () => {
      setPermission('granted');
      setPushManagerGlobal(true);
      deleteServiceWorker();

      await syncPushSubscription(VAPID_KEY);

      expect(mockSubscribe).not.toHaveBeenCalled();
    });

    it.each(['default', 'denied', 'absent'] as const)(
      'no-ops when permission is %s',
      async (permission) => {
        setPermission(permission);
        setPushManagerGlobal(true);
        setServiceWorker({ ready: Promise.resolve({ pushManager: makePushManager() }) });

        await syncPushSubscription(VAPID_KEY);

        expect(mockSubscribe).not.toHaveBeenCalled();
      },
    );

    it('warns and no-ops when the ready registration has no pushManager', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      setPermission('granted');
      setPushManagerGlobal(true);
      setServiceWorker({ ready: Promise.resolve({}) });

      await syncPushSubscription(VAPID_KEY);

      expect(warnSpy).toHaveBeenCalled();
      expect(mockSubscribe).not.toHaveBeenCalled();
    });
  });

  describe('subscribing', () => {
    it('subscribes with userVisibleOnly: true and the decoded key, then POSTs toJSON()', async () => {
      const expectedBytes = urlBase64ToUint8Array(VAPID_KEY);
      const newSubscription = makeSubscription({ endpoint: 'https://push.example.com/new' });
      const pushManager = makePushManager({
        getSubscription: vi.fn().mockResolvedValue(null),
        subscribe: vi.fn().mockResolvedValue(newSubscription),
      });
      setPermission('granted');
      setPushManagerGlobal(true);
      setServiceWorker({ ready: Promise.resolve({ pushManager }) });

      await syncPushSubscription(VAPID_KEY);

      expect(pushManager.subscribe).toHaveBeenCalledTimes(1);
      const arg = pushManager.subscribe.mock.calls[0][0];
      expect(arg.userVisibleOnly).toBe(true);
      expect(Array.from(arg.applicationServerKey as Uint8Array)).toEqual(Array.from(expectedBytes));

      expect(mockSubscribe).toHaveBeenCalledWith(newSubscription.toJSON());
    });

    it('only POSTs — no unsubscribe, no resubscribe — when an existing subscription already uses this key', async () => {
      const bytes = urlBase64ToUint8Array(VAPID_KEY);
      const existing = makeSubscription({ endpoint: 'https://push.example.com/existing', keyBytes: bytes });
      const pushManager = makePushManager({ getSubscription: vi.fn().mockResolvedValue(existing) });
      setPermission('granted');
      setPushManagerGlobal(true);
      setServiceWorker({ ready: Promise.resolve({ pushManager }) });

      await syncPushSubscription(VAPID_KEY);

      expect(existing.unsubscribe).not.toHaveBeenCalled();
      expect(pushManager.subscribe).not.toHaveBeenCalled();
      expect(mockSubscribe).toHaveBeenCalledWith(existing.toJSON());
    });

    it('unsubscribes and resubscribes on a definite key mismatch (VAPID rotation)', async () => {
      const oldKeyBytes = new Uint8Array([1, 2, 3, 4]);
      const existing = makeSubscription({ endpoint: 'https://push.example.com/old', keyBytes: oldKeyBytes });
      const resubscribed = makeSubscription({ endpoint: 'https://push.example.com/new' });
      const pushManager = makePushManager({
        getSubscription: vi.fn().mockResolvedValue(existing),
        subscribe: vi.fn().mockResolvedValue(resubscribed),
      });
      setPermission('granted');
      setPushManagerGlobal(true);
      setServiceWorker({ ready: Promise.resolve({ pushManager }) });

      await syncPushSubscription(VAPID_KEY);

      expect(existing.unsubscribe).toHaveBeenCalledTimes(1);
      expect(pushManager.subscribe).toHaveBeenCalledTimes(1);
      expect(mockSubscribe).toHaveBeenCalledWith(resubscribed.toJSON());
    });

    it('keeps the existing subscription when options.applicationServerKey is null (browser does not expose it)', async () => {
      const existing = makeSubscription({ endpoint: 'https://push.example.com/legacy', keyBytes: null });
      const pushManager = makePushManager({ getSubscription: vi.fn().mockResolvedValue(existing) });
      setPermission('granted');
      setPushManagerGlobal(true);
      setServiceWorker({ ready: Promise.resolve({ pushManager }) });

      await syncPushSubscription(VAPID_KEY);

      expect(existing.unsubscribe).not.toHaveBeenCalled();
      expect(pushManager.subscribe).not.toHaveBeenCalled();
      expect(mockSubscribe).toHaveBeenCalledWith(existing.toJSON());
    });

    it('keeps the existing subscription when it exposes no options object at all', async () => {
      const existing = makeSubscription({ endpoint: 'https://push.example.com/legacy2', hasOptions: false });
      const pushManager = makePushManager({ getSubscription: vi.fn().mockResolvedValue(existing) });
      setPermission('granted');
      setPushManagerGlobal(true);
      setServiceWorker({ ready: Promise.resolve({ pushManager }) });

      await syncPushSubscription(VAPID_KEY);

      expect(pushManager.subscribe).not.toHaveBeenCalled();
      expect(mockSubscribe).toHaveBeenCalledWith(existing.toJSON());
    });
  });

  describe('the .ready timeout', () => {
    it('warns and resolves instead of hanging when navigator.serviceWorker.ready never settles', async () => {
      vi.useFakeTimers();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      setPermission('granted');
      setPushManagerGlobal(true);
      setServiceWorker({ ready: new Promise(() => {}) });

      const syncPromise = syncPushSubscription(VAPID_KEY);

      await vi.advanceTimersByTimeAsync(10_000);
      await syncPromise;

      expect(warnSpy).toHaveBeenCalled();
      expect(mockSubscribe).not.toHaveBeenCalled();
    });
  });

  describe('errors are swallowed', () => {
    it('warns and does not throw when subscribe() rejects', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const pushManager = makePushManager({
        getSubscription: vi.fn().mockResolvedValue(null),
        subscribe: vi.fn().mockRejectedValue(new Error('permission dismissed mid-flow')),
      });
      setPermission('granted');
      setPushManagerGlobal(true);
      setServiceWorker({ ready: Promise.resolve({ pushManager }) });

      await expect(syncPushSubscription(VAPID_KEY)).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalled();
      expect(mockSubscribe).not.toHaveBeenCalled();
    });

    it('warns and does not throw when the POST to the server rejects', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const pushManager = makePushManager({
        getSubscription: vi.fn().mockResolvedValue(null),
        subscribe: vi.fn().mockResolvedValue(makeSubscription()),
      });
      setPermission('granted');
      setPushManagerGlobal(true);
      setServiceWorker({ ready: Promise.resolve({ pushManager }) });
      mockSubscribe.mockRejectedValue(new Error('409 push disabled'));

      await expect(syncPushSubscription(VAPID_KEY)).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalled();
    });
  });

  describe('concurrency', () => {
    it('shares one in-flight sync across concurrent calls, resulting in exactly one POST', async () => {
      const pushManager = makePushManager({
        getSubscription: vi.fn().mockResolvedValue(null),
        subscribe: vi.fn().mockResolvedValue(makeSubscription({ endpoint: 'https://push.example.com/shared' })),
      });
      setPermission('granted');
      setPushManagerGlobal(true);
      setServiceWorker({ ready: Promise.resolve({ pushManager }) });

      const p1 = syncPushSubscription(VAPID_KEY);
      const p2 = syncPushSubscription(VAPID_KEY);

      expect(p1).toBe(p2);

      await Promise.all([p1, p2]);

      expect(pushManager.getSubscription).toHaveBeenCalledTimes(1);
      expect(pushManager.subscribe).toHaveBeenCalledTimes(1);
      expect(mockSubscribe).toHaveBeenCalledTimes(1);
    });

    it('allows a fresh sync once the previous one has settled', async () => {
      const pushManager = makePushManager({
        getSubscription: vi.fn().mockResolvedValue(null),
        subscribe: vi.fn().mockResolvedValue(makeSubscription({ endpoint: 'https://push.example.com/first' })),
      });
      setPermission('granted');
      setPushManagerGlobal(true);
      setServiceWorker({ ready: Promise.resolve({ pushManager }) });

      await syncPushSubscription(VAPID_KEY);
      await syncPushSubscription(VAPID_KEY);

      expect(mockSubscribe).toHaveBeenCalledTimes(2);
    });
  });
});

describe('requestPermissionAndSyncPush', () => {
  it('returns whatever requestBrowserNotificationPermission resolves', async () => {
    mockRequestPermission.mockResolvedValue('denied');

    const result = await requestPermissionAndSyncPush({
      browserEnabled: true,
      pushEnabled: true,
      vapidPublicKey: VAPID_KEY,
    });

    expect(result).toBe('denied');
  });

  it('syncs when the result is granted, pushEnabled is true, and a key is present', async () => {
    mockRequestPermission.mockResolvedValue('granted');
    setPermission('granted');
    setPushManagerGlobal(true);
    const pushManager = makePushManager({
      getSubscription: vi.fn().mockResolvedValue(null),
      subscribe: vi.fn().mockResolvedValue(makeSubscription()),
    });
    setServiceWorker({ ready: Promise.resolve({ pushManager }) });

    await requestPermissionAndSyncPush({ browserEnabled: true, pushEnabled: true, vapidPublicKey: VAPID_KEY });
    // The sync is deliberately not awaited by the function under test (`void
    // syncPushSubscription(...)`) — flush the microtask queue it runs on.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockSubscribe).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['granted result but pushEnabled: false', 'granted', { browserEnabled: true, pushEnabled: false, vapidPublicKey: VAPID_KEY }],
    ['granted result but vapidPublicKey: null', 'granted', { browserEnabled: true, pushEnabled: true, vapidPublicKey: null }],
    ['a denied result', 'denied', { browserEnabled: true, pushEnabled: true, vapidPublicKey: VAPID_KEY }],
    ['a default (dismissed) result', 'default', { browserEnabled: true, pushEnabled: true, vapidPublicKey: VAPID_KEY }],
  ] as const)('does not sync for %s', async (_label, permissionResult, config) => {
    mockRequestPermission.mockResolvedValue(permissionResult as NotificationPermission);

    await requestPermissionAndSyncPush(config as NotificationConfigResponse);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it('does not sync, and does not throw, when config is null', async () => {
    mockRequestPermission.mockResolvedValue('granted');

    await expect(requestPermissionAndSyncPush(null)).resolves.toBe('granted');
    expect(mockSubscribe).not.toHaveBeenCalled();
  });
});

describe('removePushSubscription', () => {
  it('DELETEs using the subscription endpoint when one exists', async () => {
    const existing = makeSubscription({ endpoint: 'https://push.example.com/logout-target' });
    const pushManager = { getSubscription: vi.fn().mockResolvedValue(existing) };
    setPushManagerGlobal(true);
    setServiceWorker({ getRegistration: vi.fn().mockResolvedValue({ pushManager }) });

    await removePushSubscription();

    expect(mockUnsubscribe).toHaveBeenCalledWith('https://push.example.com/logout-target');
  });

  it('no-ops without throwing when there is no subscription', async () => {
    const pushManager = { getSubscription: vi.fn().mockResolvedValue(null) };
    setPushManagerGlobal(true);
    setServiceWorker({ getRegistration: vi.fn().mockResolvedValue({ pushManager }) });

    await expect(removePushSubscription()).resolves.toBeUndefined();
    expect(mockUnsubscribe).not.toHaveBeenCalled();
  });

  it('no-ops when there is no service worker registration at all', async () => {
    setPushManagerGlobal(true);
    setServiceWorker({ getRegistration: vi.fn().mockResolvedValue(undefined) });

    await removePushSubscription();

    expect(mockUnsubscribe).not.toHaveBeenCalled();
  });

  it('returns immediately, touching nothing, when push is unsupported', async () => {
    setPushManagerGlobal(false);
    const getRegistration = vi.fn();
    setServiceWorker({ getRegistration });

    await removePushSubscription();

    expect(getRegistration).not.toHaveBeenCalled();
    expect(mockUnsubscribe).not.toHaveBeenCalled();
  });

  it('swallows a rejected DELETE and resolves normally, with a console.warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const existing = makeSubscription({ endpoint: 'https://push.example.com/gone' });
    const pushManager = { getSubscription: vi.fn().mockResolvedValue(existing) };
    setPushManagerGlobal(true);
    setServiceWorker({ getRegistration: vi.fn().mockResolvedValue({ pushManager }) });
    mockUnsubscribe.mockRejectedValue(new Error('404 not found'));

    await expect(removePushSubscription()).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalled();
  });

  it('resolves via its own 3s timeout instead of hanging when getRegistration never settles', async () => {
    vi.useFakeTimers();
    setPushManagerGlobal(true);
    setServiceWorker({ getRegistration: vi.fn(() => new Promise(() => {})) });

    const removePromise = removePushSubscription();
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(removePromise).resolves.toBeUndefined();
    expect(mockUnsubscribe).not.toHaveBeenCalled();
  });
});

describe('claimAutoPermissionPrompt', () => {
  it('returns true exactly once per (simulated) page load, then false until reset', () => {
    expect(claimAutoPermissionPrompt()).toBe(true);
    expect(claimAutoPermissionPrompt()).toBe(false);
    expect(claimAutoPermissionPrompt()).toBe(false);
  });

  it('resetPushSubscriptionStateForTests() re-arms the one-shot prompt', () => {
    expect(claimAutoPermissionPrompt()).toBe(true);
    expect(claimAutoPermissionPrompt()).toBe(false);

    resetPushSubscriptionStateForTests();

    expect(claimAutoPermissionPrompt()).toBe(true);
  });
});
