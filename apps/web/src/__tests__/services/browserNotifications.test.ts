import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  requestBrowserNotificationPermission,
  showAppNotification,
} from '../../services/browserNotifications';
import type { AppNotification } from '../../types';

/**
 * Issue #127, epic #109. Issue #222 adds the service-worker delivery path.
 *
 * This module is DECORATION - the notification centre behind the bell is the
 * durable feature, and everything here must degrade silently: unsupported
 * browsers, denied permission, a constructor that throws (Android Chrome,
 * where `Notification` is service-worker-only pre-#222), a service worker
 * registration that rejects, and a `showNotification()` that throws are all
 * supported outcomes, never exceptions that escape to a caller.
 *
 * Mocking idiom follows `useBrowserNotificationPermission.test.ts` for
 * `window.Notification`, and `useNotificationCapability.test.ts`'s
 * `setServiceWorker` for `navigator.serviceWorker` - both replaced per test
 * with a fake supplying only what each test needs, restored afterward.
 */

// `window.Notification` and `navigator.serviceWorker` are no longer captured
// or restored here - `setup.ts` installs a fresh neutral default for both
// before every test (issue #232), so `setNotification`/`setServiceWorker`
// below just reassign over that default per test, exactly as they always
// have, and the next test starts from a clean baseline without this file
// needing to remember what was here before it ran.

interface FakeNotificationInstance {
  onclick: (() => void) | null;
  close: ReturnType<typeof vi.fn>;
}

function setNotification(
  permission: 'granted' | 'denied' | 'default' | 'absent',
  opts: {
    requestPermissionImpl?: () => Promise<NotificationPermission> | NotificationPermission;
    constructorImpl?: (title: string, options?: NotificationOptions) => FakeNotificationInstance;
    throwOnConstruct?: boolean;
  } = {},
) {
  if (permission === 'absent') {
    delete (window as any).Notification;
    return { requestPermission: undefined, ctor: undefined };
  }

  const requestPermission = vi.fn(
    opts.requestPermissionImpl ?? (() => Promise.resolve(permission)),
  );

  const instances: FakeNotificationInstance[] = [];
  const ctor = vi.fn(function (
    this: FakeNotificationInstance,
    title: string,
    options?: NotificationOptions,
  ) {
    if (opts.throwOnConstruct) {
      throw new Error('Notification is not supported in this context');
    }
    const instance: FakeNotificationInstance = { onclick: null, close: vi.fn() };
    if (opts.constructorImpl) {
      const custom = opts.constructorImpl(title, options);
      Object.assign(instance, custom);
    }
    Object.assign(this, instance);
    instances.push(this as unknown as FakeNotificationInstance);
    return this;
  });

  (ctor as any).permission = permission;
  (ctor as any).requestPermission = requestPermission;

  (window as any).Notification = ctor;

  return { requestPermission, ctor, instances };
}

/**
 * `navigator.serviceWorker`, mirroring `useNotificationCapability.test.ts`'s
 * `setServiceWorker`:
 *
 * - `'absent'` deletes the property entirely - `'serviceWorker' in navigator`
 *   is `false`, the real shape of a browser with no SW API at all.
 * - `'unregistered'` keeps the API but resolves `getRegistration()` with
 *   `undefined` - the real shape of "the worker never registered".
 * - `'registered'` resolves with a registration whose `showNotification` is a
 *   spy that resolves.
 * - `'rejects'` rejects `getRegistration()` itself.
 * - `'showThrows'` resolves a registration whose `showNotification()` rejects
 *   - a SW that exists but refuses the call (mid-update, browser bug).
 * - `'registeredNoGetNotifications'` is `'registered'` but with no
 *   `getNotifications` method at all - the shape of an embedded WebView whose
 *   registration object has gaps (#224's defensive `typeof` guard).
 *
 * `registered` and `registeredNoGetNotifications` accept a `getNotificationsResult`
 * (#224) - the array `registration.getNotifications({ tag })` resolves with,
 * defaulting to empty (no existing toast with this tag).
 */
function setServiceWorker(
  state:
    | 'absent'
    | 'unregistered'
    | 'registered'
    | 'rejects'
    | 'showThrows'
    | 'registeredNoGetNotifications',
  opts: { getNotificationsResult?: unknown[] } = {},
) {
  if (state === 'absent') {
    delete (window.navigator as any).serviceWorker;
    return null;
  }

  const showNotification = vi.fn(() =>
    state === 'showThrows'
      ? Promise.reject(new Error('registration mid-update'))
      : Promise.resolve(undefined),
  );

  const getNotifications = vi.fn(() => Promise.resolve(opts.getNotificationsResult ?? []));

  let registration: ServiceWorkerRegistration | undefined;
  if (state === 'registered' || state === 'showThrows') {
    registration = { showNotification, getNotifications } as unknown as ServiceWorkerRegistration;
  } else if (state === 'registeredNoGetNotifications') {
    // No `getNotifications` key at all, not merely one that returns undefined
    // - this is what the `typeof registration.getNotifications === 'function'`
    // guard in `showAppNotification` exists to survive.
    registration = { showNotification } as unknown as ServiceWorkerRegistration;
  }

  const getRegistration = vi.fn(() =>
    state === 'rejects'
      ? Promise.reject(new Error('storage partitioned'))
      : Promise.resolve(registration),
  );

  Object.defineProperty(window.navigator, 'serviceWorker', {
    value: { getRegistration },
    configurable: true,
    writable: true,
  });

  return { getRegistration, showNotification, getNotifications };
}

const baseNotification: AppNotification = {
  id: 'n1',
  eventKey: 'security.role_changed',
  title: 'Your role changed',
  body: 'You are now an Admin.',
  link: '/settings',
  readAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('browserNotifications', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('requestBrowserNotificationPermission', () => {
    it('returns null without throwing when Notification is unsupported', async () => {
      setNotification('absent');

      await expect(requestBrowserNotificationPermission()).resolves.toBeNull();
    });

    it('calls window.Notification.requestPermission() and returns its resolved value', async () => {
      const { requestPermission } = setNotification('default', {
        requestPermissionImpl: () => Promise.resolve('granted'),
      });

      const result = await requestBrowserNotificationPermission();

      expect(requestPermission).toHaveBeenCalledTimes(1);
      expect(result).toBe('granted');
    });

    it('catches a synchronous throw from requestPermission and returns null', async () => {
      setNotification('default', {
        requestPermissionImpl: () => {
          throw new Error('blocked');
        },
      });

      await expect(requestBrowserNotificationPermission()).resolves.toBeNull();
    });
  });

  describe('showAppNotification', () => {
    describe('permission gating', () => {
      it('resolves "none" when Notification is unsupported', async () => {
        setNotification('absent');
        const sw = setServiceWorker('registered');

        await expect(showAppNotification(baseNotification)).resolves.toBe('none');
        expect(sw!.getRegistration).not.toHaveBeenCalled();
      });

      it('resolves "none" and raises nothing when permission is "denied" - never requests either path', async () => {
        const { ctor } = setNotification('denied');
        const sw = setServiceWorker('registered');

        await expect(showAppNotification(baseNotification)).resolves.toBe('none');
        expect(sw!.getRegistration).not.toHaveBeenCalled();
        expect(ctor).not.toHaveBeenCalled();
      });

      it('resolves "none" and raises nothing when permission is "default" - never requests either path', async () => {
        const { ctor } = setNotification('default');
        const sw = setServiceWorker('registered');

        await expect(showAppNotification(baseNotification)).resolves.toBe('none');
        expect(sw!.getRegistration).not.toHaveBeenCalled();
        expect(ctor).not.toHaveBeenCalled();
      });
    });

    describe('service worker path (#222)', () => {
      it('is used whenever getRegistration() resolves a registration, and resolves "sw"', async () => {
        setNotification('granted');
        const sw = setServiceWorker('registered');

        const result = await showAppNotification(baseNotification);

        expect(result).toBe('sw');
        expect(sw!.showNotification).toHaveBeenCalledTimes(1);
      });

      it('calls registration.showNotification with icon, badge, data {id, link}, and tag set to the notification id', async () => {
        setNotification('granted');
        const sw = setServiceWorker('registered');

        await showAppNotification(baseNotification);

        expect(sw!.showNotification).toHaveBeenCalledWith(
          baseNotification.title,
          expect.objectContaining({
            body: baseNotification.body,
            tag: baseNotification.id,
            icon: '/icons/icon-192.png',
            badge: '/icons/badge-96.png',
            data: { id: baseNotification.id, link: baseNotification.link },
          }),
        );
      });

      it('does not fall back to the page path when the SW path succeeds', async () => {
        const { ctor } = setNotification('granted');
        setServiceWorker('registered');

        await showAppNotification(baseNotification);

        expect(ctor).not.toHaveBeenCalled();
      });
    });

    describe('cross-tab dedup via getNotifications (#224)', () => {
      it('resolves "none" and never calls showNotification when a toast with this tag already exists', async () => {
        setNotification('granted');
        const sw = setServiceWorker('registered', {
          getNotificationsResult: [{ tag: baseNotification.id }],
        });

        const result = await showAppNotification(baseNotification);

        expect(result).toBe('none');
        expect(sw!.getNotifications).toHaveBeenCalledWith({ tag: baseNotification.id });
        expect(sw!.showNotification).not.toHaveBeenCalled();
      });

      it('does not fall back to the page path either when a duplicate is found - the notification is already in the centre', async () => {
        const { ctor } = setNotification('granted');
        setServiceWorker('registered', { getNotificationsResult: [{ tag: baseNotification.id }] });

        await showAppNotification(baseNotification);

        expect(ctor).not.toHaveBeenCalled();
      });

      it('calls showNotification normally when getNotifications resolves empty - the existing happy path is unbroken', async () => {
        setNotification('granted');
        const sw = setServiceWorker('registered', { getNotificationsResult: [] });

        const result = await showAppNotification(baseNotification);

        expect(result).toBe('sw');
        expect(sw!.getNotifications).toHaveBeenCalledWith({ tag: baseNotification.id });
        expect(sw!.showNotification).toHaveBeenCalledTimes(1);
      });

      it('falls through to showNotification when getNotifications is not a function on the registration - the typeof guard degrades safely', async () => {
        setNotification('granted');
        const sw = setServiceWorker('registeredNoGetNotifications');

        const result = await showAppNotification(baseNotification);

        expect(result).toBe('sw');
        expect(sw!.showNotification).toHaveBeenCalledTimes(1);
      });
    });

    describe('page-Notification fallback', () => {
      it('is used when getRegistration() resolves no registration, and resolves "page"', async () => {
        const { ctor } = setNotification('granted');
        setServiceWorker('unregistered');

        const result = await showAppNotification(baseNotification);

        expect(result).toBe('page');
        expect(ctor).toHaveBeenCalledTimes(1);
      });

      it('is used when navigator.serviceWorker does not exist at all', async () => {
        const { ctor } = setNotification('granted');
        setServiceWorker('absent');

        const result = await showAppNotification(baseNotification);

        expect(result).toBe('page');
        expect(ctor).toHaveBeenCalledTimes(1);
      });

      it('is used, not "none", when getRegistration() rejects', async () => {
        const { ctor } = setNotification('granted');
        setServiceWorker('rejects');

        const result = await showAppNotification(baseNotification);

        expect(result).toBe('page');
        expect(ctor).toHaveBeenCalledTimes(1);
      });

      it('is used, not "none", when registration.showNotification() rejects', async () => {
        const { ctor } = setNotification('granted');
        const sw = setServiceWorker('showThrows');

        const result = await showAppNotification(baseNotification);

        expect(result).toBe('page');
        expect(sw!.showNotification).toHaveBeenCalledTimes(1);
        expect(ctor).toHaveBeenCalledTimes(1);
      });

      it('constructs new Notification(title, {body, tag}) on the fallback path', async () => {
        const { ctor } = setNotification('granted');
        setServiceWorker('unregistered');

        await showAppNotification(baseNotification);

        expect(ctor).toHaveBeenCalledWith(
          baseNotification.title,
          expect.objectContaining({ body: baseNotification.body, tag: baseNotification.id }),
        );
      });

      it('tags the toast with the notification id - this is what collapses duplicate toasts across tabs', async () => {
        const { ctor } = setNotification('granted');
        setServiceWorker('unregistered');

        await showAppNotification(baseNotification);

        const [, options] = ctor.mock.calls[0];
        expect(options.tag).toBe('n1');
      });

      it('clicking the toast focuses the window, then calls onClick with the notification, then closes the toast', async () => {
        const { ctor } = setNotification('granted');
        setServiceWorker('unregistered');
        const onClick = vi.fn();
        const focusSpy = vi.spyOn(window, 'focus').mockImplementation(() => {});

        await showAppNotification(baseNotification, onClick);

        const instance = ctor.mock.results[0].value as FakeNotificationInstance;
        expect(instance.onclick).toBeInstanceOf(Function);

        const callOrder: string[] = [];
        focusSpy.mockImplementation(() => callOrder.push('focus'));
        onClick.mockImplementation(() => callOrder.push('onClick'));
        instance.close.mockImplementation(() => callOrder.push('close'));

        instance.onclick!();

        expect(callOrder).toEqual(['focus', 'onClick', 'close']);
        expect(onClick).toHaveBeenCalledWith(baseNotification);
      });

      it('does not attach onclick when no onClick callback is provided', async () => {
        const { ctor } = setNotification('granted');
        setServiceWorker('unregistered');

        await showAppNotification(baseNotification);

        const instance = ctor.mock.results[0].value as FakeNotificationInstance;
        expect(instance.onclick).toBeNull();
      });

      it('the SW path has no equivalent onClick wiring - onClick is ignored when the SW path succeeds', async () => {
        setNotification('granted');
        const sw = setServiceWorker('registered');
        const onClick = vi.fn();

        const result = await showAppNotification(baseNotification, onClick);

        expect(result).toBe('sw');
        expect(sw!.showNotification).toHaveBeenCalledTimes(1);
        expect(onClick).not.toHaveBeenCalled();
      });
    });

    describe('never throws, in any state (#222 acceptance criteria)', () => {
      it('a throw from the Notification constructor is caught and resolves "none"', async () => {
        setNotification('granted', { throwOnConstruct: true });
        setServiceWorker('unregistered');

        await expect(showAppNotification(baseNotification)).resolves.toBe('none');
      });

      it('resolves "none" rather than throwing when getRegistration() rejects AND the page constructor throws', async () => {
        setNotification('granted', { throwOnConstruct: true });
        setServiceWorker('rejects');

        await expect(showAppNotification(baseNotification)).resolves.toBe('none');
      });

      it('resolves "none" rather than throwing when registration.showNotification() rejects AND the page constructor throws', async () => {
        setNotification('granted', { throwOnConstruct: true });
        setServiceWorker('showThrows');

        await expect(showAppNotification(baseNotification)).resolves.toBe('none');
      });
    });
  });
});
