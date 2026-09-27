import request from 'supertest';

import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import { JobsService } from '../../src/jobs/jobs.service';
import { GraphObjectsService } from '../../src/graph/graph-objects.service';
import { createGraphExportResponseSchema, graphExportListSchema, kgExportSchema } from '../../src/graph/export/dto/graph-export.dto';

// =============================================================================
// /api/graph/exports over the wire (#386, epic #349)
// =============================================================================
//
// The REAL `AppModule` — guards, Zod pipe, envelope — with `PrismaService`
// mocked and the storage signer / queue spied. Pins the HTTP contract: 401,
// 403 without graph:read, 400 on an unknown format, 409 graph_empty, 202 then
// 200 `reused: true`, and the owner-scoped 404 for a foreign export.
// =============================================================================

const EXPORT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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

function exportRow(ownerId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: EXPORT,
    ownerId,
    format: 'turtle',
    status: 'pending',
    graphFingerprint: 'f'.repeat(64),
    ontologyVersion: '1.0.0',
    objectId: null,
    stats: {},
    errorMessage: null,
    jobId: null,
    expiresAt: new Date(Date.now() + 7 * 86_400_000),
    createdAt: new Date('2026-09-01T12:00:00Z'),
    ...overrides,
  };
}

describe('/api/graph/exports (integration)', () => {
  let context: TestContext;
  let enqueue: jest.SpyInstance;
  let sign: jest.SpyInstance;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    enqueue?.mockRestore();
    sign?.mockRestore();
    enqueue = jest.spyOn(context.app.get(JobsService), 'enqueue').mockResolvedValue({ id: 'job-1' } as never);
    sign = jest
      .spyOn(context.app.get(GraphObjectsService), 'signedUrlFor')
      .mockResolvedValue({ url: 'https://storage.example/signed', expiresAt: new Date(), object: {} as never });
    // hasExportableRows, then the fingerprint signature.
    prismaMock.$queryRaw.mockResolvedValueOnce([{ any: true }] as never).mockResolvedValue([] as never);
  });

  const post = (token: string | undefined, body: unknown) => {
    const req = request(context.app.getHttpServer()).post('/api/graph/exports');
    return (token ? req.set(authHeader(token)) : req).send(body as object);
  };
  const get = (url: string, token: string) => request(context.app.getHttpServer()).get(url).set(authHeader(token));

  it('is 401 without a session', async () => {
    await post(undefined, { format: 'turtle' }).expect(401);
  });

  it('is 403 without graph:read, before anything is read', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    stripPermission(user.id, 'graph:read');
    await post(user.accessToken, { format: 'turtle' }).expect(403);
    expect(prismaMock.kgExport.create).not.toHaveBeenCalled();
  });

  it('is 400 for an unknown format', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    await post(user.accessToken, { format: 'rdfxml' }).expect(400);
    expect(prismaMock.kgExport.create).not.toHaveBeenCalled();
  });

  it('is 409 graph_empty when there is nothing readable to export', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    prismaMock.$queryRaw.mockReset();
    prismaMock.$queryRaw.mockResolvedValue([{ any: false }] as never);
    const res = await post(user.accessToken, { format: 'turtle' }).expect(409);
    expect(res.body.details).toEqual({ reason: 'graph_empty' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('queues a render (202), then returns the same export for an unchanged graph (200, reused)', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    prismaMock.kgExport.findFirst.mockResolvedValue(null as never);
    prismaMock.kgExport.create.mockResolvedValue(exportRow(user.id) as never);
    prismaMock.kgExport.update.mockResolvedValue(exportRow(user.id, { jobId: 'job-1' }) as never);

    const queued = await post(user.accessToken, { format: 'turtle' }).expect(202);
    const body = createGraphExportResponseSchema.parse(queued.body.data);
    expect(body.reused).toBe(false);
    expect(body.export).toMatchObject({ id: EXPORT, status: 'pending', format: 'turtle', downloadUrl: null });
    expect(body.export.filename).toMatch(/-graph-2026-09-01\.ttl$/);
    expect(prismaMock.kgExport.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ ownerId: user.id, format: 'turtle', status: 'pending', graphFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) }),
    });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'kg.export',
        subjectType: 'kg_export',
        subjectId: EXPORT,
        payload: { mode: 'render', exportId: EXPORT },
        priority: -10,
      }),
    );

    // Same graph again: the reuse lookup finds the ready export.
    prismaMock.$queryRaw.mockReset();
    prismaMock.$queryRaw.mockResolvedValueOnce([{ any: true }] as never).mockResolvedValue([] as never);
    enqueue.mockClear();
    prismaMock.kgExport.create.mockClear();
    prismaMock.kgExport.findFirst.mockResolvedValue(exportRow(user.id, { status: 'ready', objectId: 'object-1' }) as never);
    const reused = await post(user.accessToken, { format: 'turtle' }).expect(200);
    const again = createGraphExportResponseSchema.parse(reused.body.data);
    expect(again.reused).toBe(true);
    expect(again.export.downloadUrl).toBe('https://storage.example/signed');
    expect(sign).toHaveBeenCalledWith('object-1', 900, expect.stringMatching(/^attachment; filename=".*-graph-2026-09-01\.ttl"/));
    expect(prismaMock.kgExport.create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    // The reuse lookup is owner-, format- and fingerprint-scoped, and never reuses a failed row.
    expect(prismaMock.kgExport.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ ownerId: user.id, format: 'turtle', status: { in: ['pending', 'running', 'ready'] } }),
      }),
    );
  });

  it('answers a foreign or missing export id with 404, scoped by owner in the query itself', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    prismaMock.kgExport.findFirst.mockResolvedValue(null as never);
    await get(`/api/graph/exports/${EXPORT}`, user.accessToken).expect(404);
    expect(prismaMock.kgExport.findFirst).toHaveBeenCalledWith({
      where: { id: EXPORT, ownerId: user.id, expiresAt: { gt: expect.any(Date) } },
    });
  });

  it('gets one export, signing the download only when it is ready', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    prismaMock.kgExport.findFirst.mockResolvedValue(
      exportRow(user.id, { status: 'ready', objectId: 'object-1', stats: { entities: 3, excludedSensitive: 1 } }) as never,
    );
    const res = await get(`/api/graph/exports/${EXPORT}`, user.accessToken).expect(200);
    const view = kgExportSchema.parse(res.body.data);
    expect(view.downloadUrl).toBe('https://storage.example/signed');
    expect(view.stats).toEqual({ entities: 3, excludedSensitive: 1 });
  });

  it('lists the caller’s unexpired exports, newest first, at most 20', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    prismaMock.kgExport.findMany.mockResolvedValue([exportRow(user.id, { format: 'jsonld' })] as never);
    const res = await get('/api/graph/exports', user.accessToken).expect(200);
    const list = graphExportListSchema.parse(res.body.data);
    expect(list.exports).toHaveLength(1);
    expect(list.exports[0].filename).toMatch(/\.jsonld$/);
    expect(prismaMock.kgExport.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ownerId: user.id, expiresAt: { gt: expect.any(Date) } }, take: 20 }),
    );
  });

  it('is 400 for a non-UUID id', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    await get('/api/graph/exports/not-a-uuid', user.accessToken).expect(400);
  });
});
