/**
 * The service worker and the upload data plane — issue #22, epic #19.
 *
 * =============================================================================
 * WHY THIS FILE EXISTS
 * =============================================================================
 *
 * Every part of a resumable upload is a cross-origin `PUT` straight to a
 * presigned S3 URL — potentially thousands of them, each up to the part size,
 * for a single multi-gigabyte recording. A service worker that took any of
 * those requests would be a catastrophe of a specific, quiet kind:
 *
 *   * a runtime-caching strategy would write the uploaded BYTES into Cache
 *     Storage, which is origin-scoped, survives logout and is not partitioned
 *     per account — the exact class of leak `sw.ts` forbids for `/api`;
 *   * even a pass-through `fetch` handler would route the body through the
 *     worker, which cannot report upload progress back to the page, so every
 *     progress bar in the app would freeze;
 *   * and a worker that is woken for every part of a long upload is a worker
 *     the browser keeps alive indefinitely.
 *
 * `sw.ts` avoids all three by registering EXACTLY ONE route, a
 * `NavigationRoute`, which by construction matches only requests whose mode is
 * `navigate`. This suite asserts that rather than assuming it — the property
 * is invisible until someone adds an innocuous-looking `registerRoute` for
 * images, and then large uploads silently break.
 *
 * `workbox-routing` is deliberately left REAL here (only `registerRoute`
 * itself is spied on) so the matcher under test is workbox's own, not a
 * reimplementation of it. The sibling suite `service-worker.test.ts` mocks the
 * whole module for its own purposes, which is why this lives in its own file:
 * `vi.mock` is per-file.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { registerRoute } from 'workbox-routing';

vi.mock('workbox-core', () => ({ clientsClaim: vi.fn() }));
vi.mock('workbox-precaching', () => ({
  cleanupOutdatedCaches: vi.fn(),
  matchPrecache: vi.fn(),
  precacheAndRoute: vi.fn(),
}));
vi.mock('workbox-routing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('workbox-routing')>();
  return { ...actual, registerRoute: vi.fn() };
});

/** A workbox `Route`, narrowed to the one member this suite exercises. */
interface CapturedRoute {
  match: (options: { url: URL; request: { mode: string; method: string } }) => unknown;
}

let routes: CapturedRoute[];
let registeredEventTypes: string[];

/** The shape workbox's matcher reads: a `URL` and a request with a `mode`. */
function requestFor(url: string, mode: string, method = 'GET') {
  return { url: new URL(url), request: { mode, method } };
}

beforeAll(async () => {
  (self as unknown as { __WB_MANIFEST: unknown }).__WB_MANIFEST = [];
  (self as unknown as { clients: unknown }).clients = {
    matchAll: vi.fn().mockResolvedValue([]),
    openWindow: vi.fn(),
  };
  (self as unknown as { registration: unknown }).registration = {
    showNotification: vi.fn().mockResolvedValue(undefined),
    pushManager: { subscribe: vi.fn() },
  };

  const addEventListenerSpy = vi.spyOn(self, 'addEventListener');

  await import('../../sw');

  registeredEventTypes = addEventListenerSpy.mock.calls.map(([type]) => String(type));
  addEventListenerSpy.mockRestore();

  routes = vi.mocked(registerRoute).mock.calls.map(([route]) => route as unknown as CapturedRoute);
});

describe('the service worker never touches an upload part PUT', () => {
  it('registers exactly one route, and it is navigation-only', () => {
    // The load-bearing count. A second `registerRoute` — for images, for
    // fonts, for "just the API" — is what would put this worker in front of
    // cross-origin part PUTs.
    expect(routes).toHaveLength(1);
  });

  it('does not match a cross-origin S3 part PUT', () => {
    const s3 = requestFor(
      'https://bucket.s3.eu-west-1.amazonaws.com/objects/obj-1/part-7?X-Amz-Signature=abc',
      'cors',
      'PUT',
    );

    expect(routes[0].match(s3)).toBeFalsy();
  });

  it('does not match the presigned GET used to read an object back either', () => {
    expect(
      routes[0].match(
        requestFor('https://bucket.s3.amazonaws.com/objects/obj-1?X-Amz-Signature=abc', 'cors'),
      ),
    ).toBeFalsy();
  });

  it('still answers a real SPA navigation, and still refuses /api', () => {
    // The route's actual job — asserted so a future "fix" that neuters it to
    // dodge the case above is caught here rather than in production offline.
    expect(routes[0].match(requestFor('http://localhost:3000/settings', 'navigate'))).toBe(true);
    // The existing `/api` denylist, unchanged by this issue.
    expect(
      routes[0].match(requestFor('http://localhost:3000/api/notifications/stream', 'navigate')),
    ).toBe(false);
  });

  it('installs no fetch listener of its own', () => {
    // A bare `fetch` listener would see EVERY request the page makes,
    // including every part PUT, whatever the routes above say.
    expect(registeredEventTypes).not.toContain('fetch');
    expect(registeredEventTypes).toEqual(
      expect.arrayContaining(['message', 'notificationclick', 'push', 'pushsubscriptionchange']),
    );
  });
});
