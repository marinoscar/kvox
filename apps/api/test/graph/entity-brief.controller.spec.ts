import request from 'supertest';

import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import { AiProviderRegistry } from '../../src/ai/ai-provider.registry';
import { entityBriefResponseSchema } from '../../src/graph/brief/dto/entity-brief.dto';

// =============================================================================
// GET /api/graph/entities/:id/brief over the wire (#372, epic #347)
// =============================================================================
//
// The REAL `AppModule` — guards, Zod pipe, envelope — with only
// `PrismaService` mocked. The SQL is proven on Postgres in
// `entity-brief.db.spec.ts`; this file pins the HTTP contract: 401/403, the
// byte-identical 404, query validation, and that a legacy
// `?compose=true&model=x` is stripped and never reaches an AI provider.
// =============================================================================

const ENTITY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const URL = `/api/graph/entities/${ENTITY}/brief`;

function stripPermission(userId: string, permission: string): void {
  const original = prismaMock.user.findUnique.getMockImplementation();
  prismaMock.user.findUnique.mockImplementation(async (args: never) => {
    const user = (await original?.(args)) as
      | { id: string; userRoles?: Array<{ role: { rolePermissions: Array<{ permission: { name: string } }> } }> }
      | null;
    if (!user || user.id !== userId || !user.userRoles) return user as never;
    return {
      ...user,
      userRoles: user.userRoles.map((userRole) => ({
        ...userRole,
        role: {
          ...userRole.role,
          rolePermissions: userRole.role.rolePermissions.filter((rp) => rp.permission.name !== permission),
        },
      })),
    } as never;
  });
}

describe('GET /api/graph/entities/:id/brief (integration)', () => {
  let context: TestContext;
  let providerSpies: jest.SpyInstance[] = [];

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    prismaMock.kgAttributeDef.findMany.mockResolvedValue([] as never);
    prismaMock.$queryRaw.mockResolvedValue([] as never);
    prismaMock.kgEntity.findUnique.mockResolvedValue(null as never);
    prismaMock.kgEntityDigest.findFirst.mockResolvedValue(null as never);
    prismaMock.kgEntityView.findUnique.mockResolvedValue(null as never);
    prismaMock.job.findFirst.mockResolvedValue(null as never);

    // Every method of every registered AI provider throws if touched.
    providerSpies.forEach((s) => s.mockRestore());
    providerSpies = [];
    const registry = context.app.get(AiProviderRegistry);
    for (const provider of registry.all()) {
      for (const method of ['generate', 'generateStructured', 'chat', 'embed', 'listModels', 'testCredential'] as const) {
        if (typeof (provider as unknown as Record<string, unknown>)[method] === 'function') {
          providerSpies.push(
            jest.spyOn(provider as never, method as never).mockImplementation((() => {
              throw new Error(`AI provider ${method} called by the brief`);
            }) as never),
          );
        }
      }
    }
  });

  afterEach(() => {
    providerSpies.forEach((s) => s.mockRestore());
    providerSpies = [];
  });

  const get = (url: string, token?: string) => {
    const req = request(context.app.getHttpServer()).get(url);
    return token ? req.set(authHeader(token)) : req;
  };

  it('is 401 without a session', async () => {
    await get(URL).expect(401);
  });

  it('is 403 without graph:read, before any row is read', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    stripPermission(user.id, 'graph:read');
    await get(URL, user.accessToken).expect(403);
    expect(prismaMock.kgEntity.findUnique).not.toHaveBeenCalled();
  });

  it('answers a missing and a foreign entity with the same 404 body', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    const missing = await get(URL, user.accessToken).expect(404);
    prismaMock.kgEntity.findUnique.mockResolvedValue({
      id: ENTITY,
      ownerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      type: 'Organization',
      label: 'Somebody else’s',
      reviewStatus: 'accepted',
      mergedIntoId: null,
    } as never);
    const foreign = await get(URL, user.accessToken).expect(404);
    const { timestamp: _a, ...missingBody } = missing.body;
    const { timestamp: _b, ...foreignBody } = foreign.body;
    expect(foreignBody).toEqual(missingBody);
    expect(prismaMock.kgEntityView.upsert).not.toHaveBeenCalled();
  });

  it.each([
    [`${URL}?since=yesterday`],
    [`${URL}?as_of=2024-13-01`],
    [`${URL}?as_of=2024-01-15T10:00:00`],
    [`${URL}?markViewed=maybe`],
    ['/api/graph/entities/not-a-uuid/brief'],
  ])('rejects %s with 400', async (url) => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    await get(url, user.accessToken).expect(400);
    expect(prismaMock.kgEntity.findUnique).not.toHaveBeenCalled();
  });

  it('answers 200 for the owner, strips a legacy compose/model, and never touches an AI provider', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    prismaMock.kgEntity.findUnique.mockResolvedValue({
      id: ENTITY,
      ownerId: user.id,
      type: 'Organization',
      label: 'Acme',
      reviewStatus: 'accepted',
      mergedIntoId: null,
    } as never);

    const res = await get(`${URL}?compose=true&model=x`, user.accessToken).expect(200);
    const parsed = entityBriefResponseSchema.safeParse(res.body.data);
    expect(parsed.success).toBe(true);
    expect(res.body.data).toMatchObject({
      entity: { id: ENTITY, label: 'Acme', type: 'Organization' },
      window: { sinceSource: 'default', lastViewedAt: null },
      digest: null,
      digestPending: false,
    });
    for (const spy of providerSpies) expect(spy).not.toHaveBeenCalled();
    // The view is recorded for this visit.
    expect(prismaMock.kgEntityView.upsert).toHaveBeenCalledTimes(1);
  });

  it('does not record a view with as_of', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    prismaMock.kgEntity.findUnique.mockResolvedValue({
      id: ENTITY,
      ownerId: user.id,
      type: 'Person',
      label: 'Sarah',
      reviewStatus: 'accepted',
      mergedIntoId: null,
    } as never);
    const res = await get(`${URL}?as_of=2024-01-15`, user.accessToken).expect(200);
    expect(res.body.data.window.asOf).toBe('2024-01-15T00:00:00.000Z');
    expect(prismaMock.kgEntityView.upsert).not.toHaveBeenCalled();
  });
});
