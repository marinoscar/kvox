// =============================================================================
// The node data plane over the real HTTP stack (issue #269, epic #254)
// =============================================================================
//
// `src/nodes/node-data-plane.service.spec.ts` proves what the service
// DECIDES. This file proves the decisions survive the trip through the five
// things that carry them — the router, the RBAC guards, the global Zod pipe,
// the response envelope and the exception filter — because every one of them
// has silently changed a service's answer at some point in this repository's
// history.
//
// Three of the assertions here can ONLY be made at this level:
//
//   * ROUTE ORDER. `GET /api/nodes/job-types` is a literal sitting beside an
//     existing `GET /api/nodes/:id`. Declared in the wrong order it does not
//     fail loudly — it routes into the node lookup and `ParseUUIDPipe`
//     answers `400 "Validation failed (uuid is expected)"`, which names
//     nothing about the real mistake. Only a real request through the real
//     router can tell the two apart, and a unit test on the controller method
//     would pass either way.
//   * THE STATUS CODES ARE THE INSTRUCTION. `409` means "drop this work",
//     `422` means "this job can never succeed — report it failed", and `400`
//     means "fix your request". A filter that flattened any of them would
//     change what an entire fleet does with no unit test failing.
//   * NOTHING LOGS THE SIGNED URL. That is a property of the whole request
//     pipeline, not of one service: the interceptor, the transform and the
//     filter all see the response body, and any one of them could print it.
//     Asserted here by watching `Logger` across a real request.
//
// The storage provider is the one thing substituted. Signing is the AWS SDK's
// job and is not what this file is about; what matters is WHICH KEY was
// signed, with WHAT expiry, and whether the URL that came back ever appeared
// anywhere it should not.
// =============================================================================

import { Logger } from '@nestjs/common';
import request from 'supertest';

import { STORAGE_PROVIDER } from '../../src/storage/providers/storage-provider.interface';
import { createMockStorageProvider } from '../mocks/storage-provider.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockAdminUser, createMockViewerUser } from '../helpers/auth-mock.helper';
import { closeTestApp, createTestApp, TestContext } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';

describe('Worker node data plane (Integration)', () => {
  let context: TestContext;

  /**
   * The template's own node-eligible handler, registered by `JobsModule` — no
   * test-local registration anywhere in this file. That is deliberate: #269's
   * claim is that the shipped `example.checksum` makes the fleet reachable end
   * to end, and a suite that registered its own type would prove only that the
   * suite can register a type.
   */
  const NODE_TYPE = 'example.checksum';

  const NODE_ID = '11111111-1111-4111-8111-111111111111';
  const JOB_ID = '22222222-2222-4222-8222-222222222222';
  const OBJECT_ID = '44444444-4444-4444-8444-444444444444';

  const SIGNED_GET = 'https://storage.example.test/get?X-Amz-Signature=aaaaaaaaaaaa';
  const SIGNED_PUT = 'https://storage.example.test/put?X-Amz-Signature=bbbbbbbbbbbb';

  const storage = createMockStorageProvider();

  beforeAll(async () => {
    context = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [{ provide: STORAGE_PROVIDER, useValue: storage }],
    });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();

    storage.getSignedDownloadUrl.mockClear().mockResolvedValue(SIGNED_GET);
    storage.getSignedPutUrl.mockClear().mockResolvedValue(SIGNED_PUT);
  });

  const server = () => context.app.getHttpServer();

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

  /** A job this node holds legitimately: running, claimed, lease in the future. */
  function jobRow(overrides: Record<string, unknown> = {}) {
    return {
      id: JOB_ID,
      type: NODE_TYPE,
      subjectType: 'storage_object',
      subjectId: OBJECT_ID,
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

  function objectRow(overrides: Record<string, unknown> = {}) {
    return {
      id: OBJECT_ID,
      name: 'invoice.pdf',
      size: BigInt(4096),
      mimeType: 'application/pdf',
      storageKey: 'uploads/1700000000/abc.pdf',
      storageProvider: 's3',
      bucket: 'test-bucket',
      status: 'ready',
      s3UploadId: null,
      metadata: null,
      // Uploaded by SOMEBODY ELSE, which is the ordinary case: a node's owner
      // is the operator who registered the machine, not whoever uploaded the
      // file. See the ownership test below.
      uploadedById: 'a-different-user-entirely',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  /** A healthy node, a held job and a resolvable input — the happy arrangement. */
  function givenHeldJob(ownerId: string, overrides: Record<string, unknown> = {}) {
    (context.prismaMock.workerNode.findUnique as jest.Mock).mockResolvedValue(nodeRow(ownerId));
    (context.prismaMock.job.findUnique as jest.Mock).mockResolvedValue(jobRow(overrides));
    (context.prismaMock.storageObject.findUnique as jest.Mock).mockResolvedValue(objectRow());
  }

  const downloadPath = `/api/nodes/${NODE_ID}/jobs/${JOB_ID}/download-url`;
  const uploadPath = `/api/nodes/${NODE_ID}/jobs/${JOB_ID}/upload-url`;

  // ===========================================================================
  // RBAC
  // ===========================================================================

  describe('authentication and permissions', () => {
    const routes: Array<[string, 'get' | 'post', string]> = [
      ['GET /nodes/job-types', 'get', '/api/nodes/job-types'],
      ['POST …/download-url', 'post', downloadPath],
      ['POST …/upload-url', 'post', uploadPath],
    ];

    it.each(routes)('401 on %s when unauthenticated', async (_label, method, path) => {
      await request(server())[method](path).expect(401);
    });

    it.each(routes)('403 on %s for a viewer', async (_label, method, path) => {
      const viewer = await createMockViewerUser(context);

      await request(server())[method](path).set(authHeader(viewer.accessToken)).expect(403);
    });
  });

  // ===========================================================================
  // GET /api/nodes/job-types
  // ===========================================================================

  describe('GET /api/nodes/job-types', () => {
    it('is reachable — the literal is declared BEFORE `GET /nodes/:id`', async () => {
      // Declared after, this request would be parsed as a node id and refused
      // by `ParseUUIDPipe` with a 400 that names nothing.
      const admin = await createMockAdminUser(context);

      await request(server())
        .get('/api/nodes/job-types')
        .set(authHeader(admin.accessToken))
        .expect(200);
    });

    it('publishes valid JSON Schema for EVERY node-eligible type', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(server())
        .get('/api/nodes/job-types')
        .set(authHeader(admin.accessToken))
        .expect(200);

      const { types } = response.body.data;
      expect(types.length).toBeGreaterThan(0);

      for (const entry of types) {
        expect(typeof entry.type).toBe('string');
        expect(typeof entry.label).toBe('string');
        // Every schema this template ships must be publishable; `null` is the
        // supported answer for a fork's unrepresentable schema, and a null
        // appearing HERE would mean one of ours stopped converting.
        expect(entry.resultSchema).not.toBeNull();
        expect(entry.resultSchema.$schema).toContain('json-schema.org');
        expect(entry.resultSchema.type).toBe('object');
        expect(Object.keys(entry.resultSchema.properties).length).toBeGreaterThan(0);
      }
    });

    it('carries `example.checksum`’s real constraints, not a placeholder', async () => {
      // The whole value of publishing the schema is that a client can reject a
      // wrong digest BEFORE posting it. A schema that lost the pattern would
      // still be valid JSON Schema and would validate nothing.
      const admin = await createMockAdminUser(context);

      const response = await request(server())
        .get('/api/nodes/job-types')
        .set(authHeader(admin.accessToken))
        .expect(200);

      const checksum = response.body.data.types.find(
        (entry: { type: string }) => entry.type === NODE_TYPE
      );

      expect(checksum).toBeDefined();
      expect(checksum.label).toBe('Example checksum');
      expect(checksum.resultSchema.properties.sha256.pattern).toBe('^[0-9a-f]{64}$');
      expect(checksum.resultSchema.properties.bytes.type).toBe('integer');
      expect(checksum.resultSchema.required.sort()).toEqual(['bytes', 'sha256']);
    });

    it('never lists a server-only type', async () => {
      // `example.echo` and `job.history.purge` carry neither optional member,
      // so no node could ever store a result for them.
      const admin = await createMockAdminUser(context);

      const response = await request(server())
        .get('/api/nodes/job-types')
        .set(authHeader(admin.accessToken))
        .expect(200);

      const types = response.body.data.types.map((entry: { type: string }) => entry.type);
      expect(types).toContain(NODE_TYPE);
      expect(types).not.toContain('example.echo');
      expect(types).not.toContain('job.history.purge');
    });
  });

  // ===========================================================================
  // download-url
  // ===========================================================================

  describe('POST /api/nodes/:id/jobs/:jobId/download-url', () => {
    it('200 with a signed GET for the job’s input object', async () => {
      const admin = await createMockAdminUser(context);
      givenHeldJob(admin.id);

      const response = await request(server())
        .post(downloadPath)
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data).toMatchObject({
        url: SIGNED_GET,
        objectId: OBJECT_ID,
        size: '4096',
        mimeType: 'application/pdf',
      });
      expect(storage.getSignedDownloadUrl).toHaveBeenCalledWith(
        'uploads/1700000000/abc.pdf',
        expect.objectContaining({ expiresIn: expect.any(Number) })
      );
    });

    it('bounds the expiry, and reports it both ways', async () => {
      const admin = await createMockAdminUser(context);
      givenHeldJob(admin.id);

      const response = await request(server())
        .post(downloadPath)
        .set(authHeader(admin.accessToken))
        .expect(200);

      const { expiresIn, expiresAt } = response.body.data;
      expect(expiresIn).toBeGreaterThanOrEqual(60);
      expect(expiresIn).toBeLessThanOrEqual(900);
      const gap = Date.parse(expiresAt) - Date.now();
      expect(gap).toBeGreaterThan(0);
      expect(gap).toBeLessThanOrEqual(900_000);
    });

    it('does NOT apply the per-user ownership check the interactive API applies', async () => {
      // The object belongs to someone who is not this node's owner. Routing a
      // node through `ObjectsService.getDownloadUrl` would 403 here, and every
      // cross-user job in the fleet would fail for a reason that has nothing
      // to do with the job. A node is an internal executor; its bound is the
      // LEASE, not ownership of the bytes.
      const admin = await createMockAdminUser(context);
      givenHeldJob(admin.id);

      await request(server())
        .post(downloadPath)
        .set(authHeader(admin.accessToken))
        .expect(200);
    });

    it('409 — and signs NOTHING — once the lease has expired', async () => {
      const admin = await createMockAdminUser(context);
      givenHeldJob(admin.id, { leaseExpiresAt: new Date(Date.now() - 1_000) });

      await request(server())
        .post(downloadPath)
        .set(authHeader(admin.accessToken))
        .expect(409);

      expect(storage.getSignedDownloadUrl).not.toHaveBeenCalled();
    });

    it('409 for a job claimed by a DIFFERENT node', async () => {
      const admin = await createMockAdminUser(context);
      givenHeldJob(admin.id, { claimedByNodeId: 'some-other-node' });

      await request(server())
        .post(downloadPath)
        .set(authHeader(admin.accessToken))
        .expect(409);

      expect(storage.getSignedDownloadUrl).not.toHaveBeenCalled();
    });

    it('403 when the node belongs to another user', async () => {
      const admin = await createMockAdminUser(context);
      (context.prismaMock.workerNode.findUnique as jest.Mock).mockResolvedValue(
        nodeRow('somebody-else')
      );

      await request(server())
        .post(downloadPath)
        .set(authHeader(admin.accessToken))
        .expect(403);

      expect(context.prismaMock.job.findUnique).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Input resolution — the `ENOENT … open ''` fence, over HTTP
  // ===========================================================================

  describe('input resolution failures', () => {
    it.each([
      [
        'the job names no subject',
        () => ({ job: { subjectId: null }, object: objectRow() }),
        'missing_subject_id',
      ],
      [
        'the storage object has been deleted',
        () => ({ job: {}, object: null }),
        'input_object_not_found',
      ],
      [
        'the storage object has no key',
        () => ({ job: {}, object: objectRow({ storageKey: '' }) }),
        'input_object_has_no_storage_key',
      ],
    ])('422 with `details.reason` when %s', async (_label, arrange, reason) => {
      const admin = await createMockAdminUser(context);
      const { job, object } = arrange();
      givenHeldJob(admin.id, job);
      (context.prismaMock.storageObject.findUnique as jest.Mock).mockResolvedValue(object);

      const response = await request(server())
        .post(downloadPath)
        .set(authHeader(admin.accessToken))
        .expect(422);

      expect(response.body.code).toBe('UNPROCESSABLE_ENTITY');
      expect(response.body.details).toMatchObject({
        jobId: JOB_ID,
        reason,
        retryable: false,
      });
      // The failure mode this whole path exists to prevent: an error naming
      // nothing, identical for all three causes.
      expect(response.body.message).not.toMatch(/ENOENT|open ''/);
      expect(response.body.message).toContain(JOB_ID);

      expect(storage.getSignedDownloadUrl).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // upload-url — the server chooses the key
  // ===========================================================================

  describe('POST /api/nodes/:id/jobs/:jobId/upload-url', () => {
    it('200, and the key is DERIVED FROM THE JOB, not from the request', async () => {
      // Also the #348 regression fence at the HTTP level: `example.checksum`
      // is registered by the real `JobsModule` here and does NOT implement
      // `deriveOutputKey`, so the default template must survive that member
      // existing — unchanged, through the router, the pipe and the envelope.
      const admin = await createMockAdminUser(context);
      givenHeldJob(admin.id);

      const response = await request(server())
        .post(uploadPath)
        .set(authHeader(admin.accessToken))
        .send({})
        .expect(200);

      expect(response.body.data.url).toBe(SIGNED_PUT);
      expect(response.body.data.key).toMatch(
        new RegExp(`^node-outputs/${JOB_ID}/[0-9a-f-]{36}$`)
      );
      // The key that was SIGNED, not merely the one that was reported.
      expect(storage.getSignedPutUrl).toHaveBeenCalledWith(
        response.body.data.key,
        expect.objectContaining({ expiresIn: expect.any(Number) })
      );
    });

    it('accepts a request with no body at all', async () => {
      // A node with nothing to declare should not have to send `{}` to
      // satisfy a parser; the schema defaults it.
      const admin = await createMockAdminUser(context);
      givenHeldJob(admin.id);

      await request(server()).post(uploadPath).set(authHeader(admin.accessToken)).expect(200);
    });

    it.each([
      ['key', { key: '../../secrets/config.json' }],
      ['storageKey', { storageKey: 'uploads/1700000000/abc.pdf' }],
    ])('400 REFUSING a node-supplied `%s`, naming it', async (field, body) => {
      // Refused rather than silently ignored. A signed PUT is an unconditional
      // overwrite of its key, and the second case above is the one that
      // matters: it is the storage key of the job's own INPUT object, so a
      // server that honoured it would let a node destroy the file it was
      // asked to read.
      const admin = await createMockAdminUser(context);
      givenHeldJob(admin.id);

      const response = await request(server())
        .post(uploadPath)
        .set(authHeader(admin.accessToken))
        .send(body)
        .expect(400);

      expect(response.body.message).toContain(field);
      expect(response.body.details.rejectedFields).toEqual([field]);
      expect(storage.getSignedPutUrl).not.toHaveBeenCalled();
    });

    it('409 — and signs NOTHING — once the lease has expired', async () => {
      const admin = await createMockAdminUser(context);
      givenHeldJob(admin.id, { leaseExpiresAt: new Date(Date.now() - 1_000) });

      await request(server())
        .post(uploadPath)
        .set(authHeader(admin.accessToken))
        .send({})
        .expect(409);

      expect(storage.getSignedPutUrl).not.toHaveBeenCalled();
    });

    it('does not need the job to have a resolvable INPUT — an output is not an input', async () => {
      // A job that writes without reading is legitimate, so the upload route
      // deliberately does not resolve the input object.
      const admin = await createMockAdminUser(context);
      givenHeldJob(admin.id, { subjectId: null });

      await request(server())
        .post(uploadPath)
        .set(authHeader(admin.accessToken))
        .send({})
        .expect(200);
    });
  });

  // ===========================================================================
  // Submitting an `example.checksum` result over the wire
  // ===========================================================================

  describe('POST /api/nodes/:id/jobs/:jobId/result for `example.checksum`', () => {
    const path = `/api/nodes/${NODE_ID}/jobs/${JOB_ID}/result`;
    const VALID_SHA = 'a'.repeat(64);

    it('200, and the checksum lands in the object’s metadata', async () => {
      const admin = await createMockAdminUser(context);
      givenHeldJob(admin.id);
      (context.prismaMock.storageObject.update as jest.Mock).mockResolvedValue(objectRow());
      (context.prismaMock.job.update as jest.Mock).mockResolvedValue(
        jobRow({ status: 'succeeded' })
      );

      const response = await request(server())
        .post(path)
        .set(authHeader(admin.accessToken))
        .send({ type: NODE_TYPE, result: { sha256: VALID_SHA, bytes: 4096 } })
        .expect(200);

      expect(response.body.data.outcome).toBe('succeeded');
      const written = (context.prismaMock.storageObject.update as jest.Mock).mock.calls[0][0];
      expect(written.where).toEqual({ id: OBJECT_ID });
      expect(written.data.metadata.checksum).toMatchObject({
        algorithm: 'sha256',
        sha256: VALID_SHA,
        bytes: 4096,
        computedBy: 'node',
      });
    });

    it.each([
      ['an upper-case digest', { sha256: VALID_SHA.toUpperCase(), bytes: 1 }],
      ['a truncated digest', { sha256: 'abc', bytes: 1 }],
      ['a missing byte count', { sha256: VALID_SHA }],
      ['a fractional byte count', { sha256: VALID_SHA, bytes: 0.5 }],
    ])('400 for %s — refused BEFORE `persistNodeResult` is reached', async (_label, result) => {
      // The trust boundary. `nodeResultSchema` is parsed in
      // `NodesService.submitResult`, so nothing this handler would write can
      // happen: no `storageObject.update`, and no terminal `job.update`
      // either — the job is still the node's to resubmit for.
      const admin = await createMockAdminUser(context);
      givenHeldJob(admin.id);

      const response = await request(server())
        .post(path)
        .set(authHeader(admin.accessToken))
        .send({ type: NODE_TYPE, result })
        .expect(400);

      // The issue list survives inside `details` — the only key the exception
      // filter forwards.
      expect(response.body.details.issues).toBeDefined();
      expect(context.prismaMock.storageObject.update).not.toHaveBeenCalled();
      expect(context.prismaMock.job.update).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // ⚠ The signed URL must not reach a log
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

    it('records method, url and duration for a download-url request — and nothing else', async () => {
      const admin = await createMockAdminUser(context);
      givenHeldJob(admin.id);

      const lines = await captureLogs(() =>
        request(server()).post(downloadPath).set(authHeader(admin.accessToken)).expect(200)
      );

      const httpLines = lines.filter((line) => line.includes('POST /api/nodes/'));
      expect(httpLines.length).toBeGreaterThan(0);
      // `LoggingInterceptor` writes exactly `<method> <url> - <n>ms`. Anything
      // that appended the response body would fail this and would have put a
      // bearer capability into the log.
      expect(
        httpLines.some((line) => /POST \/api\/nodes\/[^"]*download-url - \d+ms/.test(line))
      ).toBe(true);

      for (const line of lines) {
        expect(line).not.toContain(SIGNED_GET);
        expect(line).not.toContain('X-Amz-Signature');
        expect(line).not.toContain('storage.example.test');
      }
    });

    it('never logs the signed PUT either, nor the response body around it', async () => {
      const admin = await createMockAdminUser(context);
      givenHeldJob(admin.id);

      const lines = await captureLogs(() =>
        request(server())
          .post(uploadPath)
          .set(authHeader(admin.accessToken))
          .send({})
          .expect(200)
      );

      for (const line of lines) {
        expect(line).not.toContain(SIGNED_PUT);
        expect(line).not.toContain('X-Amz-Signature');
      }
      // The KEY, by contrast, IS logged on purpose: it is not a capability,
      // and it is the one thing an operator needs to find a node's output in
      // the bucket months later.
      expect(lines.some((line) => line.includes('node-outputs/'))).toBe(true);
    });
  });
});
