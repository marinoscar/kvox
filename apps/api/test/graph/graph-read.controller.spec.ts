import request from 'supertest';

import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import { listEntitiesResponseSchema } from '@marinoscar/kvox-contract/graph';

// =============================================================================
// The graph read routes over the wire (#370, epic #347)
// =============================================================================
//
// Driven through the REAL `AppModule` — guards, Zod pipes, envelope — with
// only `PrismaService` mocked. The SQL itself is proven against Postgres in
// `graph-read.db.spec.ts` / `graph-neighborhood.db.spec.ts`; this file pins
// the HTTP contract:
//
//   - 401 unauthenticated and 403 without `graph:read` on every route — the
//     PERMISSION guard's 403, which runs before any row is looked at;
//   - the Zod 400s and the limit ceilings;
//   - the byte-identical 404 for a missing and a foreign entity;
//   - `POST /api/graph/explore/expand` answers 200, not 201.
// =============================================================================

const ENTITY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EVIDENCE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const ROUTES: { name: string; method: 'get' | 'post'; url: string; body?: unknown }[] = [
  { name: 'list', method: 'get', url: '/api/graph/entities' },
  { name: 'detail', method: 'get', url: `/api/graph/entities/${ENTITY}` },
  { name: 'neighborhood', method: 'get', url: `/api/graph/entities/${ENTITY}/neighborhood` },
  { name: 'timeline', method: 'get', url: `/api/graph/entities/${ENTITY}/timeline` },
  { name: 'mentions', method: 'get', url: `/api/graph/entities/${ENTITY}/mentions` },
  { name: 'paths', method: 'get', url: `/api/graph/paths?from=${ENTITY}&to=${OTHER}` },
  { name: 'activity', method: 'get', url: `/api/graph/activity?ids=${ENTITY}` },
  { name: 'expand', method: 'post', url: '/api/graph/explore/expand', body: { nodeIds: [ENTITY] } },
  { name: 'connect', method: 'post', url: '/api/graph/connect', body: { entityIds: [ENTITY, OTHER] } },
  { name: 'evidence', method: 'get', url: `/api/graph/evidence/${EVIDENCE}` },
  { name: 'evidence batch', method: 'get', url: `/api/graph/evidence?ids=${EVIDENCE}` },
];

/** Same technique as `graph-ontology.integration.spec.ts`. */
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

/** The literal values a `$queryRaw` tagged-template call was given, flattened through nested `Prisma.sql`. */
function queryValues(call: unknown[]): unknown[] {
  const out: unknown[] = [];
  const visit = (v: unknown) => {
    if (v && typeof v === 'object' && 'values' in (v as object) && Array.isArray((v as { values: unknown[] }).values)) {
      (v as { values: unknown[] }).values.forEach(visit);
    } else {
      out.push(v);
    }
  };
  call.slice(1).forEach(visit);
  return out;
}

describe('Graph read routes (integration)', () => {
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
    prismaMock.kgAttributeDef.findMany.mockResolvedValue([] as never);
    prismaMock.$queryRaw.mockResolvedValue([] as never);
    prismaMock.kgEntity.findUnique.mockResolvedValue(null as never);
    prismaMock.kgEvidence.findUnique.mockResolvedValue(null as never);
  });

  const send = (route: (typeof ROUTES)[number], token?: string) => {
    const req = request(context.app.getHttpServer())[route.method](route.url);
    if (token) req.set(authHeader(token));
    return route.body ? req.send(route.body as object) : req;
  };

  describe.each(ROUTES)('$name', (route) => {
    it('is 401 without a session', async () => {
      await send(route).expect(401);
    });

    it('is 403 without graph:read (the permission guard, before any row is read)', async () => {
      const user = await createMockTestUser(context, { roleName: 'viewer' });
      stripPermission(user.id, 'graph:read');
      await send(route, user.accessToken).expect(403);
      expect(prismaMock.kgEntity.findUnique).not.toHaveBeenCalled();
      expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    });
  });

  it('answers the list for a viewer, with the default limit of 25', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    const res = await request(context.app.getHttpServer())
      .get('/api/graph/entities')
      .set(authHeader(user.accessToken))
      .expect(200);
    expect(res.body.data).toEqual({ items: [], nextCursor: null });
    expect(listEntitiesResponseSchema.safeParse(res.body.data).success).toBe(true);
    // limit + 1 detects the next page.
    expect(queryValues(prismaMock.$queryRaw.mock.calls[0] as unknown[])).toContain(26);
    expect(queryValues(prismaMock.$queryRaw.mock.calls[0] as unknown[])).toContain(user.id);
  });

  it('answers sort=mentions with a window, as the top `limit` and no next page', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    const res = await request(context.app.getHttpServer())
      .get('/api/graph/entities?sort=mentions&since=2026-09-21&limit=4&type=Person')
      .set(authHeader(user.accessToken))
      .expect(200);
    expect(res.body.data).toEqual({ items: [], nextCursor: null });
    const values = queryValues(prismaMock.$queryRaw.mock.calls[0] as unknown[]);
    expect(values).toContain(user.id);
    expect(values).toContain(4);
    expect(values).toContainEqual(new Date('2026-09-21T00:00:00.000Z'));
  });

  it.each([
    ['/api/graph/entities?limit=0'],
    ['/api/graph/entities?limit=51'],
    ['/api/graph/entities?sort=popular'],
    ['/api/graph/entities?sort=mentions&since=yesterday'],
    ['/api/graph/entities?sort=mentions&since=2026-13-01'],
    ['/api/graph/entities?transcriptId=not-a-uuid'],
    ['/api/graph/entities?q='],
    [`/api/graph/entities?q=${'x'.repeat(201)}`],
    [`/api/graph/entities?cursor=${'x'.repeat(501)}`],
    [`/api/graph/entities?type=${'A'.repeat(513)}`],
    ['/api/graph/entities/not-a-uuid'],
    [`/api/graph/entities/${ENTITY}/neighborhood?hops=3`],
    [`/api/graph/entities/${ENTITY}/neighborhood?hops=0`],
    [`/api/graph/entities/${ENTITY}/neighborhood?limit=301`],
    [`/api/graph/entities/${ENTITY}/neighborhood?as_of=2024-13-01`],
    [`/api/graph/entities/${ENTITY}/neighborhood?as_of=2024-01-15T10:00:00`],
    [`/api/graph/entities/${ENTITY}/timeline?includeSensitive=yes`],
    [`/api/graph/entities/${ENTITY}/timeline?limit=51`],
    [`/api/graph/entities/${ENTITY}/mentions?limit=0`],
    ['/api/graph/paths'],
    [`/api/graph/paths?from=${ENTITY}`],
    [`/api/graph/paths?from=nope&to=${OTHER}`],
    [`/api/graph/paths?from=${ENTITY}&to=${ENTITY}`],
    [`/api/graph/paths?from=${ENTITY}&to=${OTHER}&k=0`],
    [`/api/graph/paths?from=${ENTITY}&to=${OTHER}&k=6`],
    [`/api/graph/paths?from=${ENTITY}&to=${OTHER}&maxHops=0`],
    [`/api/graph/paths?from=${ENTITY}&to=${OTHER}&maxHops=6`],
    [`/api/graph/paths?from=${ENTITY}&to=${OTHER}&as_of=yesterday`],
    ['/api/graph/activity'],
    ['/api/graph/activity?ids='],
    ['/api/graph/activity?ids=not-a-uuid'],
    [`/api/graph/activity?ids=${ENTITY}&bucket=day`],
    [`/api/graph/activity?ids=${ENTITY}&from=yesterday`],
    [`/api/graph/activity?ids=${Array.from({ length: 301 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`).join(',')}`],
    ['/api/graph/evidence/not-a-uuid'],
    ['/api/graph/evidence?ids='],
    ['/api/graph/evidence?ids=nope'],
    [`/api/graph/evidence?ids=${Array.from({ length: 51 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`).join(',')}`],
  ])('rejects %s with 400', async (url) => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    await request(context.app.getHttpServer()).get(url).set(authHeader(user.accessToken)).expect(400);
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it.each([
    [{ nodeIds: [] }],
    [{ nodeIds: ['nope'] }],
    [{ nodeIds: Array.from({ length: 51 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) }],
    [{ nodeIds: [ENTITY], cap: 301 }],
    [{ nodeIds: [ENTITY], cap: 0 }],
    [{ nodeIds: [ENTITY], as_of: 'yesterday' }],
    [{ nodeIds: [ENTITY], types: Array.from({ length: 33 }, () => 'Person') }],
  ])('rejects the expand body %j with 400', async (body) => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    await request(context.app.getHttpServer())
      .post('/api/graph/explore/expand')
      .set(authHeader(user.accessToken))
      .send(body)
      .expect(400);
  });

  it.each([
    [{}],
    [{ entityIds: [ENTITY] }],
    [{ noteIds: [ENTITY, ENTITY] }],
    [{ noteIds: ['nope', ENTITY] }],
    [{ noteIds: Array.from({ length: 11 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) }],
    [{ entityIds: Array.from({ length: 21 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) }],
    [{ entityIds: [ENTITY, OTHER], maxHops: 4 }],
    [{ entityIds: [ENTITY, OTHER], maxHops: 0 }],
    [{ entityIds: [ENTITY, OTHER], as_of: 'yesterday' }],
  ])('rejects the connect body %j with 400', async (body) => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    await request(context.app.getHttpServer())
      .post('/api/graph/connect')
      .set(authHeader(user.accessToken))
      .send(body)
      .expect(400);
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it('answers connect with a 404 when an input is not readable', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    // The readable-entity lookup finds none of the two requested.
    prismaMock.$queryRaw.mockResolvedValue([] as never);
    await request(context.app.getHttpServer())
      .post('/api/graph/connect')
      .set(authHeader(user.accessToken))
      .send({ entityIds: [ENTITY, OTHER] })
      .expect(404);
  });

  it('rejects an unknown type key with 400 naming it', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    const res = await request(context.app.getHttpServer())
      .get('/api/graph/entities?type=Person,Spaceship')
      .set(authHeader(user.accessToken))
      .expect(400);
    expect(JSON.stringify(res.body)).toContain('Spaceship');
  });

  it('answers a missing and a foreign entity with the same 404 body', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    const missing = await request(context.app.getHttpServer())
      .get(`/api/graph/entities/${ENTITY}`)
      .set(authHeader(user.accessToken))
      .expect(404);

    prismaMock.kgEntity.findUnique.mockResolvedValue({
      id: ENTITY,
      ownerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      type: 'Person',
      label: 'Somebody else',
      reviewStatus: 'accepted',
      mergedIntoId: null,
    } as never);
    const foreign = await request(context.app.getHttpServer())
      .get(`/api/graph/entities/${ENTITY}`)
      .set(authHeader(user.accessToken))
      .expect(404);

    const { timestamp: _a, ...a } = missing.body;
    const { timestamp: _b, ...b } = foreign.body;
    expect(a).toEqual(b);
    expect(a.message).toBe('Entity not found');
  });

  it('answers expand with 200 (a read, even as a POST) and a 404 when a node is not readable', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    // `assertReadableNodes` counts 0 readable of 1 requested.
    prismaMock.$queryRaw.mockResolvedValueOnce([{ n: 0 }] as never);
    await request(context.app.getHttpServer())
      .post('/api/graph/explore/expand')
      .set(authHeader(user.accessToken))
      .send({ nodeIds: [ENTITY] })
      .expect(404);
  });

  it('answers paths with a 404 that does not say which end is unreadable, and 400 for an unknown relation type', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    // `assertReadableNodes` counts 1 readable of the 2 requested.
    prismaMock.$queryRaw.mockResolvedValueOnce([{ n: 1 }] as never);
    const res = await request(context.app.getHttpServer())
      .get(`/api/graph/paths?from=${ENTITY}&to=${OTHER}`)
      .set(authHeader(user.accessToken))
      .expect(404);
    // The message is the generic one; it never says which end.
    expect(res.body.message).toBe('Entity not found');
    expect(res.body.details).toBeUndefined();

    prismaMock.$queryRaw.mockResolvedValueOnce([{ n: 2 }] as never);
    const bad = await request(context.app.getHttpServer())
      .get(`/api/graph/paths?from=${ENTITY}&to=${OTHER}&relationTypes=NOPE`)
      .set(authHeader(user.accessToken))
      .expect(400);
    expect(JSON.stringify(bad.body)).toContain('NOPE');
  });

  it('answers activity with a 404 that does not say which id is unreadable, and accepts exactly 300 ids', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    prismaMock.$queryRaw.mockResolvedValueOnce([{ n: 0 }] as never);
    const res = await request(context.app.getHttpServer())
      .get(`/api/graph/activity?ids=${ENTITY},${OTHER}`)
      .set(authHeader(user.accessToken))
      .expect(404);
    expect(res.body.message).toBe('Entity not found');
    expect(res.body.details).toBeUndefined();

    const max = Array.from({ length: 300 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    prismaMock.$queryRaw.mockResolvedValueOnce([{ n: 300 }] as never);
    prismaMock.$transaction.mockImplementationOnce(async (fn: (tx: unknown) => unknown) => fn(prismaMock));
    prismaMock.$queryRaw.mockResolvedValueOnce([] as never);
    const ok = await request(context.app.getHttpServer())
      .get(`/api/graph/activity?ids=${max.join(',')}&bucket=week`)
      .set(authHeader(user.accessToken));
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({ bucket: 'week', series: [], byEntity: {} });
  });

  it('answers evidence batch with only the caller’s rows', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    prismaMock.kgEvidence.findMany.mockResolvedValue([] as never);
    const res = await request(context.app.getHttpServer())
      .get(`/api/graph/evidence?ids=${EVIDENCE},${EVIDENCE}`)
      .set(authHeader(user.accessToken))
      .expect(200);
    expect(res.body.data).toEqual({ items: [] });
    expect(prismaMock.kgEvidence.findMany).toHaveBeenCalledWith({ where: { id: { in: [EVIDENCE] }, ownerId: user.id } });
  });
});
