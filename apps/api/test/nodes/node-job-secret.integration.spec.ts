// =============================================================================
// The per-job secret broker over the real HTTP stack (issue #349, epic #345)
// =============================================================================
//
// `node-data-plane.integration.spec.ts` proves the same thing one axis over for
// presigned URLs, and this file exists for the same three reasons — plus one
// that is unique to it.
//
//   * THE STATUS CODES ARE THE INSTRUCTION. `409` means "drop this work",
//     `400` means "fix your request", `403` means "this deployment does not do
//     this at all", `404` means "your job type has no credential to give" and
//     `503` means "not now, an operator has something to fix". A filter that
//     flattened any of them would change what an entire fleet does with no unit
//     test failing.
//   * ⚠ NOTHING LOGS THE MATERIAL. That is a property of the WHOLE request
//     pipeline — the interceptor, the transform and the exception filter all
//     see the response body, and any one of them could print it. It can only be
//     asserted by watching `Logger` across a real request, which is what the
//     `logging` block below does. The presigned-URL version of this assertion
//     is a leaked capability against one object; this one is a leaked
//     credential against a database.
//   * THE CLAIM-TIME INTERSECTION IS REAL. With `nodes.jobSecretBrokerEnabled`
//     off, the broker-carrying type must be ABSENT from
//     `GET /api/nodes/job-types` — the fence that means a well-behaved node
//     never reaches the 403 at all.
//
// THE TEST HANDLER IS REGISTERED INTO THE REAL REGISTRY, deliberately, and it
// is the one thing this suite substitutes. #349 ships with NO BROKER anywhere
// in the template (that is the point — the mechanism is reviewable before any
// concrete minting exists), so a suite that used only shipped handlers could
// assert the 404 arm and nothing else. Registering one here is registering a
// FORK's handler, through the same `JobHandlerRegistry.register` a fork uses,
// which is precisely the path this contract promises will work.
// =============================================================================

import { Logger } from '@nestjs/common';
import request from 'supertest';
import { z } from 'zod';

import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import type { IssuedJobSecret, JobSecretUsability } from '../../src/jobs/job-secret-broker';
import { SECRET_CLOCK_SKEW_ALLOWANCE_MS } from '../../src/nodes/node-secret-broker.service';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockAdminUser, createMockViewerUser } from '../helpers/auth-mock.helper';
import { closeTestApp, createTestApp, TestContext } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';

describe('Worker node per-job secret broker (Integration)', () => {
  let context: TestContext;

  /** A fork's node-eligible type that needs a credential. Registered below. */
  const SECRET_TYPE = 'test.needs-credential';
  const KIND = 'test.postgres';

  const NODE_ID = '11111111-1111-4111-8111-111111111111';
  const JOB_ID = '22222222-2222-4222-8222-222222222222';

  /**
   * The string that must never reach a log line.
   *
   * Distinctive on purpose — a password-shaped value that would be trivially
   * greppable in a real log, so the assertions below fail loudly rather than
   * subtly if any layer starts printing response bodies.
   */
  const PASSWORD = 'p4ssw0rd-must-never-be-logged-9f2c';
  const HANDLE = 'job_22222222_reader';

  const issue = jest.fn<Promise<IssuedJobSecret>, [unknown, Date]>();
  const revoke = jest.fn<Promise<void>, [string]>();
  const usable = jest.fn<Promise<JobSecretUsability>, []>();

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });

    // A fork's handler, through the real registry — see the file header.
    context.module.get(JobHandlerRegistry).register({
      type: SECRET_TYPE,
      process: async () => undefined,
      nodeResultSchema: z.object({ ok: z.boolean() }),
      persistNodeResult: async () => undefined,
      nodeSecretBroker: { kind: KIND, usable, issue, revoke },
    });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();

    usable.mockReset().mockResolvedValue({ ok: true });
    revoke.mockReset().mockResolvedValue(undefined);
    issue
      .mockReset()
      .mockImplementation(async (_job, until) => ({
        handle: HANDLE,
        expiresAt: until,
        material: { dsn: `postgres://reader:${PASSWORD}@db:5432/app` },
      }));

    (context.prismaMock.jobNodeSecret.upsert as jest.Mock).mockResolvedValue({});
    givenBrokerEnabled(true);
  });

  const server = () => context.app.getHttpServer();
  const secretPath = `/api/nodes/${NODE_ID}/jobs/${JOB_ID}/secret`;

  /**
   * The `nodes.jobSecretBrokerEnabled` system setting, as the real
   * `SystemSettingsService.getNodesPolicy` will read it.
   */
  function givenBrokerEnabled(enabled: boolean): void {
    (context.prismaMock.systemSettings.findUnique as jest.Mock).mockResolvedValue({
      id: 'settings-row',
      key: 'default',
      value: {
        nodes: {
          staleHeartbeatSeconds: 90,
          offlineStaleMultiplier: 4,
          offlineRetentionDays: 30,
          jobSecretBrokerEnabled: enabled,
        },
      },
      version: 1,
      updatedByUserId: null,
      updatedAt: new Date(),
    });
  }

  function nodeRow(ownerId: string, overrides: Record<string, unknown> = {}) {
    return {
      id: NODE_ID,
      name: 'prod-worker-1',
      hostname: 'box-a',
      platform: 'linux-x64',
      cliVersion: '1.0.0',
      eligibleTypes: [SECRET_TYPE],
      concurrency: 2,
      status: 'online',
      capabilities: null,
      registeredAt: new Date('2026-01-01T00:00:00.000Z'),
      lastHeartbeatAt: null,
      createdById: ownerId,
      ...overrides,
    };
  }

  /** A job this node holds legitimately: running, claimed, lease in the future. */
  function jobRow(overrides: Record<string, unknown> = {}) {
    return {
      id: JOB_ID,
      type: SECRET_TYPE,
      subjectType: null,
      subjectId: null,
      dedupKey: null,
      status: 'running',
      reason: null,
      priority: 100,
      providerKey: null,
      modelVersion: null,
      payload: null,
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

  function givenHeldJob(ownerId: string, overrides: Record<string, unknown> = {}) {
    (context.prismaMock.workerNode.findUnique as jest.Mock).mockResolvedValue(nodeRow(ownerId));
    (context.prismaMock.job.findUnique as jest.Mock).mockResolvedValue(jobRow(overrides));
  }

  // ===========================================================================
  // RBAC — and the `nod_` allowlist, which needed NO change
  // ===========================================================================

  describe('authentication and permissions', () => {
    it('401 when unauthenticated', async () => {
      await request(server()).post(secretPath).expect(401);
    });

    it('403 for a viewer — this is `nodes:write`, like every other mint here', async () => {
      // Minting a credential is emphatically not the shape of anything a
      // read-only auditor should be able to do.
      const viewer = await createMockViewerUser(context);

      await request(server()).post(secretPath).set(authHeader(viewer.accessToken)).expect(403);
    });

    it('is mounted under `/api/nodes`, so the `nod_` allowlist already covers it', async () => {
      // ⚠ VERIFYING THE CLAIM RATHER THAN ASSUMING IT. `JwtAuthGuard` admits a
      // `nod_` credential on `/api/nodes` and every path beneath, so this route
      // is inside the allowlist BY CONSTRUCTION and #349 changed no guard. The
      // assertion that proves it is negative and structural: the route resolves
      // (it is not a 404 from the router) on a prefix the allowlist covers.
      const admin = await createMockAdminUser(context);
      givenHeldJob(admin.id);

      const response = await request(server())
        .post(secretPath)
        .set(authHeader(admin.accessToken))
        .send({});

      expect(response.status).toBe(200);
      expect(secretPath.startsWith('/api/nodes/')).toBe(true);
    });
  });

  // ===========================================================================
  // The happy path
  // ===========================================================================

  describe('POST /api/nodes/:id/jobs/:jobId/secret', () => {
    it('200 with `{ kind, expiresAt, material }` and nothing else', async () => {
      const admin = await createMockAdminUser(context);
      givenHeldJob(admin.id);

      const response = await request(server())
        .post(secretPath)
        .set(authHeader(admin.accessToken))
        .send({})
        .expect(200);

      expect(Object.keys(response.body.data).sort()).toEqual([
        'expiresAt',
        'kind',
        'material',
      ]);
      expect(response.body.data.kind).toBe(KIND);
      expect(response.body.data.material.dsn).toContain(PASSWORD);
      // ⚠ NOT THE HANDLE. It is not secret, but it is not the node's business
      // either: revocation is the server's, by handle, and publishing it would
      // invite a client to build something on it.
      expect(response.body.data).not.toHaveProperty('handle');
    });

    it('answers `Cache-Control: no-store`', async () => {
      // Belt and braces over `POST` already being uncacheable — what comes back
      // is a credential, and an intermediary deciding to be clever is one
      // nobody would find out about.
      const admin = await createMockAdminUser(context);
      givenHeldJob(admin.id);

      const response = await request(server())
        .post(secretPath)
        .set(authHeader(admin.accessToken))
        .send({})
        .expect(200);

      expect(response.headers['cache-control']).toBe('no-store');
    });

    it('bounds the credential by the JOB’S LEASE, not by a clock of its own', async () => {
      const leaseExpiresAt = new Date(Date.now() + 123_000);
      const admin = await createMockAdminUser(context);
      givenHeldJob(admin.id, { leaseExpiresAt });

      const response = await request(server())
        .post(secretPath)
        .set(authHeader(admin.accessToken))
        .send({})
        .expect(200);

      // The `until` the broker was asked for IS the lease expiry, plus the
      // clock-skew allowance and NOTHING else. A second clock here — a
      // configured TTL, a node-requested duration, a per-broker overhang — is
      // what this assertion exists to refuse.
      const expected = new Date(leaseExpiresAt.getTime() + SECRET_CLOCK_SKEW_ALLOWANCE_MS);

      expect(issue.mock.calls[0][1]).toEqual(expected);
      expect(response.body.data.expiresAt).toBe(expected.toISOString());
    });

    it('adds the skew allowance HERE, so no broker has to — and so none may', async () => {
      const leaseExpiresAt = new Date(Date.now() + 123_000);
      const admin = await createMockAdminUser(context);
      givenHeldJob(admin.id, { leaseExpiresAt });

      await request(server())
        .post(secretPath)
        .set(authHeader(admin.accessToken))
        .send({})
        .expect(200);

      const until = issue.mock.calls[0][1];

      // ⚠ THE PAIR THAT KEEPS `JobSecretBroker.issue`'s CONTRACT TRUE. The
      // contract says a broker may grant LESS than `until` and must not grant
      // more; a credential's expiry is nonetheless enforced by the BACKEND's
      // clock while the lease is enforced by ours, so SOMETHING has to absorb
      // the skew. It is absorbed at this one funnel, ahead of every broker,
      // rather than by each broker padding `until` behind the caller's back —
      // which would make the contract false for its first implementation and
      // leave every later broker to invent its own unspecified overhang.
      //
      // `until` is therefore STRICTLY LATER than the raw lease...
      expect(until.getTime()).toBeGreaterThan(leaseExpiresAt.getTime());
      // ...by exactly the allowance, and by nothing that drifts.
      expect(until.getTime() - leaseExpiresAt.getTime()).toBe(SECRET_CLOCK_SKEW_ALLOWANCE_MS);

      // The mirror assertion — that a broker hands back exactly the instant it
      // was given — is `src/db-backup/pg-job-role.broker.spec.ts` and, against
      // a real catalog, `pg-job-role.broker.db.spec.ts`.
    });

    it('records the HANDLE, and nothing that could be the material', async () => {
      const admin = await createMockAdminUser(context);
      givenHeldJob(admin.id);

      await request(server())
        .post(secretPath)
        .set(authHeader(admin.accessToken))
        .send({})
        .expect(200);

      const written = (context.prismaMock.jobNodeSecret.upsert as jest.Mock).mock.calls[0][0];
      expect(written.where).toEqual({ jobId_kind: { jobId: JOB_ID, kind: KIND } });
      expect(written.create.handle).toBe(HANDLE);
      // The whole point of the table, asserted from the write side: nothing
      // resembling the credential reaches Prisma at all.
      expect(JSON.stringify(written)).not.toContain(PASSWORD);
    });

    it('accepts a request with no body at all', async () => {
      // The only correct request — there is nothing a node may declare.
      const admin = await createMockAdminUser(context);
      givenHeldJob(admin.id);

      await request(server()).post(secretPath).set(authHeader(admin.accessToken)).expect(200);
    });

    it('is re-callable while the lease is live, and upserts the SAME grant', async () => {
      // A node asks again as a matter of course: a restarted process still
      // holding the lease, a lost response. ONE CREDENTIAL PER JOB, EVER.
      const admin = await createMockAdminUser(context);
      givenHeldJob(admin.id);

      await request(server()).post(secretPath).set(authHeader(admin.accessToken)).send({}).expect(200);
      await request(server()).post(secretPath).set(authHeader(admin.accessToken)).send({}).expect(200);

      const calls = (context.prismaMock.jobNodeSecret.upsert as jest.Mock).mock.calls;
      expect(calls).toHaveLength(2);
      // Both land on the same `(jobId, kind)` row — which the unique index makes
      // structural, and which an `create`-shaped write would have violated.
      expect(calls[0][0].where).toEqual(calls[1][0].where);
    });
  });

  // ===========================================================================
  // The refusals
  // ===========================================================================

  describe('refusals', () => {
    it('409 — and mints NOTHING — once the lease has expired', async () => {
      const admin = await createMockAdminUser(context);
      givenHeldJob(admin.id, { leaseExpiresAt: new Date(Date.now() - 1_000) });

      const response = await request(server())
        .post(secretPath)
        .set(authHeader(admin.accessToken))
        .send({})
        .expect(409);

      // THE EXISTING `notHeldByNode` MESSAGE, reused rather than rewritten:
      // the guard is `assertJobHeldByNode`, not a second copy of it.
      expect(response.body.details.reason).toBe('lease_not_held');
      expect(response.body.message).toContain('Drop this work');
      expect(issue).not.toHaveBeenCalled();
    });

    it('409 for a job claimed by a DIFFERENT node', async () => {
      const admin = await createMockAdminUser(context);
      givenHeldJob(admin.id, { claimedByNodeId: 'some-other-node' });

      await request(server())
        .post(secretPath)
        .set(authHeader(admin.accessToken))
        .send({})
        .expect(409);

      expect(issue).not.toHaveBeenCalled();
    });

    it('403 when the node belongs to another user, before any job is read', async () => {
      const admin = await createMockAdminUser(context);
      (context.prismaMock.workerNode.findUnique as jest.Mock).mockResolvedValue(
        nodeRow('somebody-else')
      );

      await request(server())
        .post(secretPath)
        .set(authHeader(admin.accessToken))
        .send({})
        .expect(403);

      expect(context.prismaMock.job.findUnique).not.toHaveBeenCalled();
    });

    it.each([
      ['kind', { kind: 'postgres.superuser' }],
      ['ttl', { ttl: 86400 }],
      ['database', { database: 'production' }],
    ])('400 REFUSING a node-supplied `%s`, naming it', async (field, body) => {
      // A node may not request a secret it was not assigned. Refused rather
      // than ignored, for the reason the upload route already records: ignoring
      // means the node's author never learns their field had no effect.
      const admin = await createMockAdminUser(context);
      givenHeldJob(admin.id);

      const response = await request(server())
        .post(secretPath)
        .set(authHeader(admin.accessToken))
        .send(body)
        .expect(400);

      expect(response.body.message).toContain(field);
      expect(response.body.details.rejectedFields).toEqual([field]);
      expect(response.body.details.permittedFields).toEqual([]);
      expect(issue).not.toHaveBeenCalled();
    });

    it('400 comes BEFORE the setting check, so a bad body is a bad body either way', async () => {
      const admin = await createMockAdminUser(context);
      givenBrokerEnabled(false);
      givenHeldJob(admin.id);

      await request(server())
        .post(secretPath)
        .set(authHeader(admin.accessToken))
        .send({ ttl: 1 })
        .expect(400);
    });

    it('403 with a NAMED REASON when the deployment has brokering switched off', async () => {
      // "403" on its own sends a node operator to look at permissions — and
      // their credential is fine. What is wrong is a system setting they may
      // not even be able to see, so the reason names it.
      const admin = await createMockAdminUser(context);
      givenBrokerEnabled(false);
      givenHeldJob(admin.id);

      const response = await request(server())
        .post(secretPath)
        .set(authHeader(admin.accessToken))
        .send({})
        .expect(403);

      expect(response.body.details.reason).toBe('job_secret_broker_disabled');
      expect(response.body.details.setting).toBe('nodes.jobSecretBrokerEnabled');
      expect(issue).not.toHaveBeenCalled();
      expect(usable).not.toHaveBeenCalled();
    });

    it('404 for a job whose type declares NO broker — never an issued secret', async () => {
      // The state #349 actually ships in: `example.checksum` is node-eligible
      // and carries no `nodeSecretBroker`, so there is nothing to give. A 200
      // here would mean the endpoint had invented a credential.
      const admin = await createMockAdminUser(context);
      givenHeldJob(admin.id, { type: 'example.checksum' });

      const response = await request(server())
        .post(secretPath)
        .set(authHeader(admin.accessToken))
        .send({})
        .expect(404);

      expect(response.body.details.reason).toBe('no_broker_for_type');
      expect(response.body.message).toContain('example.checksum');
      expect(issue).not.toHaveBeenCalled();
      expect(context.prismaMock.jobNodeSecret.upsert).not.toHaveBeenCalled();
    });

    it('503 carrying the broker’s `remedy` when it cannot mint right now', async () => {
      // 503 and not 422: unlike an unresolvable input, this CAN come right
      // without the job changing — an administrator grants a privilege and the
      // very same job succeeds. Telling the node "this can never work" would be
      // false, and would burn the attempt budget in the minute before somebody
      // fixed it.
      const admin = await createMockAdminUser(context);
      givenHeldJob(admin.id);
      usable.mockResolvedValue({
        ok: false,
        reason: 'the application database user lacks CREATEROLE',
        remedy: 'ALTER ROLE app WITH CREATEROLE;',
      });

      const response = await request(server())
        .post(secretPath)
        .set(authHeader(admin.accessToken))
        .send({})
        .expect(503);

      expect(response.body.details.reason).toBe('broker_unusable');
      expect(response.body.details.remedy).toBe('ALTER ROLE app WITH CREATEROLE;');
      expect(response.body.details.retryable).toBe(true);
      expect(issue).not.toHaveBeenCalled();
    });

    it('REVOKES what it could not record, rather than leaving an orphan', async () => {
      // The ordering rule: a grant that exists in the backend with no row in
      // `job_node_secrets` is a live credential neither revocation path can ever
      // find, because both work from handles this table holds.
      const admin = await createMockAdminUser(context);
      givenHeldJob(admin.id);
      (context.prismaMock.jobNodeSecret.upsert as jest.Mock).mockRejectedValue(
        new Error('deadlock detected')
      );

      const response = await request(server())
        .post(secretPath)
        .set(authHeader(admin.accessToken))
        .send({})
        .expect(500);

      expect(revoke).toHaveBeenCalledWith(HANDLE);
      expect(JSON.stringify(response.body)).not.toContain(PASSWORD);
    });
  });

  // ===========================================================================
  // The claim-time intersection — the fence a well-behaved node never passes
  // ===========================================================================

  describe('GET /api/nodes/job-types with brokering off', () => {
    it('omits the broker-carrying type entirely', async () => {
      // ⚠ A RUNTIME INTERSECTION, NOT A MUTATION OF THE REGISTRY. The handler
      // still carries both node-eligibility members and its broker; the
      // deployment simply declines to offer the type.
      const admin = await createMockAdminUser(context);
      givenBrokerEnabled(false);

      const response = await request(server())
        .get('/api/nodes/job-types')
        .set(authHeader(admin.accessToken))
        .expect(200);

      const types = response.body.data.types.map((entry: { type: string }) => entry.type);
      expect(types).not.toContain(SECRET_TYPE);
      // …and every other node-eligible type is untouched, which is what makes
      // this an intersection rather than a switch on the whole node plane.
      expect(types).toContain('example.checksum');
    });

    it('lists it again once brokering is on — the handler never changed', async () => {
      const admin = await createMockAdminUser(context);
      givenBrokerEnabled(true);

      const response = await request(server())
        .get('/api/nodes/job-types')
        .set(authHeader(admin.accessToken))
        .expect(200);

      const types = response.body.data.types.map((entry: { type: string }) => entry.type);
      expect(types).toContain(SECRET_TYPE);
    });

    it('never offers the type to a CLAIM either', async () => {
      // The fence that matters operationally: a node in a deployment with the
      // setting off is never handed the job at all, so it never reaches the 403.
      const admin = await createMockAdminUser(context);
      givenBrokerEnabled(false);
      (context.prismaMock.workerNode.findUnique as jest.Mock).mockResolvedValue(
        nodeRow(admin.id)
      );
      (context.prismaMock.$queryRaw as jest.Mock).mockResolvedValue([]);

      await request(server())
        .post(`/api/nodes/${NODE_ID}/claim`)
        .set(authHeader(admin.accessToken))
        .send({ types: [SECRET_TYPE] })
        .expect(200);

      // The claim ran with an EMPTY eligible list — the raw claim statement is
      // never reached, because there is nothing left to ask for.
      expect(context.prismaMock.$queryRaw).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // ⚠ The credential must not reach a log
  // ===========================================================================

  describe('logging', () => {
    /** Every argument passed to any Nest logger during `run()`, flattened. */
    async function captureLogs(run: () => Promise<unknown>): Promise<string[]> {
      const lines: string[] = [];
      const record = (...args: unknown[]) => void lines.push(JSON.stringify(args));

      const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
        jest.spyOn(Logger.prototype, level).mockImplementation(record)
      );

      try {
        await run();
      } finally {
        spies.forEach((spy) => spy.mockRestore());
      }

      return lines;
    }

    it('records method, url and duration for a secret request — and nothing else', async () => {
      const admin = await createMockAdminUser(context);
      givenHeldJob(admin.id);

      const lines = await captureLogs(() =>
        request(server()).post(secretPath).set(authHeader(admin.accessToken)).send({}).expect(200)
      );

      const httpLines = lines.filter((line) => line.includes('POST /api/nodes/'));
      expect(httpLines.length).toBeGreaterThan(0);
      expect(
        httpLines.some((line) => /POST \/api\/nodes\/[^"]*secret - \d+ms/.test(line))
      ).toBe(true);

      for (const line of lines) {
        expect(line).not.toContain(PASSWORD);
        expect(line).not.toContain('postgres://');
      }
    });

    it('names the handle and the kind, which is what an operator traces with', async () => {
      // The positive half. A refusal to log anything at all would be worse than
      // useless: "which node held a credential to this database, and when" has
      // to be answerable, and the handle is how.
      const admin = await createMockAdminUser(context);
      givenHeldJob(admin.id);

      const lines = await captureLogs(() =>
        request(server()).post(secretPath).set(authHeader(admin.accessToken)).send({}).expect(200)
      );

      expect(lines.some((line) => line.includes(HANDLE) && line.includes(KIND))).toBe(true);
    });

    it('does not log the material on the FAILURE path either', async () => {
      // The easiest place for a secret to escape is an error handler somebody
      // added under pressure — so the 500 path is asserted as well as the 200.
      const admin = await createMockAdminUser(context);
      givenHeldJob(admin.id);
      (context.prismaMock.jobNodeSecret.upsert as jest.Mock).mockRejectedValue(
        new Error('deadlock detected')
      );

      const lines = await captureLogs(() =>
        request(server()).post(secretPath).set(authHeader(admin.accessToken)).send({}).expect(500)
      );

      for (const line of lines) {
        expect(line).not.toContain(PASSWORD);
      }
    });
  });
});
