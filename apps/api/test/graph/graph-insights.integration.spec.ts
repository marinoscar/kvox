import request from 'supertest';

import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import { graphInsightsResponseSchema } from '@marinoscar/kvox-contract/graph';

// =============================================================================
// /api/graph/insights over the wire (GIC-16, #677, epic #661)
// =============================================================================
//
// The REAL `AppModule` — guards, the response envelope, query validation — with
// `PrismaService` mocked. The SQL (rising and fading thresholds, risks, the
// sensitive exclusion, stale) is `graph-insights.db.spec.ts`'s; this file pins the
// route's contract: `graph:read`, the `window` query, the DTO shape.
// =============================================================================

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

describe('/api/graph/insights (integration)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    prismaMock.kgGraphLayout.findFirst.mockResolvedValue(null as never);
    prismaMock.job.findFirst.mockResolvedValue(null as never);
    prismaMock.$transaction.mockImplementation(async (arg: never) =>
      typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(prismaMock) : Promise.all(arg as never),
    );
    prismaMock.$queryRaw.mockResolvedValue([] as never);
    prismaMock.$executeRaw.mockResolvedValue(0 as never);
    prismaMock.kgAttributeDef.findMany.mockResolvedValue([] as never);
  });

  it('GET answers 200 with the DTO shape and empty lists for a caller with no snapshot', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    const res = await request(context.app.getHttpServer())
      .get('/api/graph/insights')
      .set(authHeader(user.accessToken))
      .expect(200);
    expect(graphInsightsResponseSchema.safeParse(res.body.data).success).toBe(true);
    expect(res.body.data).toMatchObject({
      status: 'none',
      window: { key: '30d', days: 30 },
      themes: [],
      connectors: [],
      rising: [],
      fadingTies: [],
    });
  });

  it('GET takes window=90d and refuses an unknown window with 400', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    const server = context.app.getHttpServer();
    const ok = await request(server).get('/api/graph/insights?window=90d').set(authHeader(user.accessToken)).expect(200);
    expect(ok.body.data.window).toMatchObject({ key: '90d', days: 90 });
    await request(server).get('/api/graph/insights?window=7d').set(authHeader(user.accessToken)).expect(400);
  });

  it('GET requires graph:read', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    stripPermission(user.id, 'graph:read');
    await request(context.app.getHttpServer()).get('/api/graph/insights').set(authHeader(user.accessToken)).expect(403);
  });
});
