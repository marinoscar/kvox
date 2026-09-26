import request from 'supertest';
import { Prisma } from '@prisma/client';

import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import {
  graphOverviewRefreshResponseSchema,
  graphOverviewResponseSchema,
} from '../../src/graph/layout/dto/graph-overview.dto';

// =============================================================================
// /api/graph/overview over the wire (#371, epic #347)
// =============================================================================
//
// The REAL `AppModule` — guards, the response envelope, `JobsService.enqueue`
// and its dedup — with `PrismaService` replaced by a small in-memory `jobs`
// store. The snapshot/label logic is `graph-overview.db.spec.ts`'s; this file
// pins the routes' contract:
//
//   - GET: `graph:read`, 200 with the DTO shape (`status: 'none'` here);
//   - POST refresh: `graph:write` (403 without it), 202 `{ jobId, deduplicated }`,
//     `deduplicated: true` on a second call while the first is pending, and
//     the job is `kg.graph_layout` on subject `user`/caller with ordinary dedup.
// =============================================================================

type Row = Record<string, any>;

/** Same technique as `graph-forget.integration.spec.ts`. */
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

const active = (j: Row) => ['pending', 'running'].includes(j.status);

describe('/api/graph/overview (integration)', () => {
  let context: TestContext;
  let jobs: Row[];

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    jobs = [];

    prismaMock.kgGraphLayout.findFirst.mockResolvedValue(null as never);
    prismaMock.kgEntity.count.mockResolvedValue(0 as never);

    prismaMock.job.create.mockImplementation(async ({ data }: { data: Row }) => {
      if (jobs.some((j) => j.dedupKey && j.dedupKey === data.dedupKey && active(j))) {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target: ['dedup_key'] },
        });
      }
      const row = { ...data, id: `job-${jobs.length + 1}`, status: 'pending', createdAt: new Date() };
      jobs.push(row);
      return row;
    });
    // Both lookups: JobsService's re-read by dedup key, and the enqueuer's
    // "active layout job for this owner".
    prismaMock.job.findFirst.mockImplementation(async ({ where }: { where: Row }) => {
      if (where.dedupKey !== undefined) return jobs.find((j) => j.dedupKey === where.dedupKey && active(j)) ?? null;
      return (
        jobs.find(
          (j) => j.type === where.type && j.subjectType === where.subjectType && j.subjectId === where.subjectId && active(j),
        ) ?? null
      );
    });
    prismaMock.job.updateMany.mockResolvedValue({ count: 0 } as never);
  });

  it('GET answers 200 with status none for a caller with no snapshot and an empty graph', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });

    const res = await request(context.app.getHttpServer())
      .get('/api/graph/overview')
      .set(authHeader(user.accessToken))
      .expect(200);

    expect(graphOverviewResponseSchema.safeParse(res.body.data).success).toBe(true);
    expect(res.body.data).toMatchObject({ status: 'none', pending: false, nodes: [], clusters: [] });
    expect(jobs).toHaveLength(0);
  });

  it('GET requires graph:read', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    stripPermission(user.id, 'graph:read');
    await request(context.app.getHttpServer()).get('/api/graph/overview').set(authHeader(user.accessToken)).expect(403);
  });

  it('POST refresh queues kg.graph_layout: 202, then deduplicated: true while pending', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    const server = context.app.getHttpServer();

    const first = await request(server).post('/api/graph/overview/refresh').set(authHeader(user.accessToken)).expect(202);
    expect(graphOverviewRefreshResponseSchema.safeParse(first.body.data).success).toBe(true);
    expect(first.body.data).toEqual({ jobId: 'job-1', deduplicated: false });

    const second = await request(server).post('/api/graph/overview/refresh').set(authHeader(user.accessToken)).expect(202);
    expect(second.body.data).toEqual({ jobId: 'job-1', deduplicated: true });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      type: 'kg.graph_layout',
      reason: 'rerun',
      subjectType: 'user',
      subjectId: user.id,
      payload: { ownerId: user.id },
    });
    expect(jobs[0].dedupKey).toBeTruthy();
  });

  it('POST refresh requires graph:write', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    stripPermission(user.id, 'graph:write');
    await request(context.app.getHttpServer())
      .post('/api/graph/overview/refresh')
      .set(authHeader(user.accessToken))
      .expect(403);
    expect(jobs).toHaveLength(0);
  });
});
