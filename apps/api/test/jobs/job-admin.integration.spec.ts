// =============================================================================
// Integration tests for the admin jobs API (issues #264 and #265, epic #254)
// =============================================================================
//
// `src/jobs/job-admin.service.spec.ts` proves what the service DECIDES. This
// suite proves the things only the real Nest router, the real guards and the
// real global pipe can answer, and nothing else — every case here fails for a
// reason a direct call to the service could not produce:
//
//   1. ROUTE ORDER. Nest matches in declaration order, so `POST
//      /admin/jobs/reset-stuck` is swallowed by `@Post(':id/…')` if the two
//      are ever transposed. There is no boot-time error for that and no log
//      line — the only way it is ever caught is a request going through the
//      real router, which is what these tests do.
//   2. RBAC. `@Auth({ roles, permissions })` is guards, and guards only run in
//      a request pipeline. A unit test that called `controller.stats()`
//      directly would pass with the decorator deleted.
//   3. QUERY PARSING. Every query parameter arrives as a string, and the
//      `scheduled` boolean and the numeric page bounds are only exercised by
//      the global `ZodValidationPipe` when a real URL is parsed.
//
// The database is the shared deep mock (`useMockDatabase: true`), so what
// these assert about a response body is the shape and the wiring, never the
// rows — which is the correct division: which rows a `where` matches is
// Postgres's answer and is asked in `test/jobs/*.db.spec.ts`.
// =============================================================================

import request from 'supertest';

import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  authHeader,
  createMockAdminUser,
  createMockViewerUser,
} from '../helpers/auth-mock.helper';

const JOB_ID = '11111111-1111-4111-8111-111111111111';

describe('Admin jobs API (Integration)', () => {
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
    prisma.job.groupBy.mockResolvedValue([]);
    prisma.job.count.mockResolvedValue(0);
    prisma.job.findMany.mockResolvedValue([]);
    prisma.job.findUnique.mockResolvedValue(null);
    prisma.job.updateMany.mockResolvedValue({ count: 0 });
    prisma.job.deleteMany.mockResolvedValue({ count: 0 });

    // #265's insights surface. `$queryRaw` is the two duration aggregates;
    // the deep mock would otherwise resolve them to `undefined` and the
    // service would iterate nothing.
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.jobStatsRollup.findMany.mockResolvedValue([]);
    prisma.jobStatsRollup.deleteMany.mockResolvedValue({ count: 0 });
  });

  const server = () => context.app.getHttpServer();

  // =========================================================================
  // Route resolution — the reason this file exists
  // =========================================================================

  describe('literal routes resolve before :id', () => {
    it('reads POST /admin/jobs/reset-stuck as the sweep, not as a job id', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(server())
        .post('/api/admin/jobs/reset-stuck')
        .set(authHeader(admin.accessToken))
        .send({})
        .expect(200);

      // If `@Post(':id/retry')` or a `@Post(':id')` were declared above this
      // route, `reset-stuck` would be captured as `:id` and answered by
      // `ParseUUIDPipe` with a 400 — or, worse, by a 404 for a job whose id is
      // the literal string "reset-stuck". Asserting the SWEEP RAN is what
      // makes this a route-order test rather than a status-code coincidence.
      expect(response.body.data).toEqual({
        reset: 0,
        failed: 0,
        // 30 is `DEFAULT_SYSTEM_SETTINGS.jobs.stuckThresholdMinutes`, which is
        // what an empty body must fall through to.
        thresholdMinutes: 30,
      });
      expect(prisma.job.updateMany).toHaveBeenCalled();
    });

    it('reads POST /admin/jobs/retry-failed as the sweep, not as a job id', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(server())
        .post('/api/admin/jobs/retry-failed')
        .set(authHeader(admin.accessToken))
        .send({})
        .expect(200);

      expect(response.body.data).toEqual({ retried: 0, skipped: 0, remaining: 0 });
    });

    it('reads GET /admin/jobs/stats as the summary, not as a job id', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(server())
        .get('/api/admin/jobs/stats')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data).toMatchObject({
        total: 0,
        byStatus: { pending: 0, running: 0, succeeded: 0, failed: 0 },
        byType: [],
        stuckThresholdMinutes: 30,
      });
    });

    it('reads GET /admin/jobs/insights as the analysis, not as a job id', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(server())
        .get('/api/admin/jobs/insights')
        .set(authHeader(admin.accessToken))
        .expect(200);

      // Asserting the SHAPE, not merely the status: a `:id` route capturing
      // this would answer 400 or 404, but so would several unrelated
      // failures. Four blocks and a window mean the computation ran.
      expect(response.body.data).toMatchObject({
        windowDays: 7,
        live: { total: 0, byStatus: { pending: 0, running: 0, succeeded: 0, failed: 0 } },
        history: { overall: { samples: 0, avgMs: null } },
        eta: [],
        lifetime: [],
      });
    });

    it('reads POST /admin/jobs/insights/reset-history as the reset, not as a job id', async () => {
      const admin = await createMockAdminUser(context);
      prisma.jobStatsRollup.deleteMany.mockResolvedValue({ count: 2 });

      const response = await request(server())
        .post('/api/admin/jobs/insights/reset-history')
        .set(authHeader(admin.accessToken))
        .send()
        .expect(200);

      expect(response.body.data).toEqual({ reset: 2 });
      // The rollup was cleared and no job row was touched — the whole safety
      // argument for putting this control on the dashboard at all.
      expect(prisma.jobStatsRollup.deleteMany).toHaveBeenCalledWith({});
      expect(prisma.job.deleteMany).not.toHaveBeenCalled();
      expect(prisma.job.updateMany).not.toHaveBeenCalled();
    });

    it('still routes a real UUID to the :id handlers', async () => {
      const admin = await createMockAdminUser(context);
      prisma.job.findUnique.mockResolvedValue({ id: JOB_ID, status: 'running' });

      // 400 "is running" proves the request reached `retry(id)` — a routing
      // failure here would be a 404 from no matching route.
      await request(server())
        .post(`/api/admin/jobs/${JOB_ID}/retry`)
        .set(authHeader(admin.accessToken))
        .send()
        .expect(400);
    });
  });

  // =========================================================================
  // RBAC
  // =========================================================================

  describe('authorization', () => {
    const routes: Array<[string, 'get' | 'post' | 'delete', string]> = [
      ['GET /admin/jobs/stats', 'get', '/api/admin/jobs/stats'],
      ['GET /admin/jobs/insights', 'get', '/api/admin/jobs/insights'],
      [
        'POST /admin/jobs/insights/reset-history',
        'post',
        '/api/admin/jobs/insights/reset-history',
      ],
      ['GET /admin/jobs', 'get', '/api/admin/jobs'],
      ['POST /admin/jobs/retry-failed', 'post', '/api/admin/jobs/retry-failed'],
      ['POST /admin/jobs/reset-stuck', 'post', '/api/admin/jobs/reset-stuck'],
      ['POST /admin/jobs/:id/retry', 'post', `/api/admin/jobs/${JOB_ID}/retry`],
      ['DELETE /admin/jobs/:id', 'delete', `/api/admin/jobs/${JOB_ID}`],
    ];

    it.each(routes)('%s rejects an anonymous caller', async (_name, method, path) => {
      await request(server())[method](path).expect(401);
    });

    it.each(routes)('%s rejects a viewer', async (_name, method, path) => {
      const viewer = await createMockViewerUser(context);

      // `jobs:read`/`jobs:write` are seeded to Admin only — the queue exposes
      // subject ids and the shape of a deployment's workload.
      await request(server())[method](path).set(authHeader(viewer.accessToken)).expect(403);
    });
  });

  // =========================================================================
  // Query parsing, through the real pipe
  // =========================================================================

  describe('GET /admin/jobs', () => {
    it('applies the default page and pageSize', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(server())
        .get('/api/admin/jobs')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data).toMatchObject({ items: [], total: 0, page: 1, pageSize: 20 });
    });

    it('coerces string query parameters into the filters', async () => {
      const admin = await createMockAdminUser(context);

      await request(server())
        .get('/api/admin/jobs?page=2&pageSize=5&status=failed&type=example.echo')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(prisma.job.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: 'failed', type: 'example.echo' },
          skip: 5,
          take: 5,
        })
      );
    });

    it('lets scheduled=true override a conflicting status over the wire', async () => {
      const admin = await createMockAdminUser(context);

      await request(server())
        .get('/api/admin/jobs?scheduled=true&status=failed')
        .set(authHeader(admin.accessToken))
        .expect(200);

      const where = prisma.job.findMany.mock.calls[0][0].where;
      expect(where.status).toBe('pending');
      expect(where.scheduledFor.gt).toBeInstanceOf(Date);
    });

    it('rejects a pageSize above the 100-row ceiling', async () => {
      const admin = await createMockAdminUser(context);

      await request(server())
        .get('/api/admin/jobs?pageSize=101')
        .set(authHeader(admin.accessToken))
        .expect(400);
    });

    it('rejects a status outside the four the enum publishes', async () => {
      const admin = await createMockAdminUser(context);

      // In particular `status=scheduled`, which is the shape this API
      // deliberately does not offer — see `dto/job-list-query.dto.ts`.
      await request(server())
        .get('/api/admin/jobs?status=scheduled')
        .set(authHeader(admin.accessToken))
        .expect(400);
    });

    it('rejects an unknown processedWithin window', async () => {
      const admin = await createMockAdminUser(context);

      await request(server())
        .get('/api/admin/jobs?processedWithin=1h')
        .set(authHeader(admin.accessToken))
        .expect(400);
    });
  });

  // =========================================================================
  // GET /admin/jobs/insights — the window, through the real pipe
  // =========================================================================

  describe('GET /admin/jobs/insights', () => {
    it('accepts the ceiling exactly', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(server())
        .get('/api/admin/jobs/insights?windowDays=90')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data.windowDays).toBe(90);
    });

    it('coerces the string a query parameter always is', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(server())
        .get('/api/admin/jobs/insights?windowDays=30')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data.windowDays).toBe(30);
    });

    it('400s a window above the ceiling rather than silently clamping it', async () => {
      // Silently reducing it would return a response that looks exactly like
      // the one that was asked for, over a window that was never computed.
      const admin = await createMockAdminUser(context);

      await request(server())
        .get('/api/admin/jobs/insights?windowDays=91')
        .set(authHeader(admin.accessToken))
        .expect(400);

      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('400s a zero, a negative and a non-numeric window', async () => {
      const admin = await createMockAdminUser(context);

      for (const value of ['0', '-7', 'lots', '7.5']) {
        await request(server())
          .get(`/api/admin/jobs/insights?windowDays=${value}`)
          .set(authHeader(admin.accessToken))
          .expect(400);
      }
    });
  });

  // =========================================================================
  // The action bodies
  // =========================================================================

  describe('POST /admin/jobs/reset-stuck', () => {
    it('honours an explicit olderThanMinutes', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(server())
        .post('/api/admin/jobs/reset-stuck')
        .set(authHeader(admin.accessToken))
        .send({ olderThanMinutes: 5 })
        .expect(200);

      expect(response.body.data.thresholdMinutes).toBe(5);
    });

    it('rejects a negative olderThanMinutes', async () => {
      const admin = await createMockAdminUser(context);

      await request(server())
        .post('/api/admin/jobs/reset-stuck')
        .set(authHeader(admin.accessToken))
        .send({ olderThanMinutes: -1 })
        .expect(400);
    });
  });

  describe('POST /admin/jobs/retry-failed', () => {
    it('scopes the sweep to one type when asked', async () => {
      const admin = await createMockAdminUser(context);

      await request(server())
        .post('/api/admin/jobs/retry-failed')
        .set(authHeader(admin.accessToken))
        .send({ type: 'example.echo' })
        .expect(200);

      expect(prisma.job.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: 'failed', type: 'example.echo' } })
      );
    });
  });

  describe('POST /admin/jobs/:id/retry', () => {
    it('404s a job that does not exist', async () => {
      const admin = await createMockAdminUser(context);

      await request(server())
        .post(`/api/admin/jobs/${JOB_ID}/retry`)
        .set(authHeader(admin.accessToken))
        .send()
        .expect(404);
    });

    it('400s a running job and puts the reason in `details`', async () => {
      const admin = await createMockAdminUser(context);
      prisma.job.findUnique.mockResolvedValue({ id: JOB_ID, status: 'running' });

      const response = await request(server())
        .post(`/api/admin/jobs/${JOB_ID}/retry`)
        .set(authHeader(admin.accessToken))
        .send()
        .expect(400);

      // The filter rebuilds the body from a fixed key allowlist and derives
      // `code` from the status, so anything endpoint-specific has to be here.
      expect(response.body.details).toEqual({
        jobId: JOB_ID,
        status: 'running',
        reason: 'job_running',
      });
    });

    it('400s a malformed id before it reaches the service', async () => {
      const admin = await createMockAdminUser(context);

      await request(server())
        .post('/api/admin/jobs/not-a-uuid/retry')
        .set(authHeader(admin.accessToken))
        .send()
        .expect(400);

      expect(prisma.job.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /admin/jobs/:id', () => {
    it('404s a job that does not exist', async () => {
      const admin = await createMockAdminUser(context);

      await request(server())
        .delete(`/api/admin/jobs/${JOB_ID}`)
        .set(authHeader(admin.accessToken))
        .expect(404);
    });

    it('400s a running job', async () => {
      const admin = await createMockAdminUser(context);
      prisma.job.findUnique.mockResolvedValue({ id: JOB_ID, status: 'running' });

      await request(server())
        .delete(`/api/admin/jobs/${JOB_ID}`)
        .set(authHeader(admin.accessToken))
        .expect(400);

      expect(prisma.job.deleteMany).not.toHaveBeenCalled();
    });

    it('204s with no body on success', async () => {
      const admin = await createMockAdminUser(context);
      prisma.job.findUnique.mockResolvedValue({ id: JOB_ID, status: 'failed' });
      prisma.job.deleteMany.mockResolvedValue({ count: 1 });

      const response = await request(server())
        .delete(`/api/admin/jobs/${JOB_ID}`)
        .set(authHeader(admin.accessToken))
        .expect(204);

      expect(response.body).toEqual({});
    });
  });
});
