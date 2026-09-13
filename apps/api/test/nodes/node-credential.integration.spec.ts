// =============================================================================
// `/api/node-credentials` and the `nod_` privilege boundary (#267, epic #254)
// =============================================================================
//
// Two things are proven here, and only one of them is about the endpoints.
//
// The endpoints themselves (create / list / revoke) are ordinary, and the
// cases below check the ordinary things: the raw token comes back exactly
// once, it never appears in a listing, the RBAC gates are the ones the
// controller documents.
//
// THE OTHER THING IS THE POINT OF THE ISSUE. A `nod_` credential resolves,
// through `JwtAuthGuard`, to its owning user's real `AuthenticatedUser` —
// roles, permissions and all. Since `nodes:write` is granted to Admin only
// (`prisma/seed-data.ts`), THE OWNER OF A NODE CREDENTIAL IS AN ADMIN. The
// route allowlist in the guard is therefore the entire difference between "a
// leaked worker token can pretend to be a worker" and "a leaked worker token
// owns the deployment", and it is asserted here THROUGH THE REAL HTTP STACK —
// real guards, real global prefix, real router — because the unit tests in
// `src/auth/guards/jwt-auth.guard.spec.ts` can only see the guard's own view
// of a request it was handed, not the URL Fastify actually produces.
//
// Every 403 case below deliberately uses an ADMIN owner. A boundary that only
// holds for low-privilege owners is not a boundary.
// =============================================================================

import request from 'supertest';
import { randomUUID, createHash } from 'crypto';
import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { Reflector } from '@nestjs/core';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtAuthGuard } from '../../src/auth/guards/jwt-auth.guard';
import { NodeCredentialService } from '../../src/nodes/node-credential.service';
import { PatService } from '../../src/pat/pat.service';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  createMockAdminUser,
  createMockViewerUser,
  authHeader,
} from '../helpers/auth-mock.helper';

describe('Node credentials (Integration)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    resetPrismaMock();
    setupBaseMocks();
  });

  const NODE_TOKEN = 'nod_integration_fixture_token';

  /** A node id for the routes #268 mounted under the allowlisted prefix. */
  const NODE_ID = '11111111-1111-4111-8111-111111111111';

  /**
   * Registers a live node credential owned by `userId`, keyed by the same
   * sha256 digest `NodeCredentialService.validateToken` computes — so the
   * guard resolves it exactly as it would in production.
   *
   * Returns the `update` mock, which is what stamps `lastUsedAt`, so the
   * ordering assertions below can prove it was never reached.
   */
  async function givenLiveNodeCredentialFor(
    userId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<jest.Mock> {
    const fullUser = await (context.prismaMock.user.findUnique as jest.Mock)({
      where: { id: userId },
    });

    (context.prismaMock.nodeCredential.findUnique as jest.Mock).mockImplementation(
      async ({ where }: { where: { tokenHash: string } }) => {
        const expected = createHash('sha256').update(NODE_TOKEN).digest('hex');
        if (where.tokenHash !== expected) return null;
        return {
          id: randomUUID(),
          userId,
          name: 'integration fixture',
          tokenHash: expected,
          tokenPrefix: NODE_TOKEN.slice(0, 8),
          expiresAt: null,
          lastUsedAt: null,
          createdAt: new Date(),
          revokedAt: null,
          user: fullUser,
          ...overrides,
        };
      },
    );

    const update = context.prismaMock.nodeCredential.update as jest.Mock;
    update.mockResolvedValue({});
    return update;
  }

  const nodeHeader = () => ({ Authorization: `Bearer ${NODE_TOKEN}` });

  // ---------------------------------------------------------------------------
  // Driving the guard directly, for the paths that still have no handler
  // ---------------------------------------------------------------------------
  //
  // ⚠ THIS BLOCK USED TO CARRY THE ALLOWED SIDE OF THE BOUNDARY TOO, AND #268
  // TOOK THAT HALF BACK. `JwtAuthGuard` is a ROUTE-LEVEL guard: Nest runs it
  // only after the router has matched a handler, so while `/api/nodes` had no
  // controller, an HTTP request there 404'd before the guard was ever
  // consulted — an assertion on it would have measured the router, not the
  // allowlist. #268 mounts `NodesController`, so the admitted cases are now
  // ordinary supertest requests in the block below this one, through the real
  // router, the real guard and the real service.
  //
  // What is left here is the half that CANNOT be an HTTP request, and never
  // will be: paths that begin with the literal characters `/api/nodes` and
  // must still be refused (`/api/nodesX`, `/api/nodes-other`,
  // `/api/nodescrape`, `/api/node-credentials`), plus `/api/nodes/` with its
  // trailing slash. None of them routes anywhere, so all of them 404 in the
  // router whatever the guard would have decided — which is exactly why the
  // guard has to be asked directly. A naive `startsWith('/api/nodes')` admits
  // every one of them, and the day somebody adds a route under one of those
  // names, the 404 that currently hides the question disappears.
  function guardHarness() {
    const guard = new JwtAuthGuard(
      context.module.get(Reflector, { strict: false }),
      context.module.get(PatService, { strict: false }),
      context.module.get(NodeCredentialService, { strict: false }),
    );

    const contextFor = (url: string): ExecutionContext =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({
            url,
            headers: { authorization: `Bearer ${NODE_TOKEN}` },
          }),
          getResponse: () => ({}),
        }),
        getHandler: () => function handler() {},
        getClass: () => class Controller {},
      }) as unknown as ExecutionContext;

    return { guard, contextFor };
  }

  // ===========================================================================
  // THE PRIVILEGE BOUNDARY
  // ===========================================================================

  describe('a nod_ token is confined to /api/nodes', () => {
    // Each of these is a route that EXISTS and that the credential's ADMIN
    // owner is fully entitled to call with a session or a PAT. The only
    // reason they are refused is the token family.
    it.each([
      ['/api/users'],
      ['/api/admin/jobs'],
      ['/api/node-credentials'],
      ['/api/auth/me'],
    ])('returns 403 on %s even though the owner is an admin', async (path) => {
      const admin = await createMockAdminUser(context);
      await givenLiveNodeCredentialFor(admin.id);

      await request(context.app.getHttpServer())
        .get(path)
        .set(nodeHeader())
        .expect(403);
    });

    it('returns 403 on /api/node-credentials POST — a node cannot mint another credential', async () => {
      // The self-management case, stated on its own because it is the one
      // that makes revocation a real control: a worker token that could reach
      // this endpoint could regrow after being revoked.
      const admin = await createMockAdminUser(context);
      await givenLiveNodeCredentialFor(admin.id);

      await request(context.app.getHttpServer())
        .post('/api/node-credentials')
        .set(nodeHeader())
        .send({ name: 'self-minted' })
        .expect(403);

      expect(context.prismaMock.nodeCredential.create).not.toHaveBeenCalled();
    });

    it('does NOT look the credential up on a refused route, and does not stamp lastUsedAt', async () => {
      // THE ORDERING ASSERTION, through the real stack. Both orderings return
      // 403; only the spy can tell them apart. A `validateToken` reached here
      // would stamp `lastUsedAt`, handing an attacker a liveness oracle in the
      // operator's own listing and corrupting the operator's "is this node
      // alive?" signal with probe traffic.
      const admin = await createMockAdminUser(context);
      const update = await givenLiveNodeCredentialFor(admin.id);

      await request(context.app.getHttpServer())
        .get('/api/users')
        .set(nodeHeader())
        .expect(403);

      expect(context.prismaMock.nodeCredential.findUnique).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });

    it('a JWT session is unaffected: the same admin reaches /api/users normally', async () => {
      // Regression coverage for the boundary itself — #267 must not have
      // narrowed anything for session callers.
      const admin = await createMockAdminUser(context);
      (context.prismaMock.user.findMany as jest.Mock).mockResolvedValue([]);
      (context.prismaMock.user.count as jest.Mock).mockResolvedValue(0);

      await request(context.app.getHttpServer())
        .get('/api/users')
        .set(authHeader(admin.accessToken))
        .expect(200);
    });

    it('a pat_ token is unaffected: it still reaches /api/users', async () => {
      // The other half of the regression: the PAT's documented universality
      // (`test/auth/pat-universality.integration.spec.ts`) must survive the
      // addition of a second, narrower opaque family.
      const admin = await createMockAdminUser(context);
      const fullUser = await (context.prismaMock.user.findUnique as jest.Mock)({
        where: { id: admin.id },
      });
      const RAW_PAT = 'pat_still_works_after_267';

      (context.prismaMock.personalAccessToken.findUnique as jest.Mock).mockResolvedValue({
        id: randomUUID(),
        userId: admin.id,
        name: 'regression',
        tokenHash: createHash('sha256').update(RAW_PAT).digest('hex'),
        tokenPrefix: 'pat_stil',
        expiresAt: new Date(Date.now() + 86_400_000),
        lastUsedAt: null,
        revokedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        user: fullUser,
      });
      (context.prismaMock.personalAccessToken.update as jest.Mock).mockResolvedValue({});
      (context.prismaMock.user.findMany as jest.Mock).mockResolvedValue([]);
      (context.prismaMock.user.count as jest.Mock).mockResolvedValue(0);

      await request(context.app.getHttpServer())
        .get('/api/users')
        .set('Authorization', `Bearer ${RAW_PAT}`)
        .expect(200);
    });
  });

  // ===========================================================================
  // The ALLOWED side of the allowlist, and the four ways validation fails
  // ===========================================================================

  describe('the ADMITTED side, over real HTTP now that #268 mounts /api/nodes', () => {
    // These are the cases #267 could only assert against the guard directly,
    // because the router 404'd first. They are the whole point of the
    // allowlist: a `nod_` credential must be able to do the node conversation
    // and nothing else, and "can do the node conversation" is only provable
    // once there is a node conversation to do.

    /** A node row owned by `ownerId`, enough for the two routes used below. */
    const nodeRowFor = (ownerId: string) => ({
      id: NODE_ID,
      name: 'prod-worker-1',
      hostname: 'box-a',
      platform: 'linux-x64',
      cliVersion: '1.0.0',
      eligibleTypes: [],
      concurrency: 1,
      status: 'online',
      capabilities: null,
      registeredAt: new Date(),
      lastHeartbeatAt: null,
      createdById: ownerId,
    });

    it('admits GET /api/nodes — and resolves the credential to do it', async () => {
      const admin = await createMockAdminUser(context);
      const update = await givenLiveNodeCredentialFor(admin.id);
      (context.prismaMock.workerNode.findMany as jest.Mock).mockResolvedValue([]);

      await request(context.app.getHttpServer())
        .get('/api/nodes')
        .set(nodeHeader())
        .expect(200);

      // It got there by actually resolving the credential, not by skipping —
      // and `lastUsedAt` is stamped, which is the operator's "is this node
      // alive" signal working as designed on an ALLOWED route.
      expect(context.prismaMock.nodeCredential.findUnique).toHaveBeenCalled();
      expect(update).toHaveBeenCalled();
    });

    it('admits GET /api/nodes?x=1 — the query string is not part of the path', async () => {
      const admin = await createMockAdminUser(context);
      await givenLiveNodeCredentialFor(admin.id);
      (context.prismaMock.workerNode.findMany as jest.Mock).mockResolvedValue([]);

      await request(context.app.getHttpServer())
        .get('/api/nodes?x=1')
        .set(nodeHeader())
        .expect(200);
    });

    it('admits POST /api/nodes/:id/heartbeat — the routine call of a node’s life', async () => {
      const admin = await createMockAdminUser(context);
      await givenLiveNodeCredentialFor(admin.id);
      (context.prismaMock.workerNode.findUnique as jest.Mock).mockResolvedValue(
        nodeRowFor(admin.id),
      );
      (context.prismaMock.workerNode.update as jest.Mock).mockResolvedValue(
        nodeRowFor(admin.id),
      );

      await request(context.app.getHttpServer())
        .post(`/api/nodes/${NODE_ID}/heartbeat`)
        .set(nodeHeader())
        .send({ status: 'online' })
        .expect(200);
    });

    it('admits POST /api/nodes/register — how a worker attaches in the first place', async () => {
      const admin = await createMockAdminUser(context);
      await givenLiveNodeCredentialFor(admin.id);
      (context.prismaMock.workerNode.findUnique as jest.Mock).mockResolvedValue(null);
      (context.prismaMock.workerNode.create as jest.Mock).mockImplementation(
        async ({ data }: any) => ({ ...nodeRowFor(admin.id), ...data }),
      );

      const response = await request(context.app.getHttpServer())
        .post('/api/nodes/register')
        .set(nodeHeader())
        .send({
          name: 'prod-worker-1',
          hostname: 'box-a',
          platform: 'linux-x64',
          cliVersion: '1.0.0',
          eligibleTypes: [],
          concurrency: 1,
        })
        .expect(200);

      expect(response.body.data.reattached).toBe(false);
    });
  });

  describe('the prefix boundary, which still has no router to ask', () => {
    it('admits /api/nodes/ (trailing slash) at the guard, though nothing routes there', async () => {
      const admin = await createMockAdminUser(context);
      await givenLiveNodeCredentialFor(admin.id);
      const { guard, contextFor } = guardHarness();

      await expect(guard.canActivate(contextFor('/api/nodes/'))).resolves.toBe(true);
      expect(context.prismaMock.nodeCredential.findUnique).toHaveBeenCalled();
    });

    // These three begin with the literal characters `/api/nodes` and must
    // still be refused: a naive `startsWith('/api/nodes')` admits every one.
    it.each([
      ['/api/nodesX'],
      ['/api/nodes-other'],
      ['/api/nodescrape'],
      ['/api/node-credentials'],
    ])('refuses %s, without a lookup', async (url) => {
      const admin = await createMockAdminUser(context);
      const update = await givenLiveNodeCredentialFor(admin.id);
      const { guard, contextFor } = guardHarness();

      await expect(guard.canActivate(contextFor(url))).rejects.toThrow(ForbiddenException);

      // The ordering assertion again, this time with the real service behind
      // the guard: a refused route must cost no query and stamp no
      // `lastUsedAt`.
      expect(context.prismaMock.nodeCredential.findUnique).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });
  });

  describe('rejected credentials on an allowlisted route', () => {
    const ALLOWED = '/api/nodes';

    it('401 for an unknown token', async () => {
      (context.prismaMock.nodeCredential.findUnique as jest.Mock).mockResolvedValue(null);
      const { guard, contextFor } = guardHarness();

      await expect(guard.canActivate(contextFor(ALLOWED))).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('401 for a REVOKED credential', async () => {
      const admin = await createMockAdminUser(context);
      await givenLiveNodeCredentialFor(admin.id, { revokedAt: new Date() });
      const { guard, contextFor } = guardHarness();

      await expect(guard.canActivate(contextFor(ALLOWED))).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('401 for an EXPIRED credential', async () => {
      const admin = await createMockAdminUser(context);
      await givenLiveNodeCredentialFor(admin.id, {
        expiresAt: new Date(Date.now() - 60_000),
      });
      const { guard, contextFor } = guardHarness();

      await expect(guard.canActivate(contextFor(ALLOWED))).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('401 when the OWNING USER is inactive', async () => {
      const admin = await createMockAdminUser(context);
      const fullUser = await (context.prismaMock.user.findUnique as jest.Mock)({
        where: { id: admin.id },
      });
      await givenLiveNodeCredentialFor(admin.id, {
        user: { ...fullUser, isActive: false },
      });
      const { guard, contextFor } = guardHarness();

      await expect(guard.canActivate(contextFor(ALLOWED))).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('a credential with expiresAt: null authenticates indefinitely', async () => {
      // The divergence from `PersonalAccessToken`, end to end. `null` means
      // "never expires", NOT "expired at the epoch" — inverting that would
      // take an entire fleet offline while every row still looked healthy.
      const admin = await createMockAdminUser(context);
      const update = await givenLiveNodeCredentialFor(admin.id, {
        expiresAt: null,
        createdAt: new Date('2020-01-01T00:00:00.000Z'),
      });
      const { guard, contextFor } = guardHarness();

      await expect(guard.canActivate(contextFor(ALLOWED))).resolves.toBe(true);
      expect(update).toHaveBeenCalled();
    });

    it('the same credential stops working the moment it is REVOKED', async () => {
      // Revocation, not a clock, is the control for a node credential — and
      // it is re-read on every request, so it takes effect immediately with
      // no TTL to wait out.
      const admin = await createMockAdminUser(context);
      await givenLiveNodeCredentialFor(admin.id, { expiresAt: null });
      const { guard, contextFor } = guardHarness();

      await expect(guard.canActivate(contextFor(ALLOWED))).resolves.toBe(true);

      await givenLiveNodeCredentialFor(admin.id, {
        expiresAt: null,
        revokedAt: new Date(),
      });

      await expect(guard.canActivate(contextFor(ALLOWED))).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  // ===========================================================================
  // POST /api/node-credentials
  // ===========================================================================

  describe('POST /api/node-credentials', () => {
    function givenCreateEchoesInput(userId: string) {
      (context.prismaMock.nodeCredential.create as jest.Mock).mockImplementation(
        async ({ data }: any) => ({
          id: randomUUID(),
          userId,
          createdAt: new Date(),
          lastUsedAt: null,
          revokedAt: null,
          ...data,
        }),
      );
    }

    it('401 when unauthenticated', async () => {
      await request(context.app.getHttpServer())
        .post('/api/node-credentials')
        .send({ name: 'worker' })
        .expect(401);
    });

    it('403 for a viewer — creating is gated on nodes:write', async () => {
      const viewer = await createMockViewerUser(context);

      await request(context.app.getHttpServer())
        .post('/api/node-credentials')
        .set(authHeader(viewer.accessToken))
        .send({ name: 'worker' })
        .expect(403);
    });

    it('201, and returns the raw nod_ token exactly once', async () => {
      const admin = await createMockAdminUser(context);
      givenCreateEchoesInput(admin.id);

      const response = await request(context.app.getHttpServer())
        .post('/api/node-credentials')
        .set(authHeader(admin.accessToken))
        .send({ name: 'prod-worker-1' })
        .expect(201);

      expect(response.body.data.token).toMatch(/^nod_[0-9a-f]{64}$/);
      expect(response.body.data.name).toBe('prod-worker-1');
      expect(response.body.data.tokenPrefix).toBe(
        response.body.data.token.slice(0, 8),
      );
      // Omitted expiry is a real answer, serialized as an explicit null.
      expect(response.body.data.expiresAt).toBeNull();

      // The stored row carries the hash and never the plaintext.
      const written = (context.prismaMock.nodeCredential.create as jest.Mock).mock.calls[0][0].data;
      expect(written.tokenHash).toBe(
        createHash('sha256').update(response.body.data.token).digest('hex'),
      );
      expect(JSON.stringify(written)).not.toContain(response.body.data.token);
    });

    it('accepts an explicit expiresInDays', async () => {
      const admin = await createMockAdminUser(context);
      givenCreateEchoesInput(admin.id);

      const response = await request(context.app.getHttpServer())
        .post('/api/node-credentials')
        .set(authHeader(admin.accessToken))
        .send({ name: 'temporary', expiresInDays: 30 })
        .expect(201);

      expect(response.body.data.expiresAt).not.toBeNull();
    });

    it.each([
      ['name missing', {}],
      ['name empty', { name: '' }],
      ['name too long', { name: 'a'.repeat(101) }],
      ['expiresInDays zero', { name: 'x', expiresInDays: 0 }],
      ['expiresInDays fractional', { name: 'x', expiresInDays: 1.5 }],
      ['expiresInDays above max', { name: 'x', expiresInDays: 3651 }],
      ['expiresInDays a string', { name: 'x', expiresInDays: '30' }],
    ])('400 when %s', async (_label, body) => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .post('/api/node-credentials')
        .set(authHeader(admin.accessToken))
        .send(body)
        .expect(400);
    });
  });

  // ===========================================================================
  // GET /api/node-credentials
  // ===========================================================================

  describe('GET /api/node-credentials', () => {
    it('401 when unauthenticated', async () => {
      await request(context.app.getHttpServer())
        .get('/api/node-credentials')
        .expect(401);
    });

    it('403 for a viewer — the listing is gated on nodes:read', async () => {
      const viewer = await createMockViewerUser(context);

      await request(context.app.getHttpServer())
        .get('/api/node-credentials')
        .set(authHeader(viewer.accessToken))
        .expect(403);
    });

    it('never returns the raw token or the stored hash', async () => {
      const admin = await createMockAdminUser(context);
      const createdAt = new Date();

      (context.prismaMock.nodeCredential.findMany as jest.Mock).mockResolvedValue([
        {
          id: randomUUID(),
          name: 'prod-worker-1',
          tokenPrefix: 'nod_1a2b',
          expiresAt: null,
          lastUsedAt: null,
          createdAt,
          revokedAt: null,
        },
      ]);

      const response = await request(context.app.getHttpServer())
        .get('/api/node-credentials')
        .set(authHeader(admin.accessToken))
        .expect(200);

      const [item] = response.body.data;
      expect(item.tokenPrefix).toBe('nod_1a2b');
      expect(item).not.toHaveProperty('token');
      expect(item).not.toHaveProperty('tokenHash');
      // Belt and braces: nothing in the whole body looks like a full token.
      expect(JSON.stringify(response.body)).not.toMatch(/nod_[0-9a-f]{64}/);
      // `null` expiry survives serialization as an explicit value.
      expect(item.expiresAt).toBeNull();
    });

    it('does not leak the token minted moments earlier', async () => {
      // The show-once contract stated end to end: create, then list, then
      // look for the value that was shown.
      const admin = await createMockAdminUser(context);
      (context.prismaMock.nodeCredential.create as jest.Mock).mockImplementation(
        async ({ data }: any) => ({
          id: 'cred-1',
          userId: admin.id,
          createdAt: new Date(),
          lastUsedAt: null,
          revokedAt: null,
          ...data,
        }),
      );

      const created = await request(context.app.getHttpServer())
        .post('/api/node-credentials')
        .set(authHeader(admin.accessToken))
        .send({ name: 'prod-worker-1' })
        .expect(201);

      const rawToken: string = created.body.data.token;

      (context.prismaMock.nodeCredential.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'cred-1',
          name: 'prod-worker-1',
          tokenPrefix: rawToken.slice(0, 8),
          expiresAt: null,
          lastUsedAt: null,
          createdAt: new Date(),
          revokedAt: null,
        },
      ]);

      const listed = await request(context.app.getHttpServer())
        .get('/api/node-credentials')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(JSON.stringify(listed.body)).not.toContain(rawToken);
    });
  });

  // ===========================================================================
  // DELETE /api/node-credentials/:id
  // ===========================================================================

  describe('DELETE /api/node-credentials/:id', () => {
    const id = '11111111-1111-4111-8111-111111111111';

    it('401 when unauthenticated', async () => {
      await request(context.app.getHttpServer())
        .delete(`/api/node-credentials/${id}`)
        .expect(401);
    });

    it('403 for a viewer — revoking is gated on nodes:write', async () => {
      const viewer = await createMockViewerUser(context);

      await request(context.app.getHttpServer())
        .delete(`/api/node-credentials/${id}`)
        .set(authHeader(viewer.accessToken))
        .expect(403);
    });

    it('204 and stamps revokedAt', async () => {
      const admin = await createMockAdminUser(context);

      (context.prismaMock.nodeCredential.findFirst as jest.Mock).mockResolvedValue({
        id,
        userId: admin.id,
        name: 'prod-worker-1',
        revokedAt: null,
      });
      (context.prismaMock.nodeCredential.update as jest.Mock).mockResolvedValue({});

      await request(context.app.getHttpServer())
        .delete(`/api/node-credentials/${id}`)
        .set(authHeader(admin.accessToken))
        .expect(204);

      const args = (context.prismaMock.nodeCredential.update as jest.Mock).mock.calls[0][0];
      expect(args.data.revokedAt).toBeInstanceOf(Date);
    });

    it('404 for a credential that is not the caller’s', async () => {
      const admin = await createMockAdminUser(context);
      // Ownership is folded into the lookup, so "someone else's" comes back
      // as `null` — indistinguishable from "does not exist", on purpose.
      (context.prismaMock.nodeCredential.findFirst as jest.Mock).mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .delete(`/api/node-credentials/${id}`)
        .set(authHeader(admin.accessToken))
        .expect(404);
    });

    it('400 for a non-UUID id', async () => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .delete('/api/node-credentials/not-a-uuid')
        .set(authHeader(admin.accessToken))
        .expect(400);
    });
  });
});
