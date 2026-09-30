import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Issue #449. `services/pushDiagnostics.ts` walks the Web Push chain one
 * step at a time. Mocking idiom follows `pushSubscription.test.ts`: globals
 * are reassigned per test over `setup.ts`'s neutral defaults, and the API
 * modules are mocked since this module orchestrates them.
 */

vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    subscribePushNotifications: vi.fn(),
  };
});

vi.mock('../../services/pushConfig', () => ({
  sendPushTest: vi.fn(),
}));

vi.mock('../../services/browserNotifications', () => ({
  requestBrowserNotificationPermission: vi.fn(),
}));

import { ApiError, subscribePushNotifications } from '../../services/api';
import { sendPushTest, type PushTestResult } from '../../services/pushConfig';
import { requestBrowserNotificationPermission } from '../../services/browserNotifications';
import { urlBase64ToUint8Array } from '../../services/pushSubscription';
import {
  DENIED_RECOVERY,
  PUSH_TEST_ACK_MESSAGE,
  buildDiagnosticsReport,
  bufferToBase64Url,
  collectBrowserSnapshot,
  endpointPreview,
  runPushTest,
  showLocalTestNotification,
  type DiagnosticStep,
} from '../../services/pushDiagnostics';

const mockRegister = vi.mocked(subscribePushNotifications);
const mockSendTest = vi.mocked(sendPushTest);
const mockRequestPermission = vi.mocked(requestBrowserNotificationPermission);

const VAPID_KEY = 'BEl62iUYgUivxIkv69yViEuiBIa1HI0DLQCHUp2ZfmZC';
const OTHER_KEY = 'BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abcdefghijklmnop-SECRET-TAIL12345678';
const P256DH = 'P256DH-KEY-MATERIAL-MUST-NOT-LEAK';
const AUTH = 'AUTH-SECRET-MUST-NOT-LEAK';

function setPermission(permission: NotificationPermission) {
  const ctor = vi.fn();
  Object.assign(ctor, { permission, requestPermission: vi.fn() });
  Object.defineProperty(window, 'Notification', { configurable: true, writable: true, value: ctor });
  return ctor;
}

function makeSubscription(key: string | null = VAPID_KEY) {
  return {
    endpoint: ENDPOINT,
    expirationTime: null,
    options: { applicationServerKey: key ? urlBase64ToUint8Array(key).buffer : null },
    unsubscribe: vi.fn().mockResolvedValue(true),
    toJSON: () => ({ endpoint: ENDPOINT, expirationTime: null, keys: { p256dh: P256DH, auth: AUTH } }),
  };
}

interface Env {
  pushManager: { getSubscription: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> };
  registration: Record<string, unknown>;
  listeners: Array<(event: MessageEvent) => void>;
  deliver: (data: unknown) => void;
}

function setupEnv(opts: { existing?: ReturnType<typeof makeSubscription> | null; controlled?: boolean } = {}): Env {
  (window as any).PushManager = function PushManager() {};
  const pushManager = {
    getSubscription: vi.fn().mockResolvedValue(opts.existing ?? null),
    subscribe: vi.fn().mockResolvedValue(makeSubscription()),
  };
  const registration = {
    scope: 'https://app.example.com/',
    active: { state: 'activated', scriptURL: 'https://app.example.com/sw.js' },
    waiting: null,
    installing: null,
    pushManager,
    showNotification: vi.fn().mockResolvedValue(undefined),
  };
  const listeners: Array<(event: MessageEvent) => void> = [];
  Object.defineProperty(window.navigator, 'serviceWorker', {
    configurable: true,
    writable: true,
    value: {
      controller: opts.controlled === false ? null : {},
      ready: Promise.resolve(registration),
      getRegistration: vi.fn().mockResolvedValue(registration),
      addEventListener: vi.fn((type: string, fn: (event: MessageEvent) => void) => {
        if (type === 'message') listeners.push(fn);
      }),
      removeEventListener: vi.fn((type: string, fn: (event: MessageEvent) => void) => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      }),
    },
  });
  return {
    pushManager,
    registration,
    listeners,
    deliver: (data) => listeners.slice().forEach((fn) => fn({ data } as MessageEvent)),
  };
}

function serverResult(overrides: Partial<PushTestResult> = {}): PushTestResult {
  return {
    ranAt: '2026-09-30T00:00:00.000Z',
    durationMs: 120,
    overall: 'sent',
    testId: 'push-test-1234',
    config: {
      source: 'admin',
      enabled: true,
      active: true,
      publicKey: VAPID_KEY,
      publicKeyValid: true,
      privateKeyMatchesPublicKey: true,
      subject: 'mailto:ops@example.com',
      subjectValid: true,
      problems: [],
    },
    browser: { endpointProvided: true, endpointRegistered: true, keyMatchesServer: true },
    events: [],
    subscriptions: [
      {
        id: 'sub-1',
        pushService: 'fcm.googleapis.com',
        endpointPreview: 'fcm.googleapis.com/…12345678',
        isThisBrowser: true,
        userAgent: 'Android Chrome',
        createdAt: '2026-09-01T00:00:00.000Z',
        lastSuccessAt: null,
        failureCount: 0,
        result: { status: 'sent', statusCode: 201, message: null, responseBody: null, durationMs: 90 },
      },
    ],
    hints: [],
    ...overrides,
  };
}

function statusOf(steps: DiagnosticStep[], id: DiagnosticStep['id']) {
  return steps.find((s) => s.id === id)?.status;
}

describe('pushDiagnostics', () => {
  beforeEach(() => {
    mockRegister.mockReset().mockResolvedValue({ id: 'sub-1', endpoint: ENDPOINT } as any);
    mockSendTest.mockReset();
    mockRequestPermission.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as any).PushManager;
  });

  describe('helpers', () => {
    it('round-trips a VAPID key through base64url', () => {
      expect(bufferToBase64Url(urlBase64ToUint8Array(VAPID_KEY))).toBe(VAPID_KEY);
    });

    it('previews an endpoint as host + last 8 characters only', () => {
      expect(endpointPreview(ENDPOINT)).toBe('fcm.googleapis.com/…12345678');
    });
  });

  describe('runPushTest', () => {
    it('fails the permission step with recovery steps when denied, and skips the rest', async () => {
      setPermission('denied');
      const env = setupEnv();
      const seen: DiagnosticStep[] = [];

      const run = await runPushTest(VAPID_KEY, (s) => seen.push(s));

      expect(statusOf(run.steps, 'support')).toBe('ok');
      const permission = run.steps.find((s) => s.id === 'permission')!;
      expect(permission.status).toBe('fail');
      expect(permission.detail).toBe(DENIED_RECOVERY);
      expect(statusOf(run.steps, 'subscription')).toBe('skipped');
      expect(statusOf(run.steps, 'delivery')).toBe('skipped');
      expect(env.pushManager.subscribe).not.toHaveBeenCalled();
      expect(mockSendTest).not.toHaveBeenCalled();
      expect(mockRequestPermission).not.toHaveBeenCalled();
      // Every step was reported through onStep, including the 'running' phase.
      expect(seen.some((s) => s.id === 'support' && s.status === 'running')).toBe(true);
    });

    it('requests permission when it is "default"', async () => {
      setPermission('default');
      setupEnv();
      mockRequestPermission.mockResolvedValue('denied');

      const run = await runPushTest(VAPID_KEY);

      expect(mockRequestPermission).toHaveBeenCalledTimes(1);
      expect(statusOf(run.steps, 'permission')).toBe('fail');
    });

    it('unsubscribes and re-subscribes when the existing subscription uses a different key', async () => {
      setPermission('granted');
      const stale = makeSubscription(OTHER_KEY);
      const env = setupEnv({ existing: stale });
      mockSendTest.mockResolvedValue(serverResult());

      const run = await runPushTest(VAPID_KEY, undefined, { ackTimeoutMs: 50 });

      expect(stale.unsubscribe).toHaveBeenCalledTimes(1);
      expect(env.pushManager.subscribe).toHaveBeenCalledTimes(1);
      const arg = env.pushManager.subscribe.mock.calls[0][0];
      expect(arg.userVisibleOnly).toBe(true);
      expect(bufferToBase64Url(arg.applicationServerKey)).toBe(VAPID_KEY);
      const sub = run.steps.find((s) => s.id === 'subscription')!;
      expect(sub.status).toBe('ok');
      expect(sub.detail).toMatch(/different VAPID key/);
    });

    it('surfaces the real DOMException name and message when subscribe fails', async () => {
      setPermission('granted');
      const env = setupEnv();
      const error = new Error('Registration failed - push service error');
      error.name = 'AbortError';
      env.pushManager.subscribe.mockRejectedValue(error);

      const run = await runPushTest(VAPID_KEY);

      const sub = run.steps.find((s) => s.id === 'subscription')!;
      expect(sub.status).toBe('fail');
      expect(sub.detail).toContain('AbortError: Registration failed - push service error');
      expect(sub.detail).toMatch(/Firebase Cloud Messaging/);
      expect(statusOf(run.steps, 'register')).toBe('skipped');
      expect(mockRegister).not.toHaveBeenCalled();
    });

    it('explains a 409 from the subscription endpoint as push disabled server-side', async () => {
      setPermission('granted');
      setupEnv({ existing: makeSubscription() });
      mockRegister.mockRejectedValue(new ApiError('Web push is disabled', 409));

      const run = await runPushTest(VAPID_KEY);

      const register = run.steps.find((s) => s.id === 'register')!;
      expect(register.status).toBe('fail');
      expect(register.detail).toContain('HTTP 409');
      expect(register.detail).toMatch(/disabled server-side/);
    });

    it('calls the test endpoint with the endpoint and base64url key, and reports the ack (even one that beats the HTTP response)', async () => {
      setPermission('granted');
      const env = setupEnv({ existing: makeSubscription() });
      mockSendTest.mockImplementation(async () => {
        // The push arrives before the HTTP response — the listener must
        // already be attached and must buffer it.
        env.deliver({
          type: PUSH_TEST_ACK_MESSAGE,
          id: 'push-test-1234',
          receivedAt: Date.now(),
          shown: true,
          hadFocusedClient: true,
        });
        return serverResult();
      });

      const run = await runPushTest(VAPID_KEY);

      expect(mockRegister).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } }),
      );
      expect(mockSendTest).toHaveBeenCalledWith({ endpoint: ENDPOINT, applicationServerKey: VAPID_KEY });
      expect(statusOf(run.steps, 'server-test')).toBe('ok');
      expect(statusOf(run.steps, 'delivery')).toBe('ok');
      expect(run.ack).toMatchObject({ id: 'push-test-1234', shown: true, hadFocusedClient: true });
      expect(run.ack!.latencyMs).toBeGreaterThanOrEqual(0);
      expect(run.server?.testId).toBe('push-test-1234');
      // Listener removed once the run finishes.
      expect(env.listeners).toHaveLength(0);
    });

    it('ignores acks for a different test id', async () => {
      setPermission('granted');
      const env = setupEnv({ existing: makeSubscription() });
      mockSendTest.mockImplementation(async () => {
        env.deliver({ type: PUSH_TEST_ACK_MESSAGE, id: 'push-test-OTHER', shown: true });
        return serverResult();
      });

      const run = await runPushTest(VAPID_KEY, undefined, { ackTimeoutMs: 20 });

      expect(statusOf(run.steps, 'delivery')).toBe('fail');
      expect(run.ack).toBeNull();
    });

    it('fails the delivery step with hints when no ack arrives within 20s', async () => {
      vi.useFakeTimers();
      setPermission('granted');
      setupEnv({ existing: makeSubscription() });
      mockSendTest.mockResolvedValue(serverResult());

      const promise = runPushTest(VAPID_KEY);
      await vi.advanceTimersByTimeAsync(19_000);
      let settled = false;
      void promise.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1_500);
      const run = await promise;

      const delivery = run.steps.find((s) => s.id === 'delivery')!;
      expect(delivery.status).toBe('fail');
      expect(delivery.detail).toMatch(/No acknowledgement within 20s/);
      expect(run.hints.join(' ')).toMatch(/battery optimisation/);
      expect(run.ack).toBeNull();
    });

    it('fails the server step (and skips delivery) when the push service rejects this browser', async () => {
      setPermission('granted');
      setupEnv({ existing: makeSubscription() });
      const base = serverResult();
      mockSendTest.mockResolvedValue(
        serverResult({
          overall: 'failed',
          subscriptions: [
            {
              ...base.subscriptions[0],
              result: { status: 'pruned', statusCode: 410, message: 'Gone', responseBody: 'expired', durationMs: 50 },
            },
          ],
        }),
      );

      const run = await runPushTest(VAPID_KEY);

      const step = run.steps.find((s) => s.id === 'server-test')!;
      expect(step.status).toBe('fail');
      expect(step.detail).toContain('HTTP 410');
      expect(statusOf(run.steps, 'delivery')).toBe('skipped');
    });

    it('reports a 403 from the test endpoint as missing push:write', async () => {
      setPermission('granted');
      setupEnv({ existing: makeSubscription() });
      mockSendTest.mockRejectedValue(new ApiError('Forbidden', 403));

      const run = await runPushTest(VAPID_KEY);

      expect(run.steps.find((s) => s.id === 'server-test')!.detail).toMatch(/push:write/);
    });

    it('warns (does not fail) when the page is not controlled by the service worker', async () => {
      setPermission('granted');
      setupEnv({ controlled: false });
      mockSendTest.mockResolvedValue(serverResult());

      const run = await runPushTest(VAPID_KEY, undefined, { ackTimeoutMs: 10 });

      const sw = run.steps.find((s) => s.id === 'service-worker')!;
      expect(sw.status).toBe('warn');
      expect(sw.detail).toMatch(/Hard-reload/);
    });

    it('never throws, even when onStep throws', async () => {
      setPermission('denied');
      setupEnv();

      await expect(
        runPushTest(VAPID_KEY, () => {
          throw new Error('ui broke');
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('collectBrowserSnapshot', () => {
    it('reports the subscription as a preview with a key comparison', async () => {
      setPermission('granted');
      setupEnv({ existing: makeSubscription() });

      const snapshot = await collectBrowserSnapshot(VAPID_KEY);

      expect(snapshot.permission).toBe('granted');
      expect(snapshot.hasPushManager).toBe(true);
      expect(snapshot.serviceWorker.controlled).toBe(true);
      expect(snapshot.serviceWorker.registration?.activeState).toBe('activated');
      expect(snapshot.subscription).toMatchObject({
        exists: true,
        pushService: 'fcm.googleapis.com',
        endpointPreview: 'fcm.googleapis.com/…12345678',
        applicationServerKey: VAPID_KEY,
        keyMatchesServer: true,
      });
    });

    it('flags a key mismatch', async () => {
      setPermission('granted');
      setupEnv({ existing: makeSubscription(OTHER_KEY) });

      const snapshot = await collectBrowserSnapshot(VAPID_KEY);

      expect(snapshot.subscription.keyMatchesServer).toBe(false);
    });
  });

  describe('showLocalTestNotification', () => {
    it('shows through the service worker registration when one exists', async () => {
      setPermission('granted');
      const env = setupEnv();

      const result = await showLocalTestNotification();

      expect(result).toEqual({ ok: true, via: 'service-worker' });
      expect(env.registration.showNotification).toHaveBeenCalledTimes(1);
    });

    it('refuses without permission, without throwing', async () => {
      setPermission('denied');
      setupEnv();

      const result = await showLocalTestNotification();

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/denied/);
    });

    it('falls back to the page Notification constructor when there is no registration', async () => {
      const ctor = setPermission('granted');
      const env = setupEnv();
      (navigator.serviceWorker.getRegistration as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const result = await showLocalTestNotification();

      expect(result).toEqual({ ok: true, via: 'page' });
      expect(ctor).toHaveBeenCalledTimes(1);
      expect(env.registration.showNotification).not.toHaveBeenCalled();
    });
  });

  describe('buildDiagnosticsReport', () => {
    it('is JSON-serialisable and carries no subscription keys or full endpoint', async () => {
      setPermission('granted');
      const env = setupEnv({ existing: makeSubscription() });
      mockSendTest.mockImplementation(async () => {
        env.deliver({ type: PUSH_TEST_ACK_MESSAGE, id: 'push-test-1234', shown: true, hadFocusedClient: false });
        return serverResult();
      });
      const run = await runPushTest(VAPID_KEY);

      const report = buildDiagnosticsReport({ snapshot: run.snapshot, run });
      const text = JSON.stringify(report);

      expect(JSON.parse(text)).toMatchObject({ kind: 'web-push-diagnostics' });
      expect(text).not.toContain(P256DH);
      expect(text).not.toContain(AUTH);
      expect(text).not.toContain(ENDPOINT);
      expect(text).toContain('push-test-1234');
    });
  });
});
