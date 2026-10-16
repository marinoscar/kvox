/**
 * This app's binding of the platform notifications slice (issue #470, epic #467).
 *
 * `@marinoscar/platform-web/notifications/{headless,ui}` owns the notification
 * centre (`NotificationProvider`, the bell, the permission banner), the per-user
 * preference page, the admin policy, Web Push and broadcast pages, and the
 * service-worker helpers. The slice is configured ONCE, here, before anything
 * renders; `main.tsx` imports this module for that side effect.
 *
 *   - `api`: `appPlatformApi`, the packaged client over this app's one
 *     `PlatformHttpClient`, so every call carries the same bearer token, the same
 *     one refresh-and-retry on a 401 and the same maintenance recogniser as the
 *     rest of the app.
 *   - `apiBaseUrl`: `/api` (same-origin hosting), used for the SSE stream URL.
 *   - `connectSse`: the packaged GET Server-Sent Events connector. Without it the
 *     inbox still loads but no live frame arrives, so the bell would go stale
 *     until a reload.
 */

import { connectSse } from '@marinoscar/platform-web/core';
import { configureNotificationsWeb } from '@marinoscar/platform-web/notifications/headless';
import { API_BASE_URL } from '../services/api';
import { appPlatformApi } from './platformHost';

configureNotificationsWeb({
  api: appPlatformApi,
  apiBaseUrl: API_BASE_URL,
  connectSse,
});
