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

// Issue #258, epic #254; the recogniser is the platform's since #464. Imported
// here — and nowhere near a page — because the interception is CENTRAL: see
// `onErrorResponse` below.
import { noticeMaintenance } from './maintenance';
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
 * former `ApiService` of this file, moved to the package; what stays this app's is
 * what it is configured with.
 *
 * `ApiError` is re-exported so the ~30 call sites that import it from
 * `services/api` keep doing so. It is the package's class (same `message`,
 * `status`, `code`, `details`), so an `instanceof` check still matches.
 */
export { ApiError };

/*
 * Maintenance (#258, epic #254): THE ONLY PLACE THE WEB APP LOOKS FOR THE
 * MARKER is the client's single error path, `onErrorResponse` below, so every
 * caller inherits maintenance handling without a line of change. An ordinary
 * 503 is untouched; see `services/maintenance.ts`.
 */

export const api = new PlatformHttpClient({
  baseUrl: API_BASE_URL,
  // Named after the app so two apps on one origin never contend for a lock.
  refreshLockName: `${APP_SLUG}-auth-refresh`,
  onErrorResponse: noticeMaintenance,
});

/** Request options of {@link api}, for the few callers that name the type. */
export type RequestOptions = PlatformHttpRequestOptions;

// Import types
import type { ProfileImageMutationResponse } from '../types';
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
