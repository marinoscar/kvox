// =============================================================================
// /api/nodes over the real HTTP stack (issue #268, epic #254)
// =============================================================================
//
// The unit suite (`src/nodes/nodes.service.spec.ts`) proves what the service
// DECIDES. This one proves the decisions survive the trip through the stack
// that carries them: the router, the RBAC guards, the global Zod pipe, the
// response envelope and the exception filter. Those five have all silently
// changed a service's answer at some point in this repository's history —
// the filter rebuilds every error body from a fixed key allowlist, and a
// `details` payload that goes anywhere else simply vanishes on the way out.
//
// So the cases below deliberately assert the WIRE, not the service:
//
//   * `409` on a late submission is asserted as a status code a real HTTP
//     client receives, because that status code is the instruction a node
//     acts on ("drop this work") and a filter that flattened it to a 400 or a
//     500 would change what a fleet does without failing a unit test.
//   * The validation detail on a bad result is asserted inside `details`,
//     which is the only key the filter forwards.
//   * The claim's `{ jobs: [{ job, params }] }` shape is asserted through the
//     envelope, because a node has no database access: this response IS its
//     entire view of the work, and a field lost in serialization is a field
//     the node will never see.
//
// `JobClaimService` reaches Postgres through `$queryRaw`, which is mocked
// here — the claim's real, atomic behaviour is proven where it can only be
// proven, in `test/jobs/job-claim.db.spec.ts` and (for a node racing the
// in-process worker) `test/nodes/node-claim-contention.db.spec.ts`.
// =============================================================================

import request from 'supertest';
import { z } from 'zod';

import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockAdminUser, createMockViewerUser } from '../helpers/auth-mock.helper';
import { closeTestApp, createTestApp, TestContext } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';

describe('Worker node control plane (Integration)', () => {
  let context: TestContext;

  /** A node-eligible handler: it carries BOTH optional members, so a node may run its type. */
  const NODE_TYPE = 'test.integration.node-eligible';

  /** A server-only handler: neither member, so no node may ever run its type. */
  const SERVER_TYPE = 'test.integration.server-only';

  const persistNodeResult = jest.fn().mockResolvedValue(undefined);

  const NODE_ID = '11111111-1111-4111-8111-111111111111';
  const JOB_ID = '22222222-2222-4222-8222-222222222222';

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });

    // Registered into the REAL registry the application booted with, which is
    // the same extension point a fork's own handler uses (`handlers/README.md`).
    // Suite-local types on purpose, even though #269 added a real
    // node-eligible handler (`example.checksum`): these two exist to give this
    // file a node-persistable type and a server-only one whose SHAPES it
    // controls, so a change to the shipped handler's result schema cannot
    // break assertions that are about the control plane. The shipped handler
    // is driven end to end by `node-data-plane.integration.spec.ts` and
    // `node-checksum-data-plane.db.spec.ts` instead.
    const registry = context.module.get(JobHandlerRegistry, { strict: false });
    registry.register({
      type: NODE_TYPE,
      process: async () => undefined,
      nodeResultSchema: z.object({ ok: z.boolean() }),
      persistNodeResult,
    });
    registry.register({ type: SERVER_TYPE, process: async () => undefined });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    persistNodeResult.mockClear().mockResolvedValue(undefined);
  });

  const server = () => context.app.getHttpServer();

  /** A node row owned by `ownerId`, otherwise perfectly healthy. */
  function nodeRow(ownerId: string, overrides: Record<string, unknown> = {}) {
    return {
      id: NODE_ID,
      name: 'prod-worker-1',
      hostname: 'box-a',
      platform: 'linux-x64',
      cliVersion: '1.0.0',
      eligibleTypes: [NODE_TYPE],
      concurrency: 2,
      status: 'online',
      capabilities: null,
      registeredAt: new Date('2026-01-01T00:00:00.000Z'),
      lastHeartbeatAt: null,
      createdById: ownerId,
      ...overrides,
    };
  }

  /** A job this node holds legitimately. */
  function jobRow(overrides: Record<string, unknown> = {}) {
    return {
      id: JOB_ID,
      type: NODE_TYPE,
      subjectType: 'document',
      subjectId: 'doc-1',
      dedupKey: null,
      status: 'running',
      reason: null,
      priority: 100,
      providerKey: null,
      modelVersion: null,
      payload: { input: 'hello' },
      attempts: 1,
      lastError: null,
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: null,
      scheduledFor: null,
      rateLimitedAt: null,
      rateLimitHits: 0,
      claimedByNodeId: NODE_ID,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      executor: 'node',
      ...overrides,
    };
  }

  function givenNode(ownerId: string, overrides: Record<string, unknown> = {}) {
    (context.prismaMock.workerNode.findUnique as jest.Mock).mockResolvedValue(
      nodeRow(ownerId, overrides),
    );
    (context.prismaMock.workerNode.update as jest.Mock).mockImplementation(
      async ({ data }: any) => nodeRow(ownerId, { ...overrides, ...data }),
    );
  }

  // ===========================================================================
  // The RBAC surface
  // ===========================================================================

  describe('authentication and permissions', () => {
    const routes: Array<[string, 'get' | 'post', string]> = [
      ['GET /nodes', 'get', '/api/nodes'],
      ['GET /nodes/:id', 'get', `/api/nodes/${NODE_ID}`],
      ['POST /nodes/register', 'post', '/api/nodes/register'],
      ['POST /nodes/:id/heartbeat', 'post', `/api/nodes/${NODE_ID}/heartbeat`],
      ['POST /nodes/:id/claim', 'post', `/api/nodes/${NODE_ID}/claim`],
      ['POST /nodes/:id/deregister', 'post', `/api/nodes/${NODE_ID}/deregister`],
      ['POST /nodes/:id/jobs/:jobId/renew', 'post', `/api/nodes/${NODE_ID}/jobs/${JOB_ID}/renew`],
      ['POST /nodes/:id/jobs/:jobId/result', 'post', `/api/nodes/${NODE_ID}/jobs/${JOB_ID}/result`],
      ['POST /nodes/:id/jobs/:jobId/failure', 'post', `/api/nodes/${NODE_ID}/jobs/${JOB_ID}/failure`],
    ];

    it.each(routes)('401 on %s when unauthenticated', async (_label, method, path) => {
      await request(server())[method](path).expect(401);
    });

    it.each(routes)('403 on %s for a viewer', async (_label, method, path) => {
      // Every route is gated: the writes on `nodes:write`, the two reads on
      // `nodes:read`, both Admin-only in `seed-data.ts`.
      const viewer = await createMockViewerUser(context);

      await request(server())[method](path).set(authHeader(viewer.accessToken)).expect(403);
    });

    it('400 for a non-UUID node id', async () => {
      const admin = await createMockAdminUser(context);

      await request(server())
        .get('/api/nodes/not-a-uuid')
        .set(authHeader(admin.accessToken))
        .expect(400);
    });
  });

  // ===========================================================================
  // register
  // ===========================================================================

  describe('POST /api/nodes/register', () => {
    const body = {
      name: 'prod-worker-1',
      hostname: 'box-a',
      platform: 'linux-x64',
      cliVersion: '1.0.0',
      eligibleTypes: [NODE_TYPE],
      concurrency: 2,
    };

    it('200 and creates a node the first time', async () => {
      const admin = await createMockAdminUser(context);
      (context.prismaMock.workerNode.findUnique as jest.Mock).mockResolvedValue(null);
      (context.prismaMock.workerNode.create as jest.Mock).mockImplementation(
        async ({ data }: any) => nodeRow(admin.id, data),
      );

      const response = await request(server())
        .post('/api/nodes/register')
        .set(authHeader(admin.accessToken))
        .send(body)
        .expect(200);

      expect(response.body.data.reattached).toBe(false);
      expect(response.body.data.node).toMatchObject({
        id: NODE_ID,
        name: 'prod-worker-1',
        status: 'online',
        eligibleTypes: [NODE_TYPE],
      });
      // Timestamps cross the wire as ISO strings, and "never heartbeated" is
      // an explicit null rather than a missing field.
      expect(response.body.data.node.registeredAt).toBe('2026-01-01T00:00:00.000Z');
      expect(response.body.data.node.lastHeartbeatAt).toBeNull();
    });

    it('200 and REATTACHES the second time — no second row', async () => {
      const admin = await createMockAdminUser(context);
      givenNode(admin.id);

      const response = await request(server())
        .post('/api/nodes/register')
        .set(authHeader(admin.accessToken))
        .send({ ...body, hostname: 'box-b', concurrency: 4 })
        .expect(200);

      expect(response.body.data.reattached).toBe(true);
      expect(context.prismaMock.workerNode.create).not.toHaveBeenCalled();
      expect(response.body.data.node.hostname).toBe('box-b');
      expect(response.body.data.node.concurrency).toBe(4);
    });

    it.each([
      ['name missing', { ...body, name: undefined }],
      ['name empty', { ...body, name: '' }],
      ['concurrency zero', { ...body, concurrency: 0 }],
      ['concurrency above the ceiling', { ...body, concurrency: 65 }],
      ['concurrency fractional', { ...body, concurrency: 1.5 }],
      ['eligibleTypes not an array', { ...body, eligibleTypes: NODE_TYPE }],
      ['hostname missing', { ...body, hostname: undefined }],
    ])('400 when %s', async (_label, payload) => {
      const admin = await createMockAdminUser(context);

      await request(server())
        .post('/api/nodes/register')
        .set(authHeader(admin.accessToken))
        .send(payload)
        .expect(400);
    });
  });

  // ===========================================================================
  // Ownership — 404 vs 403, over HTTP
  // ===========================================================================

  describe('ownership', () => {
    it('404 for a node that does not exist', async () => {
      const admin = await createMockAdminUser(context);
      (context.prismaMock.workerNode.findUnique as jest.Mock).mockResolvedValue(null);

      await request(server())
        .get(`/api/nodes/${NODE_ID}`)
        .set(authHeader(admin.accessToken))
        .expect(404);
    });

    it('403 for another user’s node — the operator is told the truth', async () => {
      const admin = await createMockAdminUser(context);
      givenNode('someone-else');

      await request(server())
        .get(`/api/nodes/${NODE_ID}`)
        .set(authHeader(admin.accessToken))
        .expect(403);
    });

    it('200 for the caller’s own node', async () => {
      const admin = await createMockAdminUser(context);
      givenNode(admin.id);

      const response = await request(server())
        .get(`/api/nodes/${NODE_ID}`)
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data.id).toBe(NODE_ID);
    });

    it('GET /api/nodes lists only this caller’s nodes', async () => {
      const admin = await createMockAdminUser(context);
      (context.prismaMock.workerNode.findMany as jest.Mock).mockResolvedValue([nodeRow(admin.id)]);

      const response = await request(server())
        .get('/api/nodes')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect((context.prismaMock.workerNode.findMany as jest.Mock).mock.calls[0][0].where).toEqual({
        createdById: admin.id,
      });
    });
  });

  // ===========================================================================
  // heartbeat and claim
  // ===========================================================================

  describe('heartbeat and claim', () => {
    it('a heartbeat’s new concurrency caps the NEXT claim', async () => {
      const admin = await createMockAdminUser(context);
      givenNode(admin.id, { concurrency: 2 });
      (context.prismaMock.$queryRaw as jest.Mock).mockResolvedValue([]);

      await request(server())
        .post(`/api/nodes/${NODE_ID}/claim`)
        .set(authHeader(admin.accessToken))
        .send({})
        .expect(200);

      await request(server())
        .post(`/api/nodes/${NODE_ID}/heartbeat`)
        .set(authHeader(admin.accessToken))
        .send({ concurrency: 5 })
        .expect(200);

      // The row is the only cache there is, so the next claim reads 5.
      givenNode(admin.id, { concurrency: 5 });

      await request(server())
        .post(`/api/nodes/${NODE_ID}/claim`)
        .set(authHeader(admin.accessToken))
        .send({})
        .expect(200);

      // THE LIMIT IS LOCATED BY SHAPE, NOT BY POSITION, and that is the point
      // of the filter rather than an index. `JobClaimService` binds two arrays
      // (the eligible types, and the per-type leases), two string-or-null
      // values (the node id and the executor), and EXACTLY ONE plain number —
      // the limit. Picking the sole non-array number identifies it whatever
      // order the statement binds things in.
      //
      // This used to read `values[values.length - 1]`, which was true until
      // #346 moved the row pick into a `WITH picked AS MATERIALIZED` CTE and
      // put `limit` second rather than last. A positional read couples a
      // node-plane test to the claim statement's parameter order — two files
      // that have no other reason to know about each other — so it breaks on a
      // change that is none of its business, and breaks with an error about a
      // concurrency cap rather than about the ordering that actually moved.
      const limitOf = (call: any[]): unknown => {
        const values = (call[0] as { values: unknown[] }).values;
        const numbers = values.filter(
          (value) => typeof value === 'number' && !Array.isArray(value)
        );

        // If this ever finds more than one, the assumption above has expired
        // and the test must say so rather than silently asserting on whichever
        // number came first.
        expect(numbers).toHaveLength(1);

        return numbers[0];
      };
      const calls = (context.prismaMock.$queryRaw as jest.Mock).mock.calls;
      expect(limitOf(calls[0])).toBe(2);
      expect(limitOf(calls[1])).toBe(5);
    });

    it('403 when the node is disabled — polling will not change the answer', async () => {
      const admin = await createMockAdminUser(context);
      givenNode(admin.id, { status: 'disabled' });

      await request(server())
        .post(`/api/nodes/${NODE_ID}/claim`)
        .set(authHeader(admin.accessToken))
        .send({})
        .expect(403);

      expect(context.prismaMock.$queryRaw).not.toHaveBeenCalled();
    });

    it('200 with an empty list when the node is draining', async () => {
      const admin = await createMockAdminUser(context);
      givenNode(admin.id, { status: 'draining' });

      const response = await request(server())
        .post(`/api/nodes/${NODE_ID}/claim`)
        .set(authHeader(admin.accessToken))
        .send({})
        .expect(200);

      expect(response.body.data.jobs).toEqual([]);
      expect(context.prismaMock.$queryRaw).not.toHaveBeenCalled();
    });

    it('returns `{ job, params }` pairs — the node’s entire view of the work', async () => {
      const admin = await createMockAdminUser(context);
      givenNode(admin.id);
      (context.prismaMock.$queryRaw as jest.Mock).mockResolvedValue([jobRow()]);

      const response = await request(server())
        .post(`/api/nodes/${NODE_ID}/claim`)
        .set(authHeader(admin.accessToken))
        .send({})
        .expect(200);

      const [assignment] = response.body.data.jobs;
      expect(assignment.job).toMatchObject({ id: JOB_ID, type: NODE_TYPE, attempts: 1 });
      expect(assignment.params).toEqual({ input: 'hello' });
      // The narrowing: internals a node has no use for do not leave the
      // building, even though the claimed row carries them.
      expect(assignment.job).not.toHaveProperty('lastError');
      expect(assignment.job).not.toHaveProperty('dedupKey');
      expect(assignment.job).not.toHaveProperty('payload');
    });
  });

  // ===========================================================================
  // Lease renewal, result and failure
  // ===========================================================================

  describe('result submission', () => {
    it('200, persists through the handler, and settles the job', async () => {
      const admin = await createMockAdminUser(context);
      givenNode(admin.id);
      (context.prismaMock.job.findUnique as jest.Mock).mockResolvedValue(jobRow());
      (context.prismaMock.job.update as jest.Mock).mockResolvedValue(
        jobRow({ status: 'succeeded' }),
      );

      const response = await request(server())
        .post(`/api/nodes/${NODE_ID}/jobs/${JOB_ID}/result`)
        .set(authHeader(admin.accessToken))
        .send({ type: NODE_TYPE, result: { ok: true } })
        .expect(200);

      expect(response.body.data).toEqual({
        jobId: JOB_ID,
        outcome: 'succeeded',
        willRetry: false,
      });
      expect(persistNodeResult).toHaveBeenCalledWith(
        expect.objectContaining({ id: JOB_ID }),
        { ok: true },
      );
    });

    it('409 — and persists NOTHING — once the lease has expired', async () => {
      // The straggler: the reaper has requeued this job and another executor
      // may already own it. 409 tells the node to drop the work; 400 would
      // tell it to fix its request and try again, forever.
      const admin = await createMockAdminUser(context);
      givenNode(admin.id);
      (context.prismaMock.job.findUnique as jest.Mock).mockResolvedValue(
        jobRow({ leaseExpiresAt: new Date(Date.now() - 1_000) }),
      );

      await request(server())
        .post(`/api/nodes/${NODE_ID}/jobs/${JOB_ID}/result`)
        .set(authHeader(admin.accessToken))
        .send({ type: NODE_TYPE, result: { ok: true } })
        .expect(409);

      expect(persistNodeResult).not.toHaveBeenCalled();
      expect(context.prismaMock.job.update).not.toHaveBeenCalled();
    });

    it('409 on renew after the lease expired, writing nothing', async () => {
      const admin = await createMockAdminUser(context);
      givenNode(admin.id);
      (context.prismaMock.job.findUnique as jest.Mock).mockResolvedValue(
        jobRow({ leaseExpiresAt: new Date(Date.now() - 1_000) }),
      );

      await request(server())
        .post(`/api/nodes/${NODE_ID}/jobs/${JOB_ID}/renew`)
        .set(authHeader(admin.accessToken))
        .expect(409);

      expect(context.prismaMock.job.updateMany).not.toHaveBeenCalled();
    });

    it('409 on failure after the lease expired, settling nothing', async () => {
      const admin = await createMockAdminUser(context);
      givenNode(admin.id);
      (context.prismaMock.job.findUnique as jest.Mock).mockResolvedValue(
        jobRow({ leaseExpiresAt: new Date(Date.now() - 1_000) }),
      );

      await request(server())
        .post(`/api/nodes/${NODE_ID}/jobs/${JOB_ID}/failure`)
        .set(authHeader(admin.accessToken))
        .send({ error: 'boom' })
        .expect(409);

      expect(context.prismaMock.job.update).not.toHaveBeenCalled();
    });

    it('200 on renew while the lease is live', async () => {
      const admin = await createMockAdminUser(context);
      givenNode(admin.id);
      (context.prismaMock.job.findUnique as jest.Mock).mockResolvedValue(jobRow());
      (context.prismaMock.job.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      const response = await request(server())
        .post(`/api/nodes/${NODE_ID}/jobs/${JOB_ID}/renew`)
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data.jobId).toBe(JOB_ID);
      expect(Date.parse(response.body.data.leaseExpiresAt)).toBeGreaterThan(Date.now());
    });

    it('400 when the posted type does not match the job’s', async () => {
      const admin = await createMockAdminUser(context);
      givenNode(admin.id);
      (context.prismaMock.job.findUnique as jest.Mock).mockResolvedValue(jobRow());

      const response = await request(server())
        .post(`/api/nodes/${NODE_ID}/jobs/${JOB_ID}/result`)
        .set(authHeader(admin.accessToken))
        .send({ type: 'some.other.type', result: { ok: true } })
        .expect(400);

      expect(response.body.details).toMatchObject({
        expectedType: NODE_TYPE,
        receivedType: 'some.other.type',
      });
      expect(persistNodeResult).not.toHaveBeenCalled();
    });

    it('400, WITH the validation detail, when the result fails the handler’s schema', async () => {
      // `details` is the only key the exception filter forwards, which is why
      // the issues go there rather than into a field of their own.
      const admin = await createMockAdminUser(context);
      givenNode(admin.id);
      (context.prismaMock.job.findUnique as jest.Mock).mockResolvedValue(jobRow());

      const response = await request(server())
        .post(`/api/nodes/${NODE_ID}/jobs/${JOB_ID}/result`)
        .set(authHeader(admin.accessToken))
        .send({ type: NODE_TYPE, result: { ok: 'yes please' } })
        .expect(400);

      expect(response.body.details.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'ok' })]),
      );
      expect(persistNodeResult).not.toHaveBeenCalled();
    });

    it('400 when the job’s type is not node-persistable', async () => {
      const admin = await createMockAdminUser(context);
      givenNode(admin.id, { eligibleTypes: [SERVER_TYPE] });
      (context.prismaMock.job.findUnique as jest.Mock).mockResolvedValue(
        jobRow({ type: SERVER_TYPE }),
      );

      const response = await request(server())
        .post(`/api/nodes/${NODE_ID}/jobs/${JOB_ID}/result`)
        .set(authHeader(admin.accessToken))
        .send({ type: SERVER_TYPE, result: {} })
        .expect(400);

      expect(response.body.message).toMatch(/not node-persistable/);
    });

    it('500, after failing the job through the NORMAL path, when persisting throws', async () => {
      // The server owns the row's lifecycle from the moment it starts
      // persisting; the node is told so, and told not to resubmit.
      const admin = await createMockAdminUser(context);
      givenNode(admin.id);
      (context.prismaMock.job.findUnique as jest.Mock).mockResolvedValue(jobRow());
      (context.prismaMock.job.update as jest.Mock).mockResolvedValue(jobRow({ status: 'pending' }));
      persistNodeResult.mockRejectedValue(new Error('write failed'));

      const response = await request(server())
        .post(`/api/nodes/${NODE_ID}/jobs/${JOB_ID}/result`)
        .set(authHeader(admin.accessToken))
        .send({ type: NODE_TYPE, result: { ok: true } })
        .expect(500);

      expect(response.body.details).toMatchObject({ jobId: JOB_ID, resubmit: false });
      // The job went through `JobTerminalService`, not through a terminal
      // write this controller invented.
      expect(context.prismaMock.job.update).toHaveBeenCalled();
      const written = (context.prismaMock.job.update as jest.Mock).mock.calls[0][0].data;
      expect(written.lastError).toContain('write failed');
    });
  });

  describe('failure reporting', () => {
    it('200 and reports the SERVER’s retry decision, not the node’s claim', async () => {
      const admin = await createMockAdminUser(context);
      givenNode(admin.id);
      (context.prismaMock.job.findUnique as jest.Mock).mockResolvedValue(jobRow());
      (context.prismaMock.job.update as jest.Mock).mockResolvedValue(jobRow({ status: 'pending' }));

      const response = await request(server())
        .post(`/api/nodes/${NODE_ID}/jobs/${JOB_ID}/failure`)
        .set(authHeader(admin.accessToken))
        // The node insists it should not be retried; the attempt budget says
        // otherwise, and the attempt budget is what governs.
        .send({ error: 'the provider hung up', willRetry: false })
        .expect(200);

      expect(response.body.data.outcome).toBe('retry-scheduled');
      expect(response.body.data.willRetry).toBe(true);
    });

    it('a node-reported rate limit defers rather than charging an attempt', async () => {
      const admin = await createMockAdminUser(context);
      givenNode(admin.id);
      (context.prismaMock.job.findUnique as jest.Mock).mockResolvedValue(
        jobRow({ attempts: 3 }),
      );
      (context.prismaMock.job.update as jest.Mock).mockResolvedValue(jobRow({ status: 'pending' }));

      const response = await request(server())
        .post(`/api/nodes/${NODE_ID}/jobs/${JOB_ID}/failure`)
        .set(authHeader(admin.accessToken))
        .send({ error: '429 Too Many Requests', rateLimited: true, retryAfterMs: 45_000 })
        .expect(200);

      expect(response.body.data.outcome).toBe('rate-limit-deferred');
      // The un-charge is `JobTerminalService`'s, reached through the flags —
      // this endpoint classifies nothing itself. Asserted here because the
      // flags crossing HTTP intact is exactly what could break.
      const written = (context.prismaMock.job.update as jest.Mock).mock.calls[0][0].data;
      expect(written.attempts).toBe(2);
      expect(written.rateLimitHits).toBe(1);
    });

    it('400 when no error message is given', async () => {
      const admin = await createMockAdminUser(context);

      await request(server())
        .post(`/api/nodes/${NODE_ID}/jobs/${JOB_ID}/failure`)
        .set(authHeader(admin.accessToken))
        .send({})
        .expect(400);
    });
  });

  // ===========================================================================
  // deregister
  // ===========================================================================

  describe('POST /api/nodes/:id/deregister', () => {
    it('200, marks the node offline, and touches no job', async () => {
      const admin = await createMockAdminUser(context);
      givenNode(admin.id);

      const response = await request(server())
        .post(`/api/nodes/${NODE_ID}/deregister`)
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data.status).toBe('offline');
      expect(context.prismaMock.job.update).not.toHaveBeenCalled();
      expect(context.prismaMock.job.updateMany).not.toHaveBeenCalled();
    });
  });
});
