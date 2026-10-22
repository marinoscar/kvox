import request from 'supertest';

import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import { GraphAiRunResolver } from '@marinoscar/kvox-api/graph';
import { topicsPromoteRequestResponseSchema, topicsPromoteStatusSchema } from '@marinoscar/kvox-contract/graph';
import { JobsService } from '@marinoscar/platform-api/jobs';

// =============================================================================
// /api/graph/topics/promote over the wire (#666, epic #661)
// =============================================================================
//
// The REAL `AppModule` — guards, envelope — with `PrismaService` mocked and the
// queue spied. Pins the HTTP contract and the enqueue: 401, 403 without
// graph:write (nothing queued), 409 graph_disabled, 202 with `kg.topics_promote`
// queued for the CALLER (subject `user`/their id, the explicit organization),
// and the status read.
// =============================================================================

const ORG_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const JOB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

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

describe('/api/graph/topics/promote (integration)', () => {
  let context: TestContext;
  let enqueue: jest.SpyInstance;
  let graphEnabled: jest.SpyInstance;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  }, 120_000);

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    enqueue?.mockRestore();
    graphEnabled?.mockRestore();
    // The port's adapter resolves the default organization and passes it on every enqueue.
    prismaMock.organization.findFirst.mockResolvedValue({ id: ORG_ID } as never);
    prismaMock.job.findFirst.mockResolvedValue(null as never);
    enqueue = jest.spyOn(context.app.get(JobsService), 'enqueue').mockResolvedValue({ id: JOB } as never);
    jest.spyOn(context.app.get(JobsService), 'recordProvider').mockResolvedValue(undefined as never);
    graphEnabled = jest.spyOn(context.app.get(GraphAiRunResolver), 'graphEnabled').mockResolvedValue(true);
  });

  const server = () => context.app.getHttpServer();

  it('is 401 without a session', async () => {
    await request(server()).post('/api/graph/topics/promote').expect(401);
    await request(server()).get('/api/graph/topics/promote').expect(401);
  });

  it('is 403 without graph:write, and queues nothing', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    stripPermission(user.id, 'graph:write');
    await request(server()).post('/api/graph/topics/promote').set(authHeader(user.accessToken)).expect(403);
    await request(server()).get('/api/graph/topics/promote').set(authHeader(user.accessToken)).expect(403);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('is 409 graph_disabled while connected knowledge is off, and queues nothing', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    graphEnabled.mockResolvedValue(false);
    const res = await request(server()).post('/api/graph/topics/promote').set(authHeader(user.accessToken)).expect(409);
    expect(res.body.details).toMatchObject({ reason: 'graph_disabled' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('queues kg.topics_promote for the caller with the explicit organization (202)', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    const res = await request(server()).post('/api/graph/topics/promote').set(authHeader(user.accessToken)).expect(202);

    expect(topicsPromoteRequestResponseSchema.parse(res.body.data)).toEqual({ jobId: JOB, deduplicated: false });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'kg.topics_promote',
        orgId: ORG_ID,
        subjectType: 'user',
        subjectId: user.id,
        payload: { userId: user.id },
      }),
    );
  });

  it('joins a run already in flight instead of queuing a second', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    prismaMock.job.findFirst.mockResolvedValue({ id: JOB } as never);
    const res = await request(server()).post('/api/graph/topics/promote').set(authHeader(user.accessToken)).expect(202);
    expect(topicsPromoteRequestResponseSchema.parse(res.body.data).deduplicated).toBe(true);
  });

  it('reports the latest run and the proposals waiting, for the caller only', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    prismaMock.job.findFirst.mockResolvedValue({
      id: JOB,
      type: 'kg.topics_promote',
      status: 'running',
      scheduledFor: null,
      createdAt: new Date('2026-10-01T00:00:00Z'),
      finishedAt: null,
    } as never);
    prismaMock.kgProposal.count.mockResolvedValue(7 as never);

    const res = await request(server()).get('/api/graph/topics/promote').set(authHeader(user.accessToken)).expect(200);

    expect(topicsPromoteStatusSchema.parse(res.body.data)).toEqual({
      job: { id: JOB, status: 'running', createdAt: '2026-10-01T00:00:00.000Z', finishedAt: null },
      proposedTopics: 7,
    });
    expect(prismaMock.job.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { type: 'kg.topics_promote', subjectType: 'user', subjectId: user.id } }),
    );
    expect(prismaMock.kgProposal.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ ownerId: user.id, kind: 'import', status: 'draft' }),
    });
  });

  it('answers null when the caller never ran it', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    prismaMock.kgProposal.count.mockResolvedValue(0 as never);
    const res = await request(server()).get('/api/graph/topics/promote').set(authHeader(user.accessToken)).expect(200);
    expect(res.body.data).toEqual({ job: null, proposedTopics: 0 });
  });
});
