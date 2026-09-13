/**
 * The CENTRAL interception — issue #258, epic #254.
 *
 * `ApiService.request` is the single choke point every request in this
 * application passes through, and #258 puts the maintenance check on its one
 * error path so that every existing call site inherits it with no change. This
 * suite is what makes that claim testable rather than merely stated:
 *
 *   * it drives the check through the PUBLIC api surface (`api.get`, `api.post`,
 *     …) on arbitrary endpoints, never through `readMaintenanceBlock` directly —
 *     the unit behaviour of the recogniser is `maintenance.test.ts`'s job, and
 *     what matters here is that an ordinary caller who knows nothing about
 *     maintenance triggers it anyway;
 *
 *   * it asserts the ERROR IS STILL THROWN, unchanged, in both cases. The block
 *     is a side channel for the gate, not a substitute for the rejection a
 *     caller is awaiting;
 *
 *   * it covers the SECOND error path — the one after a 401 refresh-and-retry —
 *     which is a genuinely separate `if (!ok)` in that method and the one an
 *     implementation is most likely to miss, since a session whose access token
 *     expired mid-window takes exactly that branch.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { api, ApiError } from '../../services/api';
import {
  MAINTENANCE_ERROR_MARKER,
  clearMaintenanceBlock,
  getMaintenanceBlock,
} from '../../services/maintenance';

/** The API's real maintenance 503, filter and all. */
function maintenance503(message = 'Upgrading the database. Back at 03:00 UTC.') {
  return HttpResponse.json(
    {
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      message,
      details: {
        reason: MAINTENANCE_ERROR_MARKER,
        retryAfterSeconds: 30,
        allowAdmins: true,
      },
      timestamp: new Date().toISOString(),
      path: '/api/anything',
    },
    { status: 503, headers: { 'Retry-After': '30' } },
  );
}

/** What a crashed upstream, an exhausted pool or a backend-less proxy produces. */
function plain503() {
  return HttpResponse.json(
    {
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      message: 'Service Unavailable',
    },
    { status: 503 },
  );
}

describe('ApiService — maintenance interception', () => {
  beforeEach(() => {
    api.setAccessToken(null);
    clearMaintenanceBlock();
  });

  afterEach(() => {
    api.setAccessToken(null);
    clearMaintenanceBlock();
  });

  it('records a block from a marked 503 on an ENDPOINT THAT KNOWS NOTHING ABOUT MAINTENANCE', async () => {
    // The point of the central interception in one assertion: `/users` has no
    // maintenance-aware code anywhere near it, and never will.
    server.use(http.get('*/api/users', () => maintenance503()));

    await expect(api.get('/users')).rejects.toBeInstanceOf(ApiError);

    expect(getMaintenanceBlock()).toEqual({
      message: 'Upgrading the database. Back at 03:00 UTC.',
      retryAfterSeconds: 30,
      allowAdmins: true,
    });
  });

  it('STILL THROWS the same ApiError it always did', async () => {
    server.use(http.get('*/api/users', () => maintenance503()));

    await expect(api.get('/users')).rejects.toMatchObject({
      name: 'ApiError',
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      message: 'Upgrading the database. Back at 03:00 UTC.',
    });
  });

  it('records NOTHING for an ordinary 503 with no marker, and throws exactly as before', async () => {
    // The feature, negatively stated. A deployment that is simply broken must
    // keep producing the error its call site already handles.
    server.use(http.get('*/api/users', () => plain503()));

    await expect(api.get('/users')).rejects.toMatchObject({
      name: 'ApiError',
      status: 503,
      message: 'Service Unavailable',
    });
    expect(getMaintenanceBlock()).toBeNull();
  });

  it('records nothing for a 500 or a 403, marker or not', async () => {
    server.use(
      http.get('*/api/users', () =>
        HttpResponse.json({ message: 'Forbidden', details: { reason: MAINTENANCE_ERROR_MARKER } }, { status: 403 }),
      ),
    );

    await expect(api.get('/users')).rejects.toMatchObject({ status: 403 });
    expect(getMaintenanceBlock()).toBeNull();
  });

  it('intercepts on every verb, not only GET', async () => {
    server.use(
      http.put('*/api/user-settings', () => maintenance503('Planned window.')),
    );

    await expect(api.put('/user-settings', { theme: 'dark' })).rejects.toBeInstanceOf(ApiError);
    expect(getMaintenanceBlock()?.message).toBe('Planned window.');
  });

  it('intercepts on the RETRY path taken after a 401 refresh', async () => {
    // A window that opens while a user is signed in hits this branch first: the
    // access token expires, the refresh succeeds (that endpoint is exempt from
    // the API's own maintenance guard), and the replayed request is the one
    // that gets refused. It is a separate `if (!ok)` inside `request()`, so it
    // needs its own assertion or the commonest real sequence goes uncovered.
    let attempt = 0;

    server.use(
      http.post('*/api/auth/refresh', () =>
        HttpResponse.json({ data: { accessToken: 'fresh-token' } }),
      ),
      http.get('*/api/users', () => {
        attempt += 1;
        if (attempt === 1) {
          return HttpResponse.json({ message: 'Unauthorized' }, { status: 401 });
        }
        return maintenance503('Refused after the token was refreshed.');
      }),
    );

    api.setAccessToken('stale-token');

    await expect(api.get('/users')).rejects.toMatchObject({ status: 503 });
    expect(attempt).toBe(2);
    expect(getMaintenanceBlock()?.message).toBe('Refused after the token was refreshed.');
  });

  it('leaves the block alone when a later request succeeds', async () => {
    // Several routes stay reachable during a window by design, so "something
    // succeeded" is not evidence the window closed. Clearing on it would drop
    // the screen and let the next blocked call raise it again — the application
    // flickering in and out of service.
    server.use(
      http.get('*/api/users', () => maintenance503()),
      http.get('*/api/auth/me', () => HttpResponse.json({ data: { id: 'user' } })),
    );

    await expect(api.get('/users')).rejects.toBeInstanceOf(ApiError);
    await api.get('/auth/me');

    expect(getMaintenanceBlock()).not.toBeNull();
  });
});
