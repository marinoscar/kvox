/**
 * Web Push test & diagnostics, page side — issue #449.
 *
 * `/admin/settings/push` can be "enabled" while nothing ever reaches a phone,
 * and every link in the chain fails silently: the permission, the service
 * worker, the browser's push subscription, the server's copy of it, the
 * VAPID key pair, the push service (FCM, Mozilla autopush, APNs), the device
 * and finally the worker's `push` handler. This module walks that chain one
 * explicit step at a time so the panel can point at the link that broke.
 *
 * NOTHING EXPORTED HERE THROWS. Every public function returns a structured
 * result; a failure is data (`status: 'fail'`, a `detail`), not an exception.
 *
 * NOTHING SECRET LEAVES THIS MODULE. A subscription's `p256dh`/`auth` keys are
 * never read into a result, and endpoints are only ever reported as a preview
 * (`host/…last8`). `buildDiagnosticsReport` is safe to paste into an issue.
 *
 * THE ACK. A test push carries `test: true`; `sw.ts` then always shows it and
 * posts `{ type: 'push-test-received', id, … }` to every window. The listener
 * is attached BEFORE the API call, because on a fast connection the push can
 * arrive before the HTTP response does.
 */

import { ApiError, subscribePushNotifications } from './api';
import { requestBrowserNotificationPermission } from './browserNotifications';
import { urlBase64ToUint8Array } from './pushSubscription';
import { sendPushTest, type PushTestResult } from './pushConfig';
import {
  readHasNotificationApi,
  readHasServiceWorkerApi,
  readIsIos,
  readIsSecureContext,
  readIsStandalone,
} from '../hooks/useNotificationCapability';
import type { PushSubscriptionPayload } from '../types';

// =============================================================================
// Types
// =============================================================================

export type BrowserPermissionState = 'granted' | 'denied' | 'default' | 'unsupported';

export interface ServiceWorkerSnapshot {
  /** The page is controlled by a service worker (`navigator.serviceWorker.controller`). */
  controlled: boolean;
  registration: {
    scope: string;
    activeState: string | null;
    waiting: boolean;
    installing: boolean;
    scriptURL: string | null;
  } | null;
  /** `navigator.serviceWorker.ready` settled within the timeout. */
  readyWithinTimeout: boolean;
}

export interface SubscriptionSnapshot {
  exists: boolean;
  /** Host of the push service, e.g. `fcm.googleapis.com`. */
  pushService: string | null;
  /** `host/…last8` — never the full endpoint. */
  endpointPreview: string | null;
  expirationTime: number | null;
  /** base64url of `options.applicationServerKey`, or `null` when the browser does not expose it. */
  applicationServerKey: string | null;
  /** `null` when either side is unknown. */
  keyMatchesServer: boolean | null;
}

export interface BrowserSnapshot {
  collectedAt: string;
  userAgent: string;
  isSecureContext: boolean;
  origin: string;
  hasNotificationApi: boolean;
  hasServiceWorkerApi: boolean;
  hasPushManager: boolean;
  isIos: boolean;
  isStandalone: boolean;
  permission: BrowserPermissionState;
  /** `navigator.permissions.query({ name: 'notifications' })`, or `null` when unavailable. */
  permissionsApiState: string | null;
  serviceWorker: ServiceWorkerSnapshot;
  subscription: SubscriptionSnapshot;
  /** Set when a probe itself failed unexpectedly. */
  errors: string[];
}

export type DiagnosticStepId =
  | 'support'
  | 'permission'
  | 'service-worker'
  | 'subscription'
  | 'register'
  | 'server-test'
  | 'delivery';

export type DiagnosticStepStatus = 'pending' | 'running' | 'ok' | 'warn' | 'fail' | 'skipped';

export interface DiagnosticStep {
  id: DiagnosticStepId;
  label: string;
  status: DiagnosticStepStatus;
  detail?: string;
  startedAt: number;
  durationMs: number;
}

/** The worker's `push-test-received` message, plus page-side timing. */
export interface PushTestAck {
  id: string;
  /** Worker clock, epoch ms. */
  receivedAt: number;
  shown: boolean;
  error?: string;
  hadFocusedClient: boolean;
  /** Page clock: from just before the API call to the ack arriving. */
  latencyMs: number;
}

export interface PushTestRun {
  steps: DiagnosticStep[];
  server: PushTestResult | null;
  ack: PushTestAck | null;
  snapshot: BrowserSnapshot;
  /** Extra client-side hints derived from the run. */
  hints: string[];
}

export interface LocalNotificationResult {
  ok: boolean;
  via: 'service-worker' | 'page' | 'none';
  error?: string;
}

export interface RunPushTestOptions {
  /** How long to wait for `navigator.serviceWorker.ready`. Default 10s. */
  serviceWorkerTimeoutMs?: number;
  /** How long to wait for the worker's ack. Default 20s. */
  ackTimeoutMs?: number;
}

// =============================================================================
// Constants
// =============================================================================

export const SERVICE_WORKER_TIMEOUT_MS = 10_000;
export const ACK_TIMEOUT_MS = 20_000;
const SNAPSHOT_READY_TIMEOUT_MS = 3_000;
export const PUSH_TEST_ACK_MESSAGE = 'push-test-received';

const STEP_LABELS: Record<DiagnosticStepId, string> = {
  support: 'Browser support',
  permission: 'Notification permission',
  'service-worker': 'Service worker',
  subscription: 'Browser push subscription',
  register: 'Register subscription with server',
  'server-test': 'Server sends test push',
  delivery: 'Delivered to this device',
};

export const STEP_ORDER: DiagnosticStepId[] = [
  'support',
  'permission',
  'service-worker',
  'subscription',
  'register',
  'server-test',
  'delivery',
];

export const DENIED_RECOVERY =
  'Notifications are blocked for this site. Open the site settings (padlock or ⋮ menu → Site settings → Notifications) and choose Allow. ' +
  'On Android also check Android Settings → Apps → Chrome (or this installed app) → Notifications, and that its notification categories are on. ' +
  'Then reload this page.';

// =============================================================================
// Small helpers
// =============================================================================

/** base64url, no padding. */
export function bufferToBase64Url(input: ArrayBuffer | ArrayBufferView | null | undefined): string | null {
  if (!input) return null;
  try {
    const bytes =
      input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  } catch {
    return null;
  }
}

/** Normalise a base64url key so padding/alphabet differences do not read as a mismatch. */
function normaliseKey(key: string): string {
  return key.trim().replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function endpointHost(endpoint: string | null | undefined): string | null {
  if (!endpoint) return null;
  try {
    return new URL(endpoint).host;
  } catch {
    return null;
  }
}

/** `host/…last8`. Never the full endpoint — it is a bearer capability for the push service. */
export function endpointPreview(endpoint: string | null | undefined): string | null {
  if (!endpoint) return null;
  const host = endpointHost(endpoint) ?? 'unknown-host';
  return `${host}/…${endpoint.slice(-8)}`;
}

/** `Name: message` for DOMExceptions and Errors, which is what makes Android failures legible. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    return `HTTP ${error.status}${error.code ? ` (${error.code})` : ''}: ${error.message}`;
  }
  if (error && typeof error === 'object' && 'name' in error && 'message' in error) {
    const { name, message } = error as { name: unknown; message: unknown };
    return `${String(name)}: ${String(message)}`;
  }
  return String(error);
}

function withTimeout<T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<F>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function readPermission(): BrowserPermissionState {
  if (!readHasNotificationApi()) return 'unsupported';
  try {
    const value = window.Notification.permission;
    return value === 'granted' || value === 'denied' || value === 'default' ? value : 'unsupported';
  } catch {
    return 'unsupported';
  }
}

function readHasPushManager(): boolean {
  try {
    return typeof window !== 'undefined' && 'PushManager' in window;
  } catch {
    return false;
  }
}

function subscriptionKey(subscription: PushSubscription | null): string | null {
  try {
    return bufferToBase64Url(subscription?.options?.applicationServerKey ?? null);
  } catch {
    return null;
  }
}

function keysMatch(a: string | null, b: string | null | undefined): boolean | null {
  if (!a || !b) return null;
  return normaliseKey(a) === normaliseKey(b);
}

function emptySubscriptionSnapshot(): SubscriptionSnapshot {
  return {
    exists: false,
    pushService: null,
    endpointPreview: null,
    expirationTime: null,
    applicationServerKey: null,
    keyMatchesServer: null,
  };
}

// =============================================================================
// Snapshot
// =============================================================================

/**
 * Everything this browser can say about push, read without side effects
 * (never prompts, never subscribes). `serverPublicKey` enables the key check.
 */
export async function collectBrowserSnapshot(
  serverPublicKey?: string | null,
): Promise<BrowserSnapshot> {
  const errors: string[] = [];
  const snapshot: BrowserSnapshot = {
    collectedAt: new Date().toISOString(),
    userAgent: '',
    isSecureContext: readIsSecureContext(),
    origin: '',
    hasNotificationApi: readHasNotificationApi(),
    hasServiceWorkerApi: readHasServiceWorkerApi(),
    hasPushManager: readHasPushManager(),
    isIos: readIsIos(),
    isStandalone: readIsStandalone(),
    permission: readPermission(),
    permissionsApiState: null,
    serviceWorker: { controlled: false, registration: null, readyWithinTimeout: false },
    subscription: emptySubscriptionSnapshot(),
    errors,
  };

  try {
    snapshot.userAgent = navigator.userAgent ?? '';
    snapshot.origin = window.location.origin;
  } catch {
    // Informational only.
  }

  try {
    if (navigator.permissions?.query) {
      const status = await navigator.permissions.query({
        name: 'notifications' as PermissionName,
      });
      snapshot.permissionsApiState = status.state;
    }
  } catch {
    // Safari rejects unknown names; not a failure worth reporting.
  }

  if (!snapshot.hasServiceWorkerApi) return snapshot;

  try {
    snapshot.serviceWorker.controlled = !!navigator.serviceWorker.controller;
  } catch {
    // Leave as not controlled.
  }

  let registration: ServiceWorkerRegistration | null | undefined = null;
  try {
    registration = await withTimeout(
      navigator.serviceWorker.ready,
      SNAPSHOT_READY_TIMEOUT_MS,
      null,
    );
    snapshot.serviceWorker.readyWithinTimeout = !!registration;
    if (!registration) {
      registration = await navigator.serviceWorker.getRegistration();
    }
  } catch (error) {
    errors.push(`Service worker lookup failed: ${describeError(error)}`);
  }

  if (registration) {
    snapshot.serviceWorker.registration = {
      scope: registration.scope ?? '',
      activeState: registration.active?.state ?? null,
      waiting: !!registration.waiting,
      installing: !!registration.installing,
      scriptURL: registration.active?.scriptURL ?? null,
    };

    try {
      const subscription = (await registration.pushManager?.getSubscription()) ?? null;
      if (subscription) {
        const key = subscriptionKey(subscription);
        snapshot.subscription = {
          exists: true,
          pushService: endpointHost(subscription.endpoint),
          endpointPreview: endpointPreview(subscription.endpoint),
          expirationTime: subscription.expirationTime ?? null,
          applicationServerKey: key,
          keyMatchesServer: keysMatch(key, serverPublicKey),
        };
      }
    } catch (error) {
      errors.push(`Reading the push subscription failed: ${describeError(error)}`);
    }
  }

  return snapshot;
}

// =============================================================================
// Local notification — isolates OS/permission problems from push problems
// =============================================================================

export async function showLocalTestNotification(): Promise<LocalNotificationResult> {
  const permission = readPermission();
  if (permission !== 'granted') {
    return {
      ok: false,
      via: 'none',
      error:
        permission === 'unsupported'
          ? 'This browser has no Notification API.'
          : `Notification permission is "${permission}" — allow notifications first.`,
    };
  }

  const title = 'Local test notification';
  const options: NotificationOptions = {
    body: 'Shown directly by this browser — no push service involved. If you see this, the OS can display notifications from this site.',
    tag: 'push-local-test',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    data: { id: '', link: '/admin/settings/push', test: true },
  };

  let registration: ServiceWorkerRegistration | null | undefined = null;
  if (readHasServiceWorkerApi()) {
    try {
      registration = await withTimeout(
        navigator.serviceWorker.getRegistration(),
        SNAPSHOT_READY_TIMEOUT_MS,
        null,
      );
    } catch {
      registration = null;
    }
  }

  if (registration) {
    try {
      await registration.showNotification(title, options);
      return { ok: true, via: 'service-worker' };
    } catch (error) {
      return { ok: false, via: 'service-worker', error: describeError(error) };
    }
  }

  try {
    new window.Notification(title, options);
    return { ok: true, via: 'page' };
  } catch (error) {
    return { ok: false, via: 'page', error: describeError(error) };
  }
}

// =============================================================================
// Ack listener
// =============================================================================

interface AckListener {
  /** Resolve with the ack for `id` (already received or yet to come), or `null` after `ms`. */
  waitFor: (id: string, ms: number) => Promise<Omit<PushTestAck, 'latencyMs'> & { arrivedAt: number } | null>;
  stop: () => void;
}

type RawAck = Omit<PushTestAck, 'latencyMs'> & { arrivedAt: number };

function startAckListener(): AckListener {
  const received: RawAck[] = [];
  let waiter: { id: string; resolve: (ack: RawAck) => void } | null = null;

  const handler = (event: MessageEvent) => {
    const data = event?.data as Record<string, unknown> | null | undefined;
    if (!data || data.type !== PUSH_TEST_ACK_MESSAGE || typeof data.id !== 'string') return;
    const ack: RawAck = {
      id: data.id,
      receivedAt: typeof data.receivedAt === 'number' ? data.receivedAt : Date.now(),
      shown: data.shown === true,
      error: typeof data.error === 'string' ? data.error : undefined,
      hadFocusedClient: data.hadFocusedClient === true,
      arrivedAt: Date.now(),
    };
    received.push(ack);
    if (waiter && waiter.id === ack.id) waiter.resolve(ack);
  };

  let attached = false;
  try {
    navigator.serviceWorker.addEventListener('message', handler);
    attached = true;
  } catch {
    // No listener → the delivery step will time out and say why.
  }

  return {
    waitFor(id, ms) {
      const already = received.find((ack) => ack.id === id);
      if (already) return Promise.resolve(already);
      const arrival = new Promise<RawAck>((resolve) => {
        waiter = { id, resolve };
      });
      return withTimeout(arrival, ms, null).finally(() => {
        waiter = null;
      });
    },
    stop() {
      if (!attached) return;
      try {
        navigator.serviceWorker.removeEventListener('message', handler);
      } catch {
        // Nothing to do.
      }
    },
  };
}

// =============================================================================
// The stepwise test
// =============================================================================

/**
 * Walk the whole chain, reporting every step through `onStep` (called with a
 * fresh copy of the step each time it changes). Never throws.
 */
export async function runPushTest(
  vapidPublicKey: string | null,
  onStep: (step: DiagnosticStep) => void = () => {},
  options: RunPushTestOptions = {},
): Promise<PushTestRun> {
  const swTimeout = options.serviceWorkerTimeoutMs ?? SERVICE_WORKER_TIMEOUT_MS;
  const ackTimeout = options.ackTimeoutMs ?? ACK_TIMEOUT_MS;

  const steps = new Map<DiagnosticStepId, DiagnosticStep>();
  const hints: string[] = [];
  let server: PushTestResult | null = null;
  let ack: PushTestAck | null = null;

  const emit = (step: DiagnosticStep) => {
    steps.set(step.id, step);
    try {
      onStep({ ...step });
    } catch {
      // A broken UI callback must not break the run.
    }
  };

  const begin = (id: DiagnosticStepId): DiagnosticStep => {
    const step: DiagnosticStep = {
      id,
      label: STEP_LABELS[id],
      status: 'running',
      startedAt: Date.now(),
      durationMs: 0,
    };
    emit(step);
    return step;
  };

  const finish = (
    step: DiagnosticStep,
    status: Exclude<DiagnosticStepStatus, 'running' | 'pending'>,
    detail?: string,
  ): boolean => {
    emit({ ...step, status, detail, durationMs: Date.now() - step.startedAt });
    return status !== 'fail';
  };

  const skipRest = (reason: string) => {
    for (const id of STEP_ORDER) {
      if (steps.has(id)) continue;
      emit({
        id,
        label: STEP_LABELS[id],
        status: 'skipped',
        detail: reason,
        startedAt: Date.now(),
        durationMs: 0,
      });
    }
  };

  const finalise = async (): Promise<PushTestRun> => {
    const snapshot = await collectBrowserSnapshot(vapidPublicKey);
    return {
      steps: STEP_ORDER.map((id) => steps.get(id)).filter((s): s is DiagnosticStep => !!s),
      server,
      ack,
      snapshot,
      hints,
    };
  };

  try {
    // ---- 1. support --------------------------------------------------------
    {
      const step = begin('support');
      const problems: string[] = [];
      if (!readIsSecureContext()) problems.push('Page is not a secure context (HTTPS is required).');
      if (!readHasServiceWorkerApi()) problems.push('No service worker API.');
      if (!readHasPushManager()) problems.push('No Push API (PushManager).');
      if (readIsIos() && !readIsStandalone()) {
        problems.push(
          'iOS/iPadOS only allows web push for an app added to the Home Screen: Share → Add to Home Screen, then open it from the icon.',
        );
      }
      if (!readHasNotificationApi() && !(readIsIos() && !readIsStandalone())) {
        problems.push('No Notification API.');
      }
      if (problems.length > 0) {
        finish(step, 'fail', problems.join(' '));
        skipRest('Browser support check failed.');
        return await finalise();
      }
      finish(
        step,
        'ok',
        `Secure context, Service Worker, Push and Notification APIs present${readIsStandalone() ? ' (installed app)' : ' (browser tab)'}.`,
      );
    }

    // ---- 2. permission -----------------------------------------------------
    {
      const step = begin('permission');
      let permission = readPermission();
      let asked = false;
      if (permission === 'default') {
        asked = true;
        const result = await requestBrowserNotificationPermission();
        permission = result ?? readPermission();
      }
      if (permission === 'denied') {
        finish(step, 'fail', DENIED_RECOVERY);
        skipRest('Notification permission is not granted.');
        return await finalise();
      }
      if (permission !== 'granted') {
        finish(
          step,
          'fail',
          asked
            ? `The permission prompt was dismissed (still "${permission}"). Press Send again and choose Allow.`
            : `Notification permission is "${permission}".`,
        );
        skipRest('Notification permission is not granted.');
        return await finalise();
      }
      finish(step, 'ok', asked ? 'Granted just now.' : 'Granted.');
    }

    // ---- 3. service worker -------------------------------------------------
    let registration: ServiceWorkerRegistration | null = null;
    {
      const step = begin('service-worker');
      try {
        registration = await withTimeout(navigator.serviceWorker.ready, swTimeout, null);
      } catch (error) {
        finish(step, 'fail', `navigator.serviceWorker.ready rejected: ${describeError(error)}`);
        skipRest('No service worker.');
        return await finalise();
      }
      if (!registration) {
        finish(
          step,
          'fail',
          `No active service worker after ${Math.round(swTimeout / 1000)}s. The worker did not register (blocked storage, private mode, or a failed /sw.js load). Reload the page; if it persists, check DevTools → Application → Service Workers.`,
        );
        skipRest('No service worker.');
        return await finalise();
      }
      if (!registration.pushManager) {
        finish(step, 'fail', 'The service worker registration has no pushManager.');
        skipRest('No push manager.');
        return await finalise();
      }
      const where = `scope ${registration.scope ?? '?'}, state ${registration.active?.state ?? 'unknown'}`;
      const waiting = registration.waiting
        ? ' A newer worker is WAITING — accept the update prompt or close all tabs of this app so it activates.'
        : '';
      let controlled = false;
      try {
        controlled = !!navigator.serviceWorker.controller;
      } catch {
        controlled = false;
      }
      if (!controlled) {
        finish(
          step,
          'warn',
          `Ready (${where}), but this page is not controlled by it (first load, or a hard refresh), so it may miss the delivery acknowledgement. Hard-reload the page (or close and reopen the app) and run the test again.${waiting}`,
        );
      } else if (waiting) {
        finish(step, 'warn', `Ready (${where}).${waiting}`);
      } else {
        finish(step, 'ok', `Ready and controlling this page (${where}).`);
      }
    }

    // ---- 4. subscription ---------------------------------------------------
    let subscription: PushSubscription | null = null;
    {
      const step = begin('subscription');
      if (!vapidPublicKey) {
        finish(step, 'fail', 'The server has no VAPID public key to subscribe with.');
        skipRest('No VAPID public key.');
        return await finalise();
      }
      let serverKeyBytes: Uint8Array<ArrayBuffer>;
      try {
        serverKeyBytes = urlBase64ToUint8Array(vapidPublicKey);
      } catch (error) {
        finish(step, 'fail', `The server's VAPID public key is not valid base64url: ${describeError(error)}`);
        skipRest('Invalid VAPID public key.');
        return await finalise();
      }

      const notes: string[] = [];
      try {
        subscription = await registration.pushManager.getSubscription();
      } catch (error) {
        finish(step, 'fail', `getSubscription() failed: ${describeError(error)}`);
        skipRest('Could not read the push subscription.');
        return await finalise();
      }

      if (subscription) {
        const match = keysMatch(subscriptionKey(subscription), vapidPublicKey);
        if (match === false) {
          notes.push('Existing subscription used a different VAPID key (keys were rotated) — unsubscribed and re-subscribing.');
          try {
            await subscription.unsubscribe();
          } catch (error) {
            notes.push(`unsubscribe() failed: ${describeError(error)}.`);
          }
          subscription = null;
        } else {
          notes.push(
            match === null
              ? 'Existing subscription reused (browser does not expose its key to compare).'
              : 'Existing subscription reused; its key matches the server.',
          );
        }
      }

      if (!subscription) {
        try {
          subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: serverKeyBytes,
          });
          notes.push('Subscribed with the push service.');
        } catch (error) {
          const described = describeError(error);
          const name = (error as { name?: unknown })?.name;
          let hint = '';
          if (name === 'AbortError') {
            hint =
              ' The browser could not reach its push service. On Android this usually means Google Play Services / Firebase Cloud Messaging is unavailable, blocked (VPN, firewall, ad-blocking DNS), or the device is offline.';
          } else if (name === 'NotAllowedError') {
            hint = ' Permission is not granted for push in this context.';
          } else if (name === 'InvalidStateError' || name === 'InvalidAccessError') {
            hint = ' The application server key was rejected, or an old subscription with a different key still exists — clear site data and retry.';
          }
          finish(step, 'fail', `pushManager.subscribe() failed — ${described}.${hint}`);
          skipRest('No push subscription.');
          return await finalise();
        }
      }

      notes.push(`Push service: ${endpointPreview(subscription.endpoint) ?? 'unknown'}.`);
      finish(step, 'ok', notes.join(' '));
    }

    // ---- 5. register with server -------------------------------------------
    {
      const step = begin('register');
      try {
        await subscribePushNotifications(subscription.toJSON() as PushSubscriptionPayload);
        finish(step, 'ok', 'The server stored this browser’s subscription.');
      } catch (error) {
        let detail = `Registering the subscription failed — ${describeError(error)}.`;
        if (error instanceof ApiError && error.status === 409) {
          detail += ' 409 means web push is disabled server-side: turn it on above and save.';
        }
        finish(step, 'fail', detail);
        skipRest('The server does not have this browser’s subscription.');
        return await finalise();
      }
    }

    // ---- 6. server test ----------------------------------------------------
    const listener = startAckListener();
    const sentAt = Date.now();
    try {
      {
        const step = begin('server-test');
        try {
          server = await sendPushTest({
            endpoint: subscription.endpoint,
            applicationServerKey: subscriptionKey(subscription) ?? undefined,
          });
        } catch (error) {
          let detail = `The test endpoint failed — ${describeError(error)}.`;
          if (error instanceof ApiError && error.status === 403) {
            detail += ' Sending a test push needs the push:write permission.';
          }
          finish(step, 'fail', detail);
          skipRest('The server did not send a test push.');
          return await finalise();
        }

        const mine = server.subscriptions.find((s) => s.isThisBrowser);
        const summary = `Overall: ${server.overall}. ${server.subscriptions.length} subscription(s) targeted; ` +
          `${server.subscriptions.filter((s) => s.result.status === 'sent').length} accepted by the push service.`;
        const selfLine = mine
          ? ` This browser: ${mine.result.status}${mine.result.statusCode !== null ? ` (HTTP ${mine.result.statusCode})` : ''}${mine.result.message ? ` — ${mine.result.message}` : ''}.`
          : ' This browser’s subscription was not among those targeted.';

        if (server.overall === 'sent' && mine?.result.status === 'sent') {
          finish(step, 'ok', summary + selfLine);
        } else if (mine?.result.status === 'sent') {
          finish(step, 'warn', summary + selfLine);
        } else {
          finish(step, 'fail', summary + selfLine);
          if (!mine) {
            hints.push(
              'The server did not recognise this browser’s endpoint. Check that you are signed in as the same account that registered it, then run the test again.',
            );
          }
          skipRest('The push service did not accept a push for this browser.');
          return await finalise();
        }
      }

      // ---- 7. delivery -----------------------------------------------------
      {
        const step = begin('delivery');
        const raw = await listener.waitFor(server.testId, ackTimeout);
        if (!raw) {
          const failHints = [
            'The push service accepted the message but this device did not report receiving it.',
            'Is the device online and not in data-saver mode?',
            'Android: disable battery optimisation for Chrome/this app, and check Android Settings → Apps → Chrome → Notifications is on.',
            'The service worker may be an older version without the test acknowledgement — reload the page or accept the update prompt, then retry.',
            'If a notification DID appear, delivery works; only the acknowledgement was lost.',
          ];
          finish(step, 'fail', `No acknowledgement within ${Math.round(ackTimeout / 1000)}s. ${failHints.join(' ')}`);
          hints.push(...failHints);
        } else {
          ack = {
            id: raw.id,
            receivedAt: raw.receivedAt,
            shown: raw.shown,
            error: raw.error,
            hadFocusedClient: raw.hadFocusedClient,
            latencyMs: Math.max(0, raw.arrivedAt - sentAt),
          };
          if (raw.shown) {
            finish(step, 'ok', `Received by this device in ${ack.latencyMs} ms and shown as a notification.`);
          } else {
            finish(
              step,
              'fail',
              `Received by this device in ${ack.latencyMs} ms, but showNotification failed${raw.error ? ` — ${raw.error}` : ''}. Push delivery works; the OS refused to display it (check OS-level notification settings for the browser).`,
            );
          }
        }
      }
    } finally {
      listener.stop();
    }
  } catch (error) {
    // Defensive: nothing above should throw, but a run must always return.
    const running = [...steps.values()].find((s) => s.status === 'running');
    if (running) finish(running, 'fail', `Unexpected error: ${describeError(error)}`);
    skipRest('Aborted after an unexpected error.');
  }

  return finalise();
}

// =============================================================================
// Report
// =============================================================================

export interface DiagnosticsReportInput {
  snapshot: BrowserSnapshot | null;
  run?: PushTestRun | null;
  adminConfig?: {
    configured: boolean;
    enabled: boolean;
    publicKey: string | null;
    subject: string | null;
  } | null;
  clientConfig?: {
    browserEnabled: boolean;
    pushEnabled: boolean;
    vapidPublicKey: string | null;
  } | null;
  localNotification?: LocalNotificationResult | null;
  clientWarnings?: string[];
}

/**
 * A JSON-serialisable report for the Copy button. Carries no subscription
 * keys (`p256dh`/`auth`) and no full endpoints — only previews.
 */
export function buildDiagnosticsReport(input: DiagnosticsReportInput): Record<string, unknown> {
  const run = input.run ?? null;
  return {
    kind: 'web-push-diagnostics',
    generatedAt: new Date().toISOString(),
    adminConfig: input.adminConfig ?? null,
    clientConfig: input.clientConfig ?? null,
    clientWarnings: input.clientWarnings ?? [],
    browser: run?.snapshot ?? input.snapshot ?? null,
    localNotification: input.localNotification ?? null,
    test: run
      ? {
          steps: run.steps.map(({ id, label, status, detail, durationMs }) => ({
            id,
            label,
            status,
            detail: detail ?? null,
            durationMs,
          })),
          ack: run.ack,
          server: run.server,
          hints: run.hints,
        }
      : null,
  };
}
