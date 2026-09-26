import request from 'supertest';

import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';

// =============================================================================
// The resolution routes over the wire (#364)
// =============================================================================
//
// Through the real `AppModule` — guards, Zod pipes, `GraphAccessService` —
// with `PrismaService` mocked. The SQL of a merge is covered against real
// Postgres in `kg-resolution.db.spec.ts`; this file pins the RBAC and
// validation envelope: 401, 403 without `graph:write`, the byte-identical 404
// for someone else's entity, and the 400s.
// =============================================================================

const P = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const O = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MISSING = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

type Row = Record<string, any>;

function stripPermission(userId: string, permission: string): void {
  const original = prismaMock.user.findUnique.getMockImplementation();
  prismaMock.user.findUnique.mockImplementation(async (args: never) => {
    const user = (await original?.(args)) as Row | null;
    if (!user || user.id !== userId || !user.userRoles) return user as never;
    return {
      ...user,
      userRoles: user.userRoles.map((ur: Row) => ({
        ...ur,
        role: { ...ur.role, rolePermissions: ur.role.rolePermissions.filter((rp: Row) => rp.permission.name !== permission) },
      })),
    } as never;
  });
}

describe('graph resolution routes (integration)', () => {
  let context: TestContext;
  let entities: Row[];

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  }, 120_000); // booting AppModule is slow on a loaded runner

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    entities = [];
    prismaMock.kgEntity.findUnique.mockImplementation(async ({ where }: { where: Row }) => entities.find((e) => e.id === where.id) ?? null);
  });

  function seed(ownerId: string) {
    const base = { ownerId, props: {}, reviewStatus: 'accepted', mergedIntoId: null, occurredAt: null, ontologyVersion: '1', createdAt: new Date(), updatedAt: new Date() };
    entities = [
      { ...base, id: P, type: 'Person', label: 'Acme' },
      { ...base, id: O, type: 'Organization', label: 'Acme' },
    ];
  }

  const server = () => context.app.getHttpServer();

  it('answers 401 without a token', async () => {
    await request(server()).post(`/api/graph/entities/${P}/merge`).send({ intoId: O }).expect(401);
    await request(server()).post('/api/graph/distinct-pairs').send({ aId: P, bId: O }).expect(401);
    await request(server()).post(`/api/graph/merges/${P}/reverse`).send({}).expect(401);
  });

  it('answers 403 to the owner without graph:write', async () => {
    const owner = await createMockTestUser(context, { roleName: 'viewer' });
    seed(owner.id);
    stripPermission(owner.id, 'graph:write');
    await request(server()).post(`/api/graph/entities/${P}/merge`).set(authHeader(owner.accessToken)).send({ intoId: O }).expect(403);
    await request(server()).post('/api/graph/distinct-pairs').set(authHeader(owner.accessToken)).send({ aId: P, bId: O }).expect(403);
  });

  it("answers another user's entity with the same 404 a missing one gets", async () => {
    const owner = await createMockTestUser(context, { roleName: 'viewer' });
    const stranger = await createMockTestUser(context, { roleName: 'admin' });
    seed(owner.id);
    const theirs = await request(server())
      .post(`/api/graph/entities/${P}/merge`)
      .set(authHeader(stranger.accessToken))
      .send({ intoId: O })
      .expect(404);
    const missing = await request(server())
      .post(`/api/graph/entities/${MISSING}/merge`)
      .set(authHeader(stranger.accessToken))
      .send({ intoId: O })
      .expect(404);
    expect(theirs.body.message).toBe('Entity not found');
    expect(missing.body.message).toBe(theirs.body.message);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('answers a merge across types with 400 type_mismatch', async () => {
    const owner = await createMockTestUser(context, { roleName: 'viewer' });
    seed(owner.id);
    prismaMock.$queryRaw.mockResolvedValueOnce(
      entities.map((e) => ({ id: e.id, type: e.type, label: e.label, props: {}, review_status: 'accepted', merged_into_id: null })) as never,
    );
    const res = await request(server())
      .post(`/api/graph/entities/${P}/merge`)
      .set(authHeader(owner.accessToken))
      .send({ intoId: O })
      .expect(400);
    expect(res.body.details).toMatchObject({ reason: 'type_mismatch' });
  });

  it.each([
    ['the same id twice', `/api/graph/entities/${P}/merge`, { intoId: P }],
    ['an unknown key', `/api/graph/entities/${P}/merge`, { intoId: O, force: true }],
    ['a non-uuid', `/api/graph/entities/${P}/merge`, { intoId: 'nope' }],
    ['a distinct pair of one entity', '/api/graph/distinct-pairs', { aId: P, bId: P }],
    ['a non-empty reverse body', `/api/graph/merges/${P}/reverse`, { why: 'x' }],
  ])('answers %s with 400', async (_name, url, body) => {
    const owner = await createMockTestUser(context, { roleName: 'viewer' });
    seed(owner.id);
    await request(server()).post(url).set(authHeader(owner.accessToken)).send(body).expect(400);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('answers a missing merge with 404', async () => {
    const owner = await createMockTestUser(context, { roleName: 'viewer' });
    prismaMock.kgMerge.findUnique.mockResolvedValue(null);
    const res = await request(server()).post(`/api/graph/merges/${MISSING}/reverse`).set(authHeader(owner.accessToken)).send({}).expect(404);
    expect(res.body.message).toBe('Merge not found');
  });
});
