/**
 * Web Push subscription lifecycle, page side — issue #365, epic #215.
 *
 * The server (#229/#230) and the service worker's `push` handler were complete,
 * but nothing on the page ever called `pushManager.subscribe()` or POSTed the
 * result, so `push_subscriptions` stayed empty and every push failed with "No
 * push subscriptions for this user". This module is that missing half.
 *
 * THE SYNC RUNS ON EVERY BOOT, and that is the mechanism, not a retry. The
 * POST is an idempotent upsert by endpoint, so re-sending an unchanged
 * subscription costs one request and repairs every way the server's copy can
 * drift: a row deleted after a 410, a subscription the worker's
 * `pushsubscriptionchange` handler replaced but could not report (it has no
 * token — see `sw.ts`), a browser shared between two accounts.
 *
 * Like `browserNotifications.ts`, NOTHING HERE THROWS. Push is decoration over
 * the notification centre; every failure is logged with `console.warn` and
 * swallowed.
 */

import { subscribePushNotifications, unsubscribePushNotifications } from './api';
import {
  requestBrowserNotificationPermission,
} from './browserNotifications';
import type { NotificationConfigResponse, PushSubscriptionPayload } from '../types';

/**
 * How long to wait for `navigator.serviceWorker.ready`. That promise never
 * settles when no worker ever registers (see `showAppNotification`'s header),
 * so it is always raced against this.
 */
const SERVICE_WORKER_READY_TIMEOUT_MS = 10_000;

/** How long logout will wait for the best-effort unsubscribe. */
const LOGOUT_UNSUBSCRIBE_TIMEOUT_MS = 3_000;

/**
 * VAPID public keys travel as URL-safe base64 without padding;
 * `pushManager.subscribe` wants the raw bytes.
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

/** Resolve with `value`, or with `fallback` once `ms` elapses — whichever is first. */
function withTimeout<T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<F>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function hasPushSupport(): boolean {
  try {
    return (
      typeof navigator !== 'undefined' &&
      'serviceWorker' in navigator &&
      typeof window !== 'undefined' &&
      'PushManager' in window
    );
  } catch {
    return false;
  }
}

/**
 * Does an existing subscription use `key`?
 *
 * Only a DEFINITE mismatch counts. A browser that does not expose
 * `options.applicationServerKey` returns `true` here: re-subscribing on every
 * boot would mint a new endpoint each time and orphan the previous row.
 */
function subscriptionUsesKey(subscription: PushSubscription, key: Uint8Array): boolean {
  const current = subscription.options?.applicationServerKey;
  if (!current) return true;
  const bytes = new Uint8Array(current);
  if (bytes.length !== key.length) return false;
  return bytes.every((byte, index) => byte === key[index]);
}

/**
 * The in-flight sync, so the boot effect and a permission-grant handler racing
 * each other share one subscribe + POST.
 */
let inFlightSync: Promise<void> | null = null;

async function runSync(vapidPublicKey: string): Promise<void> {
  if (!hasPushSupport()) return;
  if (window.Notification?.permission !== 'granted') return;

  const registration = await withTimeout(
    navigator.serviceWorker.ready,
    SERVICE_WORKER_READY_TIMEOUT_MS,
    null,
  );
  if (!registration?.pushManager) {
    console.warn('Push subscription sync skipped: no service worker registration is ready.');
    return;
  }

  const applicationServerKey = urlBase64ToUint8Array(vapidPublicKey);
  let subscription = await registration.pushManager.getSubscription();

  // VAPID rotated since this browser subscribed. The browser refuses to
  // subscribe with a different key while the old subscription exists, so it
  // must go first.
  if (subscription && !subscriptionUsesKey(subscription, applicationServerKey)) {
    await subscription.unsubscribe();
    subscription = null;
  }

  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });
  }

  await subscribePushNotifications(subscription.toJSON() as PushSubscriptionPayload);
}

/**
 * Make sure this browser holds a push subscription for the current VAPID key
 * and that the server has it. Safe to call on every boot; a no-op unless
 * permission is already `granted`. Never requests permission, never throws.
 */
export function syncPushSubscription(vapidPublicKey: string): Promise<void> {
  if (inFlightSync) return inFlightSync;

  inFlightSync = runSync(vapidPublicKey)
    .catch((error) => {
      console.warn('Push subscription sync failed.', error);
    })
    .finally(() => {
      inFlightSync = null;
    });

  return inFlightSync;
}

/**
 * Ask for notification permission, then — if granted and the deployment offers
 * push — subscribe and sync. The one action the auto-prompt, the app-wide
 * banner's button and the settings page's button all share.
 *
 * The sync is started, not awaited, so a caller's spinner tracks the browser
 * prompt rather than a service worker that may take seconds to become ready.
 */
export async function requestPermissionAndSyncPush(
  config: NotificationConfigResponse | null,
): Promise<NotificationPermission | null> {
  const result = await requestBrowserNotificationPermission();
  if (result === 'granted' && config?.pushEnabled && config.vapidPublicKey) {
    void syncPushSubscription(config.vapidPublicKey);
  }
  return result;
}

/**
 * Remove this browser's subscription from the server before logout, so the
 * signed-out account stops receiving pushes on this device. Best-effort and
 * bounded: it never throws and never holds logout up for longer than a few
 * seconds. The browser-side subscription is kept — the next sign-in's sync
 * re-registers it for whoever that is.
 *
 * Uses `getRegistration()`, not `.ready`, so a page with no worker returns at
 * once instead of waiting out a timeout.
 */
export async function removePushSubscription(): Promise<void> {
  if (!hasPushSupport()) return;

  const work = (async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager?.getSubscription();
    if (!subscription) return;
    await unsubscribePushNotifications(subscription.endpoint);
  })();

  try {
    await withTimeout(work, LOGOUT_UNSUBSCRIBE_TIMEOUT_MS, undefined);
  } catch (error) {
    // A 404 (never registered, or already removed) lands here too; nothing to do.
    console.warn('Removing the push subscription on logout failed.', error);
  }
}

// =============================================================================
// Auto-prompt, once per page session
// =============================================================================

let autoPromptClaimed = false;

/**
 * Claim the single automatic permission prompt this page load may make.
 * Returns `true` exactly once per full page load, so StrictMode's double
 * effects, re-renders and remounts of the shell cannot prompt twice.
 */
export function claimAutoPermissionPrompt(): boolean {
  if (autoPromptClaimed) return false;
  autoPromptClaimed = true;
  return true;
}

/** Test-only: forget module state between tests. */
export function resetPushSubscriptionStateForTests(): void {
  autoPromptClaimed = false;
  inFlightSync = null;
}
