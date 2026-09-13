// =============================================================================
// Integration tests for the admin broadcasts API (issue #324, epic #319)
// =============================================================================
//
// `src/notifications/broadcasts/broadcasts.service.spec.ts` proves what the
// service DECIDES. This suite proves the things only the real Nest router, the
// real guards and the real global validation pipe can answer, and nothing
// else — every case here fails for a reason a direct call to the service could
// not produce:
//
//   1. ROUTE ORDER. Nest matches in declaration order, so
//      `POST /admin/broadcasts/test` and `GET /admin/broadcasts/audience` are
//      swallowed by `:id` if a parameterised route is ever declared above
//      them. There is no boot-time error for that and no log line — the only
//      way it is caught is a request going through the real router, which is
//      what these tests do. Re-ordering the controller's methods must fail a
//      test here rather than cause a production incident.
//   2. RBAC. `@Auth({ roles, permissions })` is guards, and guards only run in
//      a request pipeline. A unit test calling `controller.create()` directly
//      would pass with the decorator deleted.
//   3. VALIDATION. Every rule in `CreateBroadcastDto` — the root-relative link
//      allowlist, the future-dated schedule, the critical/browser invariant —
//      is only exercised by the global `ZodValidationPipe` when a real body is
//      parsed. This is where issue #321's ruling is actually enforced, so it
//      is where the enforcement is asserted.
//
// The database is the shared deep mock (`useMockDatabase: true`), so what
// these assert about a response body is the shape and the wiring, never the
// rows — which is the correct division: which rows a `where` matches is
// Postgres's answer.
//
// Harness copied field-for-field from `test/jobs/job-admin.integration.spec.ts`.
// =============================================================================

import request from 'supertest';

import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  authHeader,
  createMockAdminUser,
  createMockViewerUser,
} from '../helpers/auth-mock.helper';

const BROADCAST_ID = '33333333-3333-4333-8333-333333333333';

/** A body that passes every rule in the DTO. Each 400 case below breaks one. */
const VALID_BODY = {
  title: 'Planned maintenance on Sunday',
  body: 'The application will be unavailable between 02:00 and 04:00 UTC.',
  channels: ['email', 'browser'],
};

function broadcastRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BROADCAST_ID,
    title: VALID_BODY.title,
    body: VALID_BODY.body,
    link: null,
    ctaLabel: null,
    eventKey: 'admin.broadcast',
    channels: ['email', 'browser'],
    status: 'scheduled',
    scheduledFor: null,
    startedAt: null,
    finishedAt: null,
    canceledAt: null,
    audienceCutoff: null,
    cursorUserId: null,
    recipientsTargeted: null,
    recipientsDispatched: 0,
    lastError: null,
    createdById: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('Admin broadcasts API (Integration)', () => {
  let context: TestContext;
  let prisma: any;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  }, 60000);

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();

    prisma = context.prismaMock;
    prisma.notificationBroadcast.findMany.mockResolvedValue([]);
    prisma.notificationBroadcast.count.mockResolvedValue(0);
    prisma.notificationBroadcast.findUnique.mockResolvedValue(broadcastRow());
    prisma.notificationBroadcast.create.mockImplementation(async ({ data }: any) =>
      broadcastRow(data)
    );
    prisma.notificationBroadcast.updateMany.mockResolvedValue({ count: 1 });
    prisma.notificationBroadcast.delete.mockResolvedValue(broadcastRow());
    prisma.notificationDelivery.groupBy.mockResolvedValue([]);
    prisma.auditEvent.create.mockResolvedValue({});
    // The audience count and the start job the create path enqueues.
    prisma.user.count.mockResolvedValue(1284);
    prisma.job.create.mockResolvedValue({ id: 'job-1' });
  });

  const server = () => context.app.getHttpServer();

  // =========================================================================
  // Route resolution — the reason this file exists
  // =========================================================================

  describe('literal routes resolve before :id', () => {
    it('reads GET /admin/broadcasts/audience as the count, not as a broadcast id', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(server())
        .get('/api/admin/broadcasts/audience')
        .set(authHeader(admin.accessToken))
        .expect(200);

      // If `@Get(':id')` were declared above this route, `audience` would be
      // captured as `:id` and answered by `ParseUUIDPipe` with a 400 about a
      // malformed UUID. Asserting THE COUNT RAN — the number, and the audience
      // predicate behind it — is what makes this a route-order test rather
      // than a status-code coincidence.
      expect(response.body.data).toEqual({ activeUsers: 1284 });
      const where = prisma.user.count.mock.calls[0][0].where;
      expect(where.isActive).toBe(true);
      expect(where.createdAt.lte).toBeInstanceOf(Date);
    });

    it('reads POST /admin/broadcasts/test as the test send, not as a broadcast id', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(server())
        .post('/api/admin/broadcasts/test')
        .set(authHeader(admin.accessToken))
        .send(VALID_BODY)
        .expect(200);

      // The test handler ran: it answers with the derived event key, the
      // channels it narrowed to, and the CALLER as the recipient. A `:id`
      // route capturing this would answer 400 (malformed UUID) or 404.
      expect(response.body.data).toEqual({
        eventKey: 'admin.broadcast',
        channels: ['email', 'browser'],
        sentToUserId: admin.id,
      });
      // NO ROW AND NO JOB. That is the whole contract of a test send.
      expect(prisma.notificationBroadcast.create).not.toHaveBeenCalled();
      expect(prisma.job.create).not.toHaveBeenCalled();
    });

    it('still routes a real UUID to the :id handlers', async () => {
      const admin = await createMockAdminUser(context);
      prisma.notificationBroadcast.findUnique.mockResolvedValue(
        broadcastRow({ status: 'sending' })
      );

      // 409 "currently sending" proves the request reached `remove(id)` — a
      // routing failure here would be a 404 from no matching route.
      await request(server())
        .delete(`/api/admin/broadcasts/${BROADCAST_ID}`)
        .set(authHeader(admin.accessToken))
        .expect(409);
    });
  });

  // =========================================================================
  // RBAC — every route, both permissions
  // =========================================================================

  describe('authorization', () => {
    const readRoutes: Array<[string, 'get', string]> = [
      ['GET /admin/broadcasts/audience', 'get', '/api/admin/broadcasts/audience'],
      ['GET /admin/broadcasts', 'get', '/api/admin/broadcasts'],
      ['GET /admin/broadcasts/:id', 'get', `/api/admin/broadcasts/${BROADCAST_ID}`],
    ];

    const writeRoutes: Array<[string, 'post' | 'delete', string]> = [
      ['POST /admin/broadcasts/test', 'post', '/api/admin/broadcasts/test'],
      ['POST /admin/broadcasts', 'post', '/api/admin/broadcasts'],
      ['POST /admin/broadcasts/:id/cancel', 'post', `/api/admin/broadcasts/${BROADCAST_ID}/cancel`],
      ['DELETE /admin/broadcasts/:id', 'delete', `/api/admin/broadcasts/${BROADCAST_ID}`],
    ];

    const allRoutes = [...readRoutes, ...writeRoutes];

    it.each(allRoutes)('%s rejects an anonymous caller', async (_name, method, path) => {
      await request(server())[method](path).expect(401);
    });

    it.each(readRoutes)(
      '%s rejects a caller without broadcasts:read',
      async (_name, method, path) => {
        const viewer = await createMockViewerUser(context);

        // `broadcasts:read`/`broadcasts:write` are seeded to Admin only
        // (#320): reading this surface shows what has been announced, and
        // writing it messages every active user.
        await request(server())[method](path).set(authHeader(viewer.accessToken)).expect(403);
      }
    );

    it.each(writeRoutes)(
      '%s rejects a caller without broadcasts:write',
      async (_name, method, path) => {
        const viewer = await createMockViewerUser(context);

        await request(server())
          [method](path)
          .set(authHeader(viewer.accessToken))
          .send(VALID_BODY)
          .expect(403);
      }
    );

    it('admits a seeded admin on every one of the seven routes', async () => {
      const admin = await createMockAdminUser(context);
      const auth = authHeader(admin.accessToken);

      await request(server()).get('/api/admin/broadcasts/audience').set(auth).expect(200);
      await request(server())
        .post('/api/admin/broadcasts/test')
        .set(auth)
        .send(VALID_BODY)
        .expect(200);
      await request(server()).get('/api/admin/broadcasts').set(auth).expect(200);
      await request(server())
        .post('/api/admin/broadcasts')
        .set(auth)
        .send(VALID_BODY)
        .expect(201);
      await request(server())
        .get(`/api/admin/broadcasts/${BROADCAST_ID}`)
        .set(auth)
        .expect(200);
      await request(server())
        .post(`/api/admin/broadcasts/${BROADCAST_ID}/cancel`)
        .set(auth)
        .expect(200);
      await request(server())
        .delete(`/api/admin/broadcasts/${BROADCAST_ID}`)
        .set(auth)
        .expect(204);
    });
  });

  // =========================================================================
  // Validation, through the real pipe — where #321's ruling is enforced
  // =========================================================================

  describe('POST /admin/broadcasts validation', () => {
    const invalid: Array<[string, Record<string, unknown>]> = [
      [
        'no channels at all — a broadcast that reaches nobody but reports success',
        { ...VALID_BODY, channels: [] },
      ],
      [
        'a scheduledFor in the past, which would send to everybody immediately',
        { ...VALID_BODY, scheduledFor: new Date(Date.now() - 60_000).toISOString() },
      ],
      [
        'an absolute link — `sanitizeLink` would drop it silently at render time',
        { ...VALID_BODY, link: 'https://evil.example' },
      ],
      [
        'a protocol-relative link, the classic bypass of a naive "starts with /" check',
        { ...VALID_BODY, link: '//evil.example' },
      ],
      [
        'critical over email only — no durable in-app record would exist (#321)',
        { ...VALID_BODY, critical: true, channels: ['email'] },
      ],
      ['a body past the 2000-character ceiling', { ...VALID_BODY, body: 'x'.repeat(2001) }],
      ['a ctaLabel with no link to point at', { ...VALID_BODY, ctaLabel: 'Read more' }],
      ['a title past the 120-character ceiling', { ...VALID_BODY, title: 'x'.repeat(121) }],
      ['a duplicated channel', { ...VALID_BODY, channels: ['email', 'email'] }],
      ['an unknown channel', { ...VALID_BODY, channels: ['carrier-pigeon'] }],
      ['an empty title', { ...VALID_BODY, title: '   ' }],
    ];

    it.each(invalid)('400s %s', async (_name, body) => {
      const admin = await createMockAdminUser(context);

      await request(server())
        .post('/api/admin/broadcasts')
        .set(authHeader(admin.accessToken))
        .send(body)
        .expect(400);

      // A rejected composition writes nothing at all — not the row, not the
      // job, not an audit event.
      expect(prisma.notificationBroadcast.create).not.toHaveBeenCalled();
      expect(prisma.job.create).not.toHaveBeenCalled();
    });

    it('accepts a critical broadcast that includes the browser channel', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(server())
        .post('/api/admin/broadcasts')
        .set(authHeader(admin.accessToken))
        .send({ ...VALID_BODY, critical: true, channels: ['email', 'browser'] })
        .expect(201);

      // And the key is DERIVED, never taken from the client.
      expect(response.body.data.broadcast.eventKey).toBe('admin.broadcast_critical');
    });

    it('ignores an eventKey supplied by the client', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(server())
        .post('/api/admin/broadcasts')
        .set(authHeader(admin.accessToken))
        // A client naming the key could pick the one event no recipient may
        // mute — or any other event in the registry, borrowing its template.
        .send({ ...VALID_BODY, eventKey: 'admin.broadcast_critical' })
        .expect(201);

      expect(response.body.data.broadcast.eventKey).toBe('admin.broadcast');
    });

    it('accepts a root-relative link with a query string', async () => {
      const admin = await createMockAdminUser(context);

      await request(server())
        .post('/api/admin/broadcasts')
        .set(authHeader(admin.accessToken))
        .send({ ...VALID_BODY, link: '/admin/settings?tab=broadcasts', ctaLabel: 'Open' })
        .expect(201);
    });

    it('queues the start job with the schedule the composer supplied', async () => {
      const admin = await createMockAdminUser(context);
      const when = new Date(Date.now() + 60 * 60 * 1000).toISOString();

      await request(server())
        .post('/api/admin/broadcasts')
        .set(authHeader(admin.accessToken))
        .send({ ...VALID_BODY, scheduledFor: when })
        .expect(201);

      expect(prisma.job.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'admin.broadcast.start',
            subjectType: 'notification_broadcast',
            subjectId: BROADCAST_ID,
            scheduledFor: new Date(when),
          }),
        })
      );
    });
  });

  // =========================================================================
  // Query parsing, through the real pipe
  // =========================================================================

  describe('GET /admin/broadcasts', () => {
    it('applies the default page and pageSize', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(server())
        .get('/api/admin/broadcasts')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data).toMatchObject({ items: [], total: 0, page: 1, pageSize: 20 });
    });

    it('coerces string query parameters into the filters', async () => {
      const admin = await createMockAdminUser(context);

      await request(server())
        .get('/api/admin/broadcasts?page=2&pageSize=5&status=sent')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(prisma.notificationBroadcast.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: 'sent' }, skip: 5, take: 5 })
      );
    });

    it('rejects a pageSize above the 100-row ceiling', async () => {
      const admin = await createMockAdminUser(context);

      await request(server())
        .get('/api/admin/broadcasts?pageSize=101')
        .set(authHeader(admin.accessToken))
        .expect(400);
    });

    it('rejects a status outside the enum', async () => {
      const admin = await createMockAdminUser(context);

      await request(server())
        .get('/api/admin/broadcasts?status=queued')
        .set(authHeader(admin.accessToken))
        .expect(400);
    });
  });

  // =========================================================================
  // The parameterised routes' error contract
  // =========================================================================

  describe(':id routes', () => {
    it('400s a malformed id rather than reaching the service', async () => {
      const admin = await createMockAdminUser(context);

      await request(server())
        .get('/api/admin/broadcasts/not-a-uuid')
        .set(authHeader(admin.accessToken))
        .expect(400);

      expect(prisma.notificationBroadcast.findUnique).not.toHaveBeenCalled();
    });

    it('404s a broadcast that does not exist', async () => {
      const admin = await createMockAdminUser(context);
      prisma.notificationBroadcast.findUnique.mockResolvedValue(null);

      await request(server())
        .get(`/api/admin/broadcasts/${BROADCAST_ID}`)
        .set(authHeader(admin.accessToken))
        .expect(404);
    });

    it('409s a cancel of a broadcast that has already been sent', async () => {
      const admin = await createMockAdminUser(context);
      prisma.notificationBroadcast.updateMany.mockResolvedValue({ count: 0 });
      prisma.notificationBroadcast.findUnique.mockResolvedValue(broadcastRow({ status: 'sent' }));

      await request(server())
        .post(`/api/admin/broadcasts/${BROADCAST_ID}/cancel`)
        .set(authHeader(admin.accessToken))
        .expect(409);
    });

    it('returns the detail with an approximate delivery breakdown', async () => {
      const admin = await createMockAdminUser(context);
      prisma.notificationBroadcast.findUnique.mockResolvedValue(
        broadcastRow({
          status: 'sent',
          startedAt: new Date('2026-02-01T10:00:00.000Z'),
          finishedAt: new Date('2026-02-01T10:05:00.000Z'),
        })
      );
      prisma.notificationDelivery.groupBy.mockResolvedValue([
        { channel: 'email', status: 'sent', _count: { _all: 1200 } },
      ]);

      const response = await request(server())
        .get(`/api/admin/broadcasts/${BROADCAST_ID}`)
        .set(authHeader(admin.accessToken))
        .expect(200);

      // Named so it cannot be mistaken for exact attribution — delivery rows
      // carry no broadcast id, so this is an event-key-and-time-window
      // approximation.
      expect(response.body.data.approximateDeliveryAttempts).toEqual([
        { channel: 'email', status: 'sent', count: 1200 },
      ]);
    });
  });
});
