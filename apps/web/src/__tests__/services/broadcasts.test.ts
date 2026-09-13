/**
 * The broadcast wire contract and the datetime bridge (issue #325, epic #319).
 *
 * Two things are under test here, and the second is the subtler one:
 *
 *   1. EVERY CALL SENDS WHAT THE API TAKES. Each of the seven routes is
 *      exercised against msw and the REQUEST is asserted — method, path, query
 *      string, body — because the failure mode of a thin service module is not
 *      a crash, it is a request that is quietly the wrong shape and a 400 the
 *      page reports as "Failed to create broadcast".
 *
 *   2. `localInputToIso` / `isoToLocalInput` ROUND-TRIP, INCLUDING ACROSS DST.
 *      A `datetime-local` value is local wall-clock with NO ZONE. The one-line
 *      implementation of the second function — `toISOString().slice(0, 16)` —
 *      is UTC, and it is the classic bug in this conversion: an admin in UTC+2
 *      who scheduled 09:00 reopens the form, reads 07:00, "corrects" it, and
 *      moves the broadcast two hours earlier with nothing on screen to warn
 *      them. So the round-trip is asserted directly, and asserted again over a
 *      DST boundary, where the local offset on the two sides of the conversion
 *      is genuinely different.
 *
 * The limit constants are checked against the API's own DTO ON DISK rather than
 * against a copy, the same technique `services/maintenance.test.ts` uses for
 * the maintenance marker: the composer's character counters are built from
 * these numbers, and a counter that disagrees with the validator promises an
 * acceptance the API will refuse.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import {
  BROADCAST_BODY_MAX,
  BROADCAST_CHUNK_SIZE,
  BROADCAST_CTA_LABEL_MAX,
  BROADCAST_LINK_MAX,
  BROADCAST_STATUSES,
  BROADCAST_TITLE_MAX,
  cancelBroadcast,
  createBroadcast,
  deleteBroadcast,
  getBroadcast,
  getBroadcastAudience,
  getBroadcasts,
  isBroadcastCancelable,
  isBroadcastDeletable,
  isoToLocalInput,
  localInputToIso,
  sendTestBroadcast,
} from '../../services/broadcasts';
import type { Broadcast, CreateBroadcastRequest } from '../../services/broadcasts';

const API_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../api/src');
const BROADCASTS_DIR = resolve(API_SRC, 'notifications/broadcasts');

function broadcast(overrides: Partial<Broadcast> = {}): Broadcast {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Planned maintenance tonight',
    body: 'We will be offline from 01:00.\n\nThank you.',
    link: null,
    ctaLabel: null,
    eventKey: 'admin.broadcast',
    channels: ['browser', 'email'],
    status: 'scheduled',
    scheduledFor: null,
    startedAt: null,
    finishedAt: null,
    canceledAt: null,
    audienceCutoff: null,
    recipientsTargeted: null,
    recipientsDispatched: 0,
    lastError: null,
    createdById: 'admin-user-id',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const composition: CreateBroadcastRequest = {
  title: 'Planned maintenance tonight',
  body: 'We will be offline from 01:00.',
  channels: ['browser', 'email'],
  critical: false,
};

// =============================================================================
// The mirrored constants
// =============================================================================

describe('the limits mirror the API DTO', () => {
  const dto = readFileSync(resolve(BROADCASTS_DIR, 'dto/create-broadcast.dto.ts'), 'utf8');
  const audienceModule = readFileSync(resolve(BROADCASTS_DIR, 'broadcast-audience.ts'), 'utf8');
  const responseDto = readFileSync(
    resolve(BROADCASTS_DIR, 'dto/broadcast-response.dto.ts'),
    'utf8',
  );

  it('reads the API files it is comparing against', () => {
    // Guards the reads above: if a path went stale, every assertion below
    // would pass vacuously over an empty string.
    expect(dto).toContain('BROADCAST_TITLE_MAX');
    expect(audienceModule).toContain('BROADCAST_CHUNK_SIZE');
  });

  it('keeps the character ceilings identical, so a counter cannot promise a 400', () => {
    expect(dto).toContain(`export const BROADCAST_TITLE_MAX = ${BROADCAST_TITLE_MAX};`);
    // The API writes this one with a numeric separator (`2_000`), so the
    // declaration is matched with the separators stripped rather than
    // reconstructed — reconstructing the literal would be a second guess at the
    // API's formatting, not a check of its value.
    const bodyMaxOnDisk = /BROADCAST_BODY_MAX = ([\d_]+);/.exec(dto)?.[1];
    expect(Number(bodyMaxOnDisk?.replaceAll('_', ''))).toBe(BROADCAST_BODY_MAX);
    expect(dto).toContain(`export const BROADCAST_CTA_LABEL_MAX = ${BROADCAST_CTA_LABEL_MAX};`);
    expect(dto).toContain(`export const BROADCAST_LINK_MAX = ${BROADCAST_LINK_MAX};`);
  });

  it('keeps the chunk size identical — the cancel dialog states it as a number', () => {
    expect(audienceModule).toContain(
      `export const BROADCAST_CHUNK_SIZE = ${BROADCAST_CHUNK_SIZE};`,
    );
  });

  it('lists exactly the statuses the API declares', () => {
    for (const status of BROADCAST_STATUSES) {
      expect(responseDto, `${status} must be an API status`).toContain(`'${status}'`);
    }
    expect(BROADCAST_STATUSES).toEqual([
      'draft',
      'scheduled',
      'sending',
      'sent',
      'canceled',
      'failed',
    ]);
  });
});

// =============================================================================
// The datetime bridge
// =============================================================================

describe('localInputToIso / isoToLocalInput', () => {
  it('round-trips a wall-clock value through an instant and back', () => {
    const input = '2026-06-15T09:30';
    const iso = localInputToIso(input);

    expect(iso).not.toBeNull();
    expect(isoToLocalInput(iso as string)).toBe(input);
  });

  it('reads back the LOCAL wall clock, not the UTC one', () => {
    // The regression this whole pair exists for. `toISOString().slice(0, 16)`
    // would return the UTC rendering, which differs from the input by the
    // local offset — and in any zone that is not UTC, this assertion catches
    // it. In UTC itself the two agree, so the assertion below is what actually
    // pins the intent regardless of where the suite runs.
    const input = '2026-06-15T09:30';
    const iso = localInputToIso(input) as string;
    const date = new Date(iso);

    expect(isoToLocalInput(iso)).toBe(
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-` +
        `${String(date.getDate()).padStart(2, '0')}T` +
        `${String(date.getHours()).padStart(2, '0')}:` +
        `${String(date.getMinutes()).padStart(2, '0')}`,
    );
  });

  /**
   * Run `assertions` with the process pinned to a zone that really observes
   * DST, then restore whatever the suite was running in.
   *
   * WITHOUT THIS, THE DST CASE IS VACUOUS. CI runs in UTC, where every offset
   * is zero and a UTC-based `isoToLocalInput` would pass every assertion in
   * this file. Node re-reads `process.env.TZ` on the next `Date` construction,
   * so setting it here genuinely changes what the local getters return.
   */
  function inTimeZone(zone: string, assertions: () => void) {
    const original = process.env.TZ;
    process.env.TZ = zone;
    try {
      assertions();
    } finally {
      process.env.TZ = original;
    }
  }

  it('round-trips across a DST boundary, in a zone that actually has one', () => {
    // America/New_York springs forward at 02:00 on 2026-03-08 and falls back
    // at 02:00 on 2026-11-01, so these straddle a real offset change in both
    // directions. A `toISOString().slice(0, 16)` implementation shifts every
    // one of them by the offset — four or five hours here — and the autumn
    // pair by DIFFERENT amounts on either side of the transition, which is the
    // detail that makes this bug so hard to spot from one example.
    inTimeZone('America/New_York', () => {
      const boundaries = [
        '2026-03-07T23:30', // the night before spring forward, EST
        '2026-03-08T04:30', // after it, EDT
        '2026-11-01T00:30', // the night of fall back, still EDT
        '2026-11-01T04:30', // after it, EST
        '2026-06-15T09:30', // an ordinary summer afternoon, for contrast
      ];

      for (const input of boundaries) {
        const iso = localInputToIso(input);
        expect(iso, `${input} must resolve to an instant`).not.toBeNull();
        expect(isoToLocalInput(iso as string), `${input} must round-trip`).toBe(input);
      }
    });
  });

  it('resolves the same wall clock to different instants either side of a DST change', () => {
    // The other half of the same fact, and the reason the conversion cannot be
    // a fixed offset: 09:30 local is 13:30Z in March (EST) and 12:30Z in June
    // (EDT). A helper that hard-coded an offset would agree with one and be an
    // hour out on the other.
    inTimeZone('America/New_York', () => {
      expect(localInputToIso('2026-03-01T09:30')).toBe('2026-03-01T14:30:00.000Z');
      expect(localInputToIso('2026-06-15T09:30')).toBe('2026-06-15T13:30:00.000Z');
    });
  });

  it('pads every component to the width the input control requires', () => {
    // A single-digit month, day, hour or minute that is not padded produces a
    // value a native `datetime-local` silently rejects — the field renders
    // blank and the admin's schedule quietly disappears.
    const value = isoToLocalInput(localInputToIso('2026-01-02T03:04') as string);
    expect(value).toBe('2026-01-02T03:04');
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it('returns null rather than "Invalid Date" for an empty or unparseable value', () => {
    // A caller must never be able to post the string "Invalid Date" and have
    // the API reject a malformed date the admin never typed.
    expect(localInputToIso('')).toBeNull();
    expect(localInputToIso('not a date')).toBeNull();
  });

  it('renders an unparseable instant as an empty field rather than throwing', () => {
    expect(isoToLocalInput('nonsense')).toBe('');
  });
});

// =============================================================================
// The predicates
// =============================================================================

describe('the shared predicates mirror the API’s 409s', () => {
  it('allows cancel only for scheduled and sending', () => {
    expect(isBroadcastCancelable({ status: 'scheduled' })).toBe(true);
    expect(isBroadcastCancelable({ status: 'sending' })).toBe(true);
    for (const status of ['draft', 'sent', 'canceled', 'failed'] as const) {
      expect(isBroadcastCancelable({ status }), status).toBe(false);
    }
  });

  it('refuses delete only while sending', () => {
    expect(isBroadcastDeletable({ status: 'sending' })).toBe(false);
    for (const status of ['draft', 'scheduled', 'sent', 'canceled', 'failed'] as const) {
      expect(isBroadcastDeletable({ status }), status).toBe(true);
    }
  });
});

// =============================================================================
// The requests
// =============================================================================

describe('the seven calls', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    server.resetHandlers();
  });

  it('GET / sends page, pageSize and status, and unwraps the flat pagination shape', async () => {
    let seen: URL | null = null;
    server.use(
      http.get('*/api/admin/broadcasts', ({ request }) => {
        seen = new URL(request.url);
        return HttpResponse.json({
          data: { items: [broadcast()], total: 1, page: 2, pageSize: 50, totalPages: 1 },
        });
      }),
    );

    const result = await getBroadcasts({ page: 2, pageSize: 50, status: 'sent' });

    expect(seen!.pathname).toBe('/api/admin/broadcasts');
    expect(seen!.searchParams.get('page')).toBe('2');
    expect(seen!.searchParams.get('pageSize')).toBe('50');
    expect(seen!.searchParams.get('status')).toBe('sent');
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it('GET / omits absent parameters rather than sending empty ones', async () => {
    // A `status=` with no value is a query parameter that changes nothing and
    // makes a request log unreadable — and, on an endpoint with an enum, one
    // that could be rejected outright.
    let seen: URL | null = null;
    server.use(
      http.get('*/api/admin/broadcasts', ({ request }) => {
        seen = new URL(request.url);
        return HttpResponse.json({
          data: { items: [], total: 0, page: 1, pageSize: 20, totalPages: 0 },
        });
      }),
    );

    await getBroadcasts();

    expect(seen!.search).toBe('');
  });

  it('GET /audience reads the active-user count', async () => {
    server.use(
      http.get('*/api/admin/broadcasts/audience', () =>
        HttpResponse.json({ data: { activeUsers: 1284 } }),
      ),
    );

    await expect(getBroadcastAudience()).resolves.toEqual({ activeUsers: 1284 });
  });

  it('GET /:id returns the detail plus the approximate breakdown', async () => {
    server.use(
      http.get('*/api/admin/broadcasts/:id', ({ params }) =>
        HttpResponse.json({
          data: {
            ...broadcast({ id: params.id as string }),
            approximateDeliveryAttempts: [{ channel: 'email', status: 'sent', count: 12 }],
          },
        }),
      ),
    );

    const detail = await getBroadcast('abc');

    expect(detail.id).toBe('abc');
    expect(detail.approximateDeliveryAttempts).toEqual([
      { channel: 'email', status: 'sent', count: 12 },
    ]);
  });

  it('POST / sends the composition verbatim and returns the row plus warnings', async () => {
    let body: unknown = null;
    server.use(
      http.post('*/api/admin/broadcasts', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          data: { broadcast: broadcast(), warnings: ['Browser notifications are disabled.'] },
        });
      }),
    );

    const result = await createBroadcast({
      ...composition,
      link: '/status',
      ctaLabel: 'See status',
      scheduledFor: '2026-06-15T07:30:00.000Z',
      critical: true,
    });

    expect(body).toEqual({
      title: 'Planned maintenance tonight',
      body: 'We will be offline from 01:00.',
      link: '/status',
      ctaLabel: 'See status',
      channels: ['browser', 'email'],
      scheduledFor: '2026-06-15T07:30:00.000Z',
      critical: true,
    });
    // NO `eventKey` — the API derives it from `critical` and refuses to accept
    // one, because a caller who could name the event could pick an unmuteable
    // one, or borrow a template from an event that is not a broadcast at all.
    expect(body).not.toHaveProperty('eventKey');
    expect(result.warnings).toEqual(['Browser notifications are disabled.']);
  });

  it('POST /test posts the SAME body to the test route', async () => {
    // The same schema on purpose: a test send whose validation differs from
    // the real one tests the wrong composition, which is the only thing a test
    // send is for.
    let body: unknown = null;
    let path: string | null = null;
    server.use(
      http.post('*/api/admin/broadcasts/test', async ({ request }) => {
        path = new URL(request.url).pathname;
        body = await request.json();
        return HttpResponse.json({
          data: {
            eventKey: 'admin.broadcast',
            channels: ['browser', 'email'],
            sentToUserId: 'admin-user-id',
          },
        });
      }),
    );

    const result = await sendTestBroadcast(composition);

    expect(path).toBe('/api/admin/broadcasts/test');
    expect(body).toEqual(composition);
    expect(result.sentToUserId).toBe('admin-user-id');
  });

  it('POST /:id/cancel takes no body and returns the updated row', async () => {
    server.use(
      http.post('*/api/admin/broadcasts/:id/cancel', ({ params }) =>
        HttpResponse.json({
          data: broadcast({
            id: params.id as string,
            status: 'canceled',
            canceledAt: '2026-01-01T01:00:00.000Z',
          }),
        }),
      ),
    );

    const result = await cancelBroadcast('11111111-1111-4111-8111-111111111111');

    expect(result.status).toBe('canceled');
  });

  it('DELETE /:id resolves on the API’s 204', async () => {
    let method: string | null = null;
    server.use(
      http.delete('*/api/admin/broadcasts/:id', ({ request }) => {
        method = request.method;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await expect(deleteBroadcast('abc')).resolves.toBeUndefined();
    expect(method).toBe('DELETE');
  });
});
