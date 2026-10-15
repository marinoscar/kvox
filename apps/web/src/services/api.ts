/**
 * Where the API lives.
 *
 * EXPORTED as of #127. The notification SSE client (`services/sse.ts`) opens a
 * raw `fetch` outside `PlatformHttpClient.request` — it has to, because that method
 * buffers a JSON body and an event stream never ends — and it must resolve its
 * URL against exactly the same base. A second literal `'/api'` there would be
 * a same-origin assumption that silently breaks the day `VITE_API_BASE_URL` is
 * set, in the one code path that fails by going quiet rather than by erroring.
 */
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

// Issue #258, epic #254. The maintenance recogniser is imported here — and
// nowhere near a page — because the interception is CENTRAL: see `onErrorResponse`.
import { readMaintenanceBlock, reportMaintenanceBlock } from './maintenance';
import { APP_SLUG } from '@app/shared';
import {
  ApiError,
  PlatformHttpClient,
  type PlatformHttpRequestOptions,
} from '@marinoscar/platform-web/core';

/**
 * Issue #465, epic #462. The HTTP client is the platform's `PlatformHttpClient`
 * (`@marinoscar/platform-web/core`): the access-token holder, the one-shot
 * 401 -> refresh -> retry, the cross-page refresh lock and the "session expired"
 * signal that the packaged `AuthProvider` drives sessions through. It is the
 * former `ApiService` of this file, moved to the package; what stays KVox's is
 * what it is configured with.
 *
 * `ApiError` is re-exported so the ~30 call sites that import it from
 * `services/api` keep doing so. It is the package's class (same `message`,
 * `status`, `code`, `details`), so an `instanceof` check still matches.
 */
export { ApiError };

/**
 * Notice a maintenance window (#258, epic #254).
 *
 * THIS IS THE ONLY PLACE THE WEB APP LOOKS FOR THE MARKER, and that is the
 * design rather than a convenience. Every request in this application goes
 * through the client's single error path, so putting the check on its
 * `onErrorResponse` hook means every existing caller — hooks, pages, one-off
 * handlers, code added after this — inherits maintenance handling without a
 * line of change. The alternative (each caller inspecting its own error) would
 * be ~30 copies of one `if`, each free to be forgotten on the next endpoint
 * added, in a client whose whole reason for recognising the marker is that it
 * must not guess.
 *
 * AN ORDINARY 503 IS UNTOUCHED. `readMaintenanceBlock` returns `null` unless
 * the status is 503 AND `details.reason` is the marker, so a crashed upstream,
 * a full connection pool or a proxy with no backend produces EXACTLY the
 * `ApiError` it produced before this hook existed. That distinction is the
 * feature; see `services/maintenance.ts`.
 *
 * The error is still THROWN in both cases. The block is a side channel for the
 * gate, never a replacement for the rejection a caller is awaiting.
 */
function noticeMaintenance(
  status: number,
  body: { message?: string; code?: string; details?: unknown },
): void {
  const block = readMaintenanceBlock(status, body);
  if (block) {
    reportMaintenanceBlock(block);
  }
}

export const api = new PlatformHttpClient({
  baseUrl: API_BASE_URL,
  // Named after the app so two apps on one origin never contend for a lock.
  refreshLockName: `${APP_SLUG}-auth-refresh`,
  onErrorResponse: noticeMaintenance,
});

/** Request options of {@link api}, for the few callers that name the type. */
export type RequestOptions = PlatformHttpRequestOptions;

// Import types
import type {
  EmailSettings,
  EmailSettingsInput,
  EmailTestResult,
  NotificationEventDef,
  NotificationConfigResponse,
  PushSubscriptionPayload,
  PushSubscriptionResponse,
  AppNotification,
  NotificationListResponse,
  UnreadCountResponse,
  MaintenanceStatus,
  UpdateMaintenanceInput,
  ProfileImageMutationResponse,
  AboutResponse,
} from '../types';
import type { AllowedEmailEntry } from '@marinoscar/platform-web/identity/headless';

// Profile picture API — issue #367.

/**
 * Upload the caller's profile picture (one multipart `file` part).
 *
 * The server validates the bytes (JPEG/PNG/GIF/WebP, max 5 MB) and answers 400
 * or 413 with a message otherwise. On success it stores the image, switches
 * `profile.imageSource` to `'upload'` and deletes any previous upload, so the
 * caller must adopt the returned `settings` (new `version`).
 */
export async function uploadProfileImage(file: File): Promise<ProfileImageMutationResponse> {
  const formData = new FormData();
  formData.append('file', file);
  return api.postFormData<ProfileImageMutationResponse>(
    '/user-settings/profile-image',
    formData,
  );
}

/**
 * Remove the caller's uploaded picture. A source of `'upload'` falls back to
 * `'provider'` server-side; the returned `settings` must be adopted.
 */
export async function deleteProfileImage(): Promise<ProfileImageMutationResponse> {
  return api.delete<ProfileImageMutationResponse>('/user-settings/profile-image');
}

/**
 * Fetch the caller's stored uploaded picture, whatever `profile.imageSource`
 * currently selects, for previewing it in settings. Authenticated on purpose:
 * the public `/users/:id/avatar/:objectId` route only serves a picture while
 * it is the selected source. Rejects with a 404 `ApiError` when none exists.
 */
export async function fetchProfileImagePreview(): Promise<Blob> {
  return api.getBlob('/user-settings/profile-image');
}

// Allowlist API — the one call the web app still makes itself.
//
// The identity slice owns `/api/allowlist` and its pages (and its hooks make
// every other call), but the Setup checklist (`pages/Admin/SetupPage.tsx`)
// invites an address through the existing service function rather than through
// `useAllowlist`, whose `addEmail` also refetches a paginated list that page
// does not render. One POST (`allowlist:write`), then one checklist re-read.
export async function addToAllowlist(
  email: string,
  notes?: string,
): Promise<AllowedEmailEntry> {
  return api.post<AllowedEmailEntry>('/allowlist', { email, notes });
}

// Email settings API — issue #124, epic #109.
//
// Three calls, one controller (`system_settings:read` to read,
// `system_settings:write` to save or test), and the ONLY place in the web app
// that names these endpoints. The page and its hook speak in `EmailSettings`
// terms; if the API's routes or field names move, this block plus the types in
// `types/index.ts` are the entire reconciliation surface.
//
// The payloads are FLAT — `sesRegion`, `smtpHost`, `smtpPort` and friends are
// siblings, not members of `ses: {…}` / `smtp: {…}` sub-objects. See the note
// in `types/index.ts`; getting this wrong compiles cleanly and fails only at
// runtime, which is why it is written down in both places.

export async function getEmailSettings(): Promise<EmailSettings> {
  return api.get<EmailSettings>('/email-settings');
}

/**
 * Replace the stored email settings.
 *
 * PUT rather than PATCH because this is one small document edited on one
 * screen: a per-field merge would let a half-saved provider switch (SMTP host
 * written, SES region not) exist as a state nothing in the UI can show. The
 * one field with merge semantics is `smtpPassword`, and those semantics live
 * in the API (blank preserves — see `EmailSettingsInput`), not in a patch
 * document.
 *
 * `expectedVersion` becomes `If-Match`, the same optimistic-concurrency
 * mechanism `useSystemSettings` uses against `/system-settings`, because the
 * API offers it here too and a settings row with a version counter and no
 * caller checking it is a lost-update waiting to happen: two admins on this
 * page, and the second save silently discards the first with nothing on either
 * screen to show it. A mismatch is a 409, which the hook turns into a reload
 * plus a message rather than an overwrite.
 *
 * PASSED THROUGH AS-IS, INCLUDING ZERO. `0` is the API's way of asserting "I
 * believe nothing is stored yet", so the check is `=== undefined` and never a
 * truthiness test — `if (expectedVersion)` would drop the guard on exactly the
 * first save, where two admins configuring a fresh deployment collide.
 */
export async function updateEmailSettings(
  input: EmailSettingsInput,
  expectedVersion?: number,
): Promise<EmailSettings> {
  return api.put<EmailSettings>('/email-settings', input, {
    headers:
      expectedVersion === undefined
        ? undefined
        : { 'If-Match': String(expectedVersion) },
  });
}

/**
 * Send a test message to the CALLER'S OWN address, using the SAVED settings.
 *
 * No recipient parameter, deliberately: a free-text "send to" box on an
 * authenticated admin form is a send-arbitrary-mail endpoint wearing a
 * diagnostic hat (#124's own rejected alternative). The caller's identity is
 * already on the request, so the API resolves the recipient itself.
 *
 * RESOLVES ON FAILURE. A provider that refuses the message still produces a
 * 200 carrying `{ success: false, error }`; only a transport or authorization
 * failure rejects. Callers MUST branch on `result.success`.
 */
export async function sendTestEmail(): Promise<EmailTestResult> {
  return api.post<EmailTestResult>('/email-settings/test');
}

/**
 * The notification event registry — `GET /api/notifications/events` (#124).
 *
 * AUTHENTICATED, NOT ADMIN-GATED. Every signed-in user reads this; it is what
 * `/settings/notifications` renders its matrix against, and that page belongs
 * to every role. A `system_settings:read` reflex here would leave a Viewer with
 * a preferences page and no rows in it.
 *
 * THE WEB APP DOES NOT KEEP A COPY OF THIS LIST, deliberately. `mandatory` is a
 * security flag, and a second declaration of a security flag is a second place
 * for it to be wrong; a duplicated registry would also break epic #109's
 * headline promise that adding a notification costs ONE registry entry. The
 * consequence is that the preferences page renders whatever the server serves,
 * including events added after this build shipped.
 *
 * The response is ORDERED and the order is meaningful — it is the order the
 * preferences UI should render. Do not sort it.
 */
export async function getNotificationEvents(): Promise<NotificationEventDef[]> {
  return api.get<NotificationEventDef[]>('/notifications/events');
}

/**
 * This deployment's client-facing notification capabilities —
 * `GET /api/notifications/config` (#226, epic #215).
 *
 * AUTHENTICATED, NOT ADMIN-GATED — like `getNotificationEvents` above, and for
 * an analogous reason. `GET /api/system-settings` requires `system_settings:read`,
 * which the seeded `viewer` and `contributor` roles do not hold, so it cannot be
 * the source for a toggle those very roles need to render correctly. This
 * endpoint is a narrow, purpose-built projection — three booleans-worth of
 * capability, no policy detail (`disabledEvents` in particular never appears
 * here; the per-event answer arrives with the event, as the stream's `toast`
 * flag) — readable by any authenticated user. See the DTO's own header
 * (`apps/api/src/notifications/dto/notification-config.dto.ts`) for the full
 * argument, including why widening `system_settings:read` instead was rejected.
 *
 * Consumed by `useNotificationCapability`'s `adminDisabled` option (#227), as
 * `!browserEnabled`, so a client can withhold the "Allow notifications" prompt
 * on a deployment that has turned browser notifications off entirely rather
 * than spend a user's one-shot permission decision on a feature this
 * deployment does not offer.
 */
export async function getNotificationConfig(): Promise<NotificationConfigResponse> {
  return api.get<NotificationConfigResponse>('/notifications/config');
}

/**
 * Register (or refresh) this browser's push subscription for the caller (#365).
 *
 * Upserted by `endpoint` server-side, so calling this on every boot is the
 * self-heal, not a duplicate. `409` when the deployment has push disabled.
 */
export async function subscribePushNotifications(
  subscription: PushSubscriptionPayload,
): Promise<PushSubscriptionResponse> {
  return api.post<PushSubscriptionResponse>('/notifications/push/subscriptions', subscription);
}

/**
 * Remove this browser's push subscription for the caller (#365). A `DELETE`
 * with a JSON body: the endpoint URL is the only handle on the row. `404` when
 * the caller has no such subscription.
 */
export async function unsubscribePushNotifications(endpoint: string): Promise<void> {
  return api.delete<void>('/notifications/push/subscriptions', {
    body: JSON.stringify({ endpoint }),
  });
}

// Notification centre API — issue #127, epic #109.
//
// The four REST calls behind the bell. The fifth endpoint of this controller —
// `GET /api/notifications/stream` — is deliberately NOT here: it is an
// unbounded `text/event-stream` and `PlatformHttpClient.request` awaits `response.json()`,
// which on a stream that never ends never resolves. It lives in
// `services/notificationStream.ts` on top of the fetch-based SSE client.
//
// NOT ONE OF THESE CALLS NAMES A USER, in a path, a query or a body. Every one
// operates on the authenticated caller's own rows, resolved server-side from
// the JWT (`@CurrentUser('id')`). There is no `?userId=` to add here, and
// adding one would not work: the API has no parameter for it, by design — see
// the header of `apps/api/src/notifications/notifications.controller.ts`.

/**
 * A page of the caller's notifications, newest first.
 *
 * THE DURABLE SURFACE. This is correct whether or not the user ever granted
 * browser-notification permission and whether or not the SSE stream was
 * connected when a notification was raised, which is why the centre is built on
 * it and the native toast is decoration on top.
 *
 * `unreadOnly` is sent as the STRING `'true'`/`'false'`, matching the API's
 * schema exactly. It is an explicit enum there rather than a coerced boolean
 * because `z.coerce.boolean()` follows JS truthiness and would turn the string
 * `'false'` into `true`, inverting the filter — so the spelling here is
 * load-bearing rather than stylistic.
 */
export async function getNotifications(params?: {
  page?: number;
  pageSize?: number;
  unreadOnly?: boolean;
}): Promise<NotificationListResponse> {
  const searchParams = new URLSearchParams();
  if (params?.page) searchParams.set('page', String(params.page));
  if (params?.pageSize) searchParams.set('pageSize', String(params.pageSize));
  // `!== undefined`, not truthiness: `false` is a meaningful value to send.
  if (params?.unreadOnly !== undefined) {
    searchParams.set('unreadOnly', params.unreadOnly ? 'true' : 'false');
  }

  return api.get<NotificationListResponse>(`/notifications?${searchParams}`);
}

/**
 * The badge number.
 *
 * A DEDICATED ENDPOINT, not something counted out of a page of
 * `getNotifications`: a count taken from a page silently caps at `pageSize`, so
 * a user with 30 unread would see "20" and never learn otherwise. Call it on
 * mount and again on every SSE (re)connect.
 */
export async function getUnreadNotificationCount(): Promise<UnreadCountResponse> {
  return api.get<UnreadCountResponse>('/notifications/unread-count');
}

/**
 * Mark one notification read.
 *
 * RETURNS THE NEW UNREAD COUNT, which is the whole reason this is worth a round
 * trip: the caller already holds the row it just marked, so the count is the
 * only thing it cannot compute for itself. DO NOT follow this with a call to
 * `getUnreadNotificationCount` — that is the two-round-trip shape the API was
 * built to avoid.
 *
 * Idempotent server-side; marking an already-read notification succeeds and
 * leaves the original `readAt` alone. A 404 means "no such notification FOR
 * THIS USER" — an id belonging to somebody else is indistinguishable from one
 * that does not exist, deliberately, so the endpoint cannot be used to probe
 * for valid ids.
 */
export async function markNotificationRead(id: string): Promise<UnreadCountResponse> {
  return api.post<UnreadCountResponse>(`/notifications/${id}/read`);
}

/**
 * Clear the badge in one call, returning the resulting count.
 *
 * The count is REPORTED, not assumed to be zero: a notification arriving
 * between the update and the count is reflected honestly rather than hidden
 * behind a hardcoded `0`. Callers must use the returned number and never
 * `setUnreadCount(0)`.
 */
export async function markAllNotificationsRead(): Promise<UnreadCountResponse> {
  return api.post<UnreadCountResponse>('/notifications/read-all');
}

/** Re-exported for consumers that only import from this module. */
export type { AppNotification };

// Maintenance mode API — issue #258, epic #254.
//
// Two calls, one controller (`system_settings:read` to look,
// `system_settings:write` to change), and the only place in the web app that
// names these endpoints.
//
// BOTH ROUTES ARE EXEMPT FROM THE API'S OWN MAINTENANCE GUARD
// (`@AllowDuringMaintenance()` on `maintenance.controller.ts`), which is what
// makes them usable for the two jobs they have here: the admin page can close a
// window from inside one, and `MaintenanceBanner` can keep telling a bypassing
// administrator that a window is open. Exemption is REACHABILITY only — `@Auth()`
// still runs, so a caller without the permission gets a 403 during a window
// exactly as they would outside one.

/**
 * The effective maintenance state, plus each contributing layer.
 *
 * Served with `fresh: true` on the API side, so this never returns a value from
 * the guard's five-second cache: an operator inspecting the switch must not be
 * shown a stale one.
 */
export async function getMaintenanceStatus(): Promise<MaintenanceStatus> {
  return api.get<MaintenanceStatus>('/admin/maintenance');
}

/**
 * Open or close the persisted window.
 *
 * PUT, not PATCH, because `enabled` is required on every call — this endpoint
 * exists to answer on-or-off — while `message` and `allowAdmins` are optional
 * and OMITTING one keeps whatever is stored. So the caller must send `enabled`
 * deliberately every time and can leave the rest alone; see
 * `UpdateMaintenanceInput` for why `startedAt` / `startedById` are not part of
 * this body at all.
 *
 * RETURNS THE STATE AFTER THE WRITE, INCLUDING ITS LAYERS — which is the whole
 * reason the caller must adopt the response rather than its own input. An
 * environment override still outranks anything this writes, so a save that
 * turned the persisted flag off can legitimately come back with
 * `enabled: true` and `source: 'env'`, and a page that assumed its own payload
 * had taken effect would then show the operator the opposite of the truth.
 */
export async function updateMaintenance(
  input: UpdateMaintenanceInput,
): Promise<MaintenanceStatus> {
  return api.put<MaintenanceStatus>('/admin/maintenance', input);
}

// About API — issue #126, epic #118.
//
// One call, one controller (`about.controller.ts`, `system_settings:read` —
// deliberately no permission of its own, per epic #118 decision 8), and the
// only place in the web app that names this endpoint.

/**
 * What is deployed here: the CLI's deploy-info record, live runtime facts and
 * database facts.
 *
 * ALWAYS A 200 on the API side — the dev stack has no deploy-info file and
 * answers `deployInfoStatus: 'absent'`, and an unreachable database answers
 * `database: null` with `databaseError` set. The API performs no network I/O
 * to answer this, so a manual refresh is cheap and a poll is pointless: the
 * answer changes only when somebody deploys.
 */
export async function getAbout(): Promise<AboutResponse> {
  return api.get<AboutResponse>('/admin/about');
}
