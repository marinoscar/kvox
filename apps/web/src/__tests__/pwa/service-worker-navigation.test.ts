/**
 * The network-first navigation handler — issue #88.
 *
 * =============================================================================
 * WHY THIS FILE EXISTS
 * =============================================================================
 *
 * `sw.ts`'s single `NavigationRoute` used to answer every navigation from the
 * precached `index.html` (`createHandlerBoundToURL`). A precached `Response`
 * replays the headers the server sent AT PRECACHE TIME — `Content-Security-
 * Policy` included — so a header-only server fix (like issue #84's CSP
 * widening) never reached an already-installed client. The route is now
 * network-first: fetch the navigation live, and fall back to the precached
 * shell ONLY when the fetch itself rejects (offline). An HTTP error status is
 * still a network success and must be returned as-is, never swapped for the
 * cached shell.
 *
 * This suite exercises that handler function directly, bypassing workbox's
 * own matching logic (already covered by `service-worker-uploads.test.ts`
 * and `service-worker.test.ts`'s source-level `/api` denylist assertion —
 * see the last `describe` block below for why route matching is not
 * duplicated here).
 *
 * `workbox-routing` is deliberately left REAL here (only `registerRoute` is
 * spied on) so the captured `NavigationRoute` is workbox's own construction,
 * not a reimplementation of it — the same approach
 * `service-worker-uploads.test.ts` takes, and `vi.mock` is per-file so this
 * lives in its own suite.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerRoute } from 'workbox-routing';
import { matchPrecache } from 'workbox-precaching';

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
  handler: { handle: (options: { request: Request }) => Promise<Response> };
}

let route: CapturedRoute;

/**
 * A minimal stand-in for a browser navigation `Request`. The real `Request`
 * constructor refuses `mode: 'navigate'` — that mode is reserved for actual
 * browser-driven navigations and cannot be constructed from script, even
 * under jsdom's real (undici-backed) `Request`. The handler under test only
 * ever destructures `request` off its options object and hands it straight
 * to `fetch(request)`; it never inspects `.mode` itself (workbox's own
 * `NavigationRoute` matcher already did that before routing here), so an
 * object shaped like a `Request` is enough.
 */
function navigationRequest(url: string): Request {
  return { url, method: 'GET', mode: 'navigate' } as unknown as Request;
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

  await import('../../sw');

  const calls = vi.mocked(registerRoute).mock.calls;
  if (calls.length !== 1) {
    throw new Error(`expected exactly one registerRoute call, got ${calls.length}`);
  }
  route = calls[0][0] as unknown as CapturedRoute;
});

beforeEach(() => {
  vi.mocked(matchPrecache).mockReset();
  vi.stubGlobal('fetch', vi.fn());
});

describe('network-first navigation handler', () => {
  it('online: returns exactly the network Response, headers included, without consulting the precache', async () => {
    const networkResponse = new Response('<html>live</html>', {
      status: 200,
      headers: { 'Content-Security-Policy': "default-src 'self' https://storage.example.com" },
    });
    vi.mocked(fetch).mockResolvedValue(networkResponse);

    const request = navigationRequest('http://localhost:3000/settings');
    const result = await route.handler.handle({ request });

    expect(result).toBe(networkResponse);
    expect(result.headers.get('Content-Security-Policy')).toBe(
      "default-src 'self' https://storage.example.com",
    );
    expect(matchPrecache).not.toHaveBeenCalled();
  });

  it.each([502, 503])(
    'HTTP %d passes through unchanged — an error status is a network success',
    async (status) => {
      const errorResponse = new Response('error', { status });
      vi.mocked(fetch).mockResolvedValue(errorResponse);

      const request = navigationRequest('http://localhost:3000/settings');
      const result = await route.handler.handle({ request });

      expect(result).toBe(errorResponse);
      expect(result.status).toBe(status);
      expect(matchPrecache).not.toHaveBeenCalled();
    },
  );

  it('offline: falls back to the precached shell when fetch rejects', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'));
    const shellResponse = new Response('<html>shell</html>', { status: 200 });
    vi.mocked(matchPrecache).mockResolvedValue(shellResponse);

    const request = navigationRequest('http://localhost:3000/settings');
    const result = await route.handler.handle({ request });

    expect(result).toBe(shellResponse);
    expect(matchPrecache).toHaveBeenCalledTimes(1);
    expect(matchPrecache).toHaveBeenCalledWith('/index.html');
  });

  it('offline with no precached shell: rejects with the original network error', async () => {
    const networkError = new TypeError('Failed to fetch');
    vi.mocked(fetch).mockRejectedValue(networkError);
    vi.mocked(matchPrecache).mockResolvedValue(undefined);

    const request = navigationRequest('http://localhost:3000/settings');

    await expect(route.handler.handle({ request })).rejects.toBe(networkError);
  });

  it('forwards the exact same Request object it was given to fetch, called once', async () => {
    const networkResponse = new Response('<html>live</html>', { status: 200 });
    vi.mocked(fetch).mockResolvedValue(networkResponse);

    const request = navigationRequest('http://localhost:3000/admin/settings/users');
    await route.handler.handle({ request });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(request);
  });
});

// =============================================================================
// Route matching — NOT duplicated here
// =============================================================================
//
// `service-worker-uploads.test.ts` already exercises `route.match(...)` for
// this exact route: a real SPA navigation matches, an `/api/...` navigation
// is denylisted, and a non-navigate cross-origin request (a `cors`-mode S3
// part PUT, and a presigned GET) does not match at all. `service-worker
// .test.ts` additionally pins the `/api` denylist at the source level. Both
// suites predate this file and were written against the same single
// `NavigationRoute` this suite exercises the handler of, so re-asserting
// `.match(...)` here would just be the same assertions under a third name.
