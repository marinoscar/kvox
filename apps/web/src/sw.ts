/// <reference lib="webworker" />

import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, matchPrecache, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

// =============================================================================
// The service worker  (issue #218, epic #215)
// =============================================================================
//
// WHY THIS FILE EXISTS AT ALL
//
// Not for offline support — that is the bonus. On ANDROID CHROME the
// Notifications API is service-worker-only: `new Notification()` throws
// (`Illegal constructor`), and `ServiceWorkerRegistration.showNotification()`
// is the single code path that can put a notification on the screen. Without
// this file every Android phone and tablet gets nothing from epic #215, no
// matter what the permission prompt says. It is also the only place the
// `push`, `notificationclick` and `pushsubscriptionchange` handlers of issues
// #223 and #230 can live — a page cannot host them. Since #470 those three
// handlers are the platform's (`registerNotificationServiceWorkerHandlers`,
// called at the bottom of this file); the precache, the navigation route and the
// update handshake stay this app's.
//
// Offline precaching of the app shell rides along for free, because the epic
// opted into it and the precache manifest is generated either way.
//
// -----------------------------------------------------------------------
// HARD CONSTRAINT: THIS WORKER MUST NEVER CALL THE API
// -----------------------------------------------------------------------
//
// It has no way to authenticate, and any attempt to acquire that ability
// breaks the page. The access token is MEMORY-ONLY — it lives in a private
// field of the `ApiClient` instance in `src/services/api.ts` and is never
// written to storage the worker can read — and the refresh cookie is scoped to
// `path: '/api/auth'` and ROTATED ON EVERY USE. So a worker that tried to
// refresh on its own would spend the one-shot refresh token behind the page's
// back; the page's next refresh would then present a token the server has
// already retired, and the user would be logged out by their own service
// worker. Anything the worker needs from the API must be pushed TO it (a Web
// Push payload, or a `postMessage` from a page that already holds a token),
// never fetched BY it.
//
// -----------------------------------------------------------------------
// SECURITY: NOTHING UNDER `/api` MAY EVER BE CACHED
// -----------------------------------------------------------------------
//
// Cache Storage is origin-scoped and outlives the session: it is not cleared
// by logout, and it is not partitioned per account. Precaching or
// runtime-caching an authenticated JSON response therefore leaves one user's
// data readable by the NEXT person to sign in on a shared device, long after
// the token that fetched it expired. There is deliberately no runtime caching
// strategy registered below for that reason, and `globPatterns` in
// `vite.config.ts` only ever matches built static assets, which never include
// `/api` because the API is a different service entirely.
// =============================================================================

import { registerNotificationServiceWorkerHandlers } from '@marinoscar/platform-web/notifications/service-worker';

declare let self: ServiceWorkerGlobalScope;

// -----------------------------------------------------------------------------
// Precache the app shell
// -----------------------------------------------------------------------------
// `self.__WB_MANIFEST` is replaced at build time by vite-plugin-pwa with the
// list of built assets (see `injectManifest.globPatterns` in `vite.config.ts`).
// `cleanupOutdatedCaches()` deletes precaches left by PREVIOUS revisions of
// this worker; without it every deploy grows Cache Storage by another full copy
// of the bundle until the browser evicts the origin wholesale.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// -----------------------------------------------------------------------------
// SPA navigation: network first, precached shell only when OFFLINE  (issue #88)
// -----------------------------------------------------------------------------
// Every in-app route (`/settings`, `/admin/settings/users`, …) is a client-side
// path with no file behind it. Online, nginx already answers it with
// `index.html` (`try_files $uri $uri/ /index.html` in `apps/web/nginx.conf`),
// so the worker simply forwards the navigation to the network.
//
// NEVER ANSWER AN ONLINE NAVIGATION FROM THE PRECACHE.
//
// A precached `Response` stores the headers the server sent WHEN IT WAS
// PRECACHED — `Content-Security-Policy` included — and replays them verbatim
// on every later hit. The precache entry is only refreshed when `index.html`'s
// CONTENT changes (and in dev, where the entry has no revision, never). So a
// header-only fix on the server never reached an installed client: when nginx's
// `connect-src` gained the storage origin (issue #84), every page this worker
// controlled kept booting under the old `connect-src 'self'` and uploads stayed
// blocked. Fetching the document live means the page always runs under the
// server's CURRENT headers; the precache is strictly the offline fallback.
//
// ONLY A REJECTED `fetch` FALLS BACK. An HTTP error status is a network
// success and is returned as-is: a 502 while nginx or the web container
// restarts, or a 503 maintenance page, is the truth about the server, and
// swapping it for a cached shell would hide it — and would boot the SPA under
// stale headers, the very bug this handler exists to prevent.
//
// `matchPrecache` resolves `undefined` rather than throwing when the shell was
// never precached, in which case the original network error is rethrown and the
// browser shows its own offline page — exactly what happens with no worker.
//
// THE DENYLIST IS LOAD-BEARING, AND `/api/notifications/stream` IS WHY.
//
// `/^\/api\//` keeps the worker out of the API's URL space entirely — the
// "never call the API" rule above holds because no `/api` request ever reaches
// the `fetch` below. Do not narrow it to "just the HTML-ish API routes" or to
// individual paths: that endpoint is SERVER-SENT EVENTS, and an SSE response BY
// DESIGN NEVER ENDS. A handler that took it would hold a `fetch()` open for the
// lifetime of the stream — the worker never reaches idle, the browser
// eventually kills it as unresponsive, and the notification stream dies with
// it. The same reasoning covers `/api/docs` and
// `/api/storage/objects/:id/download`, which are real server responses that
// must never be proxied through, or swapped for, the SPA shell.
//
// (Strictly, `NavigationRoute` only sees requests whose `mode` is `navigate`,
// which an `EventSource` connection — or an upload part PUT — is not. The
// denylist is belt-and-braces against exactly that reasoning being used to
// remove it.)
registerRoute(
  new NavigationRoute(
    async ({ request }) => {
      try {
        return await fetch(request);
      } catch (error) {
        const shell = await matchPrecache('/index.html');
        if (shell) return shell;
        throw error;
      }
    },
    {
      denylist: [/^\/api\//],
    },
  ),
);

// -----------------------------------------------------------------------------
// Take control of open pages as soon as this worker activates
// -----------------------------------------------------------------------------
// This is not a nicety. On a FIRST load the page that installed the worker is
// not controlled by it, and an uncontrolled page has no
// `registration.active` — so `registration.showNotification()` is unavailable
// for that entire session, which on Android means the user grants notification
// permission and then sees nothing until they reload. `clientsClaim()` closes
// that window.
clientsClaim();

// -----------------------------------------------------------------------------
// Update handshake  (`registerType: 'prompt'`)
// -----------------------------------------------------------------------------
// Deliberately NO top-level `self.skipWaiting()`. Under `prompt` a new worker
// installs and then WAITS, so a user mid-session keeps the exact asset
// revisions their loaded page was built against; activating underneath them
// would let a stale chunk request 404 against a rotated filename.
//
// The page decides when to hand over, by posting `{ type: 'SKIP_WAITING' }`.
// Issue #219 wires the UI half (`useRegisterSW` plus an "update available"
// prompt); this listener is the worker half it will call, and it exists now so
// that a worker shipped today is never permanently stuck in `waiting` should a
// build land before that UI does.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// -----------------------------------------------------------------------------
// notificationclick, push and pushsubscriptionchange  (issue #470, epic #467)
// -----------------------------------------------------------------------------
//
// The three notification listeners are the platform's
// (`@marinoscar/platform-web/notifications/service-worker`, the worker-safe entry that pulls in no React), moved there from this
// file's own handlers (issues #223, #230, #449 and #450). They obey the same
// hard constraint as the rest of this file (never call the API) and carry every
// behaviour #453 added, which is why there is no local `push` listener:
//
//   * A REAL PUSH IS ALWAYS SHOWN as an OS notification, including while a
//     visible, focused tab exists (#450). The focused tab's own SSE handler
//     raises no OS toast (and, for a frame flagged `pushed`, no toast at all, #451),
//     so staying quiet here would leave that user with no visible alert. The
//     page and the worker therefore never both toast for the same notification.
//   * NO DUPLICATE: the notification's `tag` is its own id, so repeated pushes
//     for one notification collapse into one OS entry instead of stacking.
//   * A TEST PUSH (`test: true`, from `/admin/settings/push`, #449) is shown even
//     with a focused tab and then acknowledged to every window client
//     (`push-test-received`, with `hadFocusedClient`), which the packaged
//     diagnostics panel reads.
//   * A malformed or empty payload still shows a generic notification, so Chrome
//     never substitutes its own "updated in the background" notice.
//   * `notificationclick` re-validates the link (root-relative only) and hands
//     the click to a page that holds a token, or cold-opens `?n=<id>`.
//   * `pushsubscriptionchange` resubscribes best effort; the page resyncs on
//     its next load.
//
// The icons are this app's own (`public/icons`), passed explicitly rather than
// left to the package defaults, so a rebrand that moves them changes one line.
registerNotificationServiceWorkerHandlers(self, {
  icon: '/icons/icon-192.png',
  badge: '/icons/badge-96.png',
});
