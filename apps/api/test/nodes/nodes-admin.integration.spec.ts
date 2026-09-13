// =============================================================================
// /api/admin/nodes over the real HTTP stack (issue #270, epic #254)
// =============================================================================
//
// THE CASE THIS FILE EXISTS FOR IS THE ROUTE ORDER. Nest matches in
// DECLARATION ORDER, not by specificity: `GET /admin/nodes/credentials` is one
// segment past the prefix, exactly the shape `GET /admin/nodes/:id` matches,
// so declaring `:id` first captures it with `id = 'credentials'` and
// `ParseUUIDPipe` answers `400 Validation failed (uuid is expected)`. There is
// no error at boot and no warning in the log — just an administrator pressing
// "credentials" and being told their UUID is malformed.
//
// That cannot be asserted by reading `nodes-admin.controller.ts`, because what
// is being tested is the ROUTER's behaviour given the decorators. So the
// assertion is a real request through the real router, checking that the
// credentials service — and not the node lookup — is what ran.
//
// The RBAC surface is asserted here for the same reason it is in
// `nodes.integration.spec.ts`: these routes list every operator's email and
// delete other people's nodes, so "Admin only" has to be true of the mounted
// route, not merely of a decorator somebody wrote.
// =============================================================================

import request from 'supertest';

import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  authHeader,
  createMockAdminUser,
  createMockContributorUser,
  createMockViewerUser,
} from '../helpers/auth-mock.helper';
import { closeTestApp, createTestApp, TestContext } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';

describe('Admin fleet plane (Integration)', () => {
  let context: TestContext;

  const NODE_ID = '33333333-3333-4333-8333-333333333333';
  const CREDENTIAL_ID = '44444444-4444-4444-8444-444444444444';

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
  });

  const server = () => context.app.getHttpServer();

  function nodeRow(overrides: Record<string, unknown> = {}) {
    return {
      id: NODE_ID,
      name: 'prod-worker-1',
      hostname: 'box-a',
      platform: 'linux-x64',
      cliVersion: '1.0.0',
      eligibleTypes: ['example.checksum'],
      concurrency: 2,
      status: 'online',
      capabilities: null,
      registeredAt: new Date('2026-01-01T00:00:00.000Z'),
      lastHeartbeatAt: new Date(),
      createdById: 'owner-1',
      // This mocks what Prisma actually returns for `OWNER_SELECT`: the
      // column is `displayName` (issue #340 — the code used to select the
      // non-existent `name` and this fixture used to match that bug, which is
      // exactly why the mock-Prisma suite didn't catch it). The wire field is
      // still `owner.name` — `toAdminNodeDto` maps `displayName` -> `name` —
      // so assertions below deliberately keep checking `owner.name`.
      createdBy: { id: 'owner-1', email: 'ops@example.test', displayName: 'Ops' },
      ...overrides,
    };
  }

  function credentialRow(overrides: Record<string, unknown> = {}) {
    return {
      id: CREDENTIAL_ID,
      name: 'gpu-box',
      tokenPrefix: 'nod_1a2b',
      expiresAt: null,
      lastUsedAt: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      revokedAt: null,
      // Same asymmetry as `nodeRow` above: `CREDENTIAL_OWNER_SELECT` reads
      // `displayName` off `User`; `listCredentials` maps it to `owner.name`
      // on the wire.
      user: { id: 'owner-1', email: 'ops@example.test', displayName: 'Ops' },
      ...overrides,
    };
  }

  function givenFleet(nodes = [nodeRow()], grouped: unknown[] = []) {
    (context.prismaMock.workerNode.findMany as jest.Mock).mockResolvedValue(nodes);
    (context.prismaMock.workerNode.findUnique as jest.Mock).mockResolvedValue(nodes[0] ?? null);
    (context.prismaMock.job.groupBy as jest.Mock).mockResolvedValue(grouped);
  }

  // ===========================================================================
  // THE ROUTE ORDER
  // ===========================================================================

  describe('literal routes resolve before :id', () => {
    it('GET /admin/nodes/credentials is the credentials list, not a node lookup', async () => {
      const admin = await createMockAdminUser(context);
      (context.prismaMock.nodeCredential.findMany as jest.Mock).mockResolvedValue([
        credentialRow(),
      ]);
      // If `:id` had won, `ParseUUIDPipe` would 400 on the literal
      // "credentials" long before any query ran.
      (context.prismaMock.workerNode.findUnique as jest.Mock).mockResolvedValue(nodeRow());

      const response = await request(server())
        .get('/api/admin/nodes/credentials')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].tokenPrefix).toBe('nod_1a2b');
      expect(context.prismaMock.nodeCredential.findMany).toHaveBeenCalledTimes(1);
      expect(context.prismaMock.workerNode.findUnique).not.toHaveBeenCalled();
    });

    it('DELETE /admin/nodes/credentials/:id revokes a credential, not a node', async () => {
      const admin = await createMockAdminUser(context);
      (context.prismaMock.nodeCredential.findFirst as jest.Mock).mockResolvedValue(
        credentialRow(),
      );
      (context.prismaMock.nodeCredential.update as jest.Mock).mockResolvedValue(credentialRow());

      await request(server())
        .delete(`/api/admin/nodes/credentials/${CREDENTIAL_ID}`)
        .set(authHeader(admin.accessToken))
        .expect(204);

      expect(context.prismaMock.nodeCredential.update).toHaveBeenCalledTimes(1);
      expect(context.prismaMock.workerNode.delete).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // RBAC
  // ===========================================================================

  describe('authentication and permissions', () => {
    const routes: Array<[string, 'get' | 'delete', string]> = [
      ['GET /admin/nodes', 'get', '/api/admin/nodes'],
      ['GET /admin/nodes/credentials', 'get', '/api/admin/nodes/credentials'],
      ['GET /admin/nodes/:id', 'get', `/api/admin/nodes/${NODE_ID}`],
      ['DELETE /admin/nodes/:id', 'delete', `/api/admin/nodes/${NODE_ID}`],
      [
        'DELETE /admin/nodes/credentials/:id',
        'delete',
        `/api/admin/nodes/credentials/${CREDENTIAL_ID}`,
      ],
    ];

    it.each(routes)('401 on %s when unauthenticated', async (_label, method, path) => {
      await request(server())[method](path).expect(401);
    });

    it.each(routes)('403 on %s for a viewer', async (_label, method, path) => {
      const viewer = await createMockViewerUser(context);

      await request(server())[method](path).set(authHeader(viewer.accessToken)).expect(403);
    });

    it.each(routes)('403 on %s for a contributor', async (_label, method, path) => {
      // A contributor may own nodes of their own on `/api/nodes`; this plane
      // reads every operator's email and deletes other people's rows.
      const contributor = await createMockContributorUser(context);

      await request(server())[method](path).set(authHeader(contributor.accessToken)).expect(403);
    });
  });

  // ===========================================================================
  // The fleet read
  // ===========================================================================

  describe('GET /admin/nodes', () => {
    it('returns every node with its owner, derived health and job counts', async () => {
      const admin = await createMockAdminUser(context);
      givenFleet(
        [nodeRow(), nodeRow({ id: 'other', name: 'cold', lastHeartbeatAt: null })],
        [{ claimedByNodeId: NODE_ID, status: 'running', _count: { _all: 3 } }]
      );

      const response = await request(server())
        .get('/api/admin/nodes')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data).toHaveLength(2);
      expect(response.body.data[0]).toMatchObject({
        id: NODE_ID,
        status: 'online',
        health: 'healthy',
        owner: { email: 'ops@example.test' },
        jobCounts: { running: 3, pending: 0, succeeded: 0, failed: 0, total: 3 },
      });
      // Never heartbeated: stale, not healthy.
      expect(response.body.data[1].health).toBe('stale');
      // ONE grouped query for the whole fleet, through the real stack.
      expect(context.prismaMock.job.groupBy).toHaveBeenCalledTimes(1);
    });

    it('400s on a non-UUID node id rather than treating it as a name', async () => {
      const admin = await createMockAdminUser(context);

      await request(server())
        .get('/api/admin/nodes/not-a-uuid')
        .set(authHeader(admin.accessToken))
        .expect(400);
    });

    it('404s for a node that does not exist', async () => {
      const admin = await createMockAdminUser(context);
      givenFleet([]);
      (context.prismaMock.workerNode.findUnique as jest.Mock).mockResolvedValue(null);

      await request(server())
        .get(`/api/admin/nodes/${NODE_ID}`)
        .set(authHeader(admin.accessToken))
        .expect(404);
    });
  });

  describe('DELETE /admin/nodes/:id', () => {
    it('deletes the node and returns 204, leaving its jobs to the reaper', async () => {
      const admin = await createMockAdminUser(context);
      givenFleet();
      (context.prismaMock.workerNode.delete as jest.Mock).mockResolvedValue(nodeRow());

      await request(server())
        .delete(`/api/admin/nodes/${NODE_ID}`)
        .set(authHeader(admin.accessToken))
        .expect(204);

      expect(context.prismaMock.workerNode.delete).toHaveBeenCalledWith({
        where: { id: NODE_ID },
      });
      // No job is deleted and none is rewritten here: `onDelete: SetNull`
      // clears the claim pointer and the lease reaper does the rest.
      expect(context.prismaMock.job.deleteMany).not.toHaveBeenCalled();
      expect(context.prismaMock.job.updateMany).not.toHaveBeenCalled();
    });
  });
});
