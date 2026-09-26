import request from 'supertest';

import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import { askConversationSummarySchema } from '../../src/ask/dto/ask.dto';

// =============================================================================
// The Ask conversation routes over the wire (issue #376, epic #348)
// =============================================================================
//
// Driven through the REAL `AppModule` — guards, Zod pipes, envelope — with
// only `PrismaService` mocked. The SQL is proven against Postgres in
// `ask-conversations.db.spec.ts`; this file pins the HTTP contract:
//
//   - 401 unauthenticated and 403 without `graph:read` on all five routes —
//     the permission guard's 403, before any row is read;
//   - the Zod 400s (title length, limit, malformed ids/query);
//   - 201 on create, 204 on delete, and the byte-identical 404.
// =============================================================================

const CONV = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const ROUTES: { name: string; method: 'get' | 'post' | 'patch' | 'delete'; url: string; body?: unknown }[] = [
  { name: 'list', method: 'get', url: '/api/ask/conversations' },
  { name: 'detail', method: 'get', url: `/api/ask/conversations/${CONV}` },
  { name: 'create', method: 'post', url: '/api/ask/conversations', body: {} },
  { name: 'rename', method: 'patch', url: `/api/ask/conversations/${CONV}`, body: { title: 'New title' } },
  { name: 'delete', method: 'delete', url: `/api/ask/conversations/${CONV}` },
];

/** Same technique as `graph-read.controller.spec.ts`. */
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

describe('Ask conversation routes (integration)', () => {
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
    prismaMock.$queryRaw.mockResolvedValue([] as never);
    prismaMock.askConversation.findFirst.mockResolvedValue(null as never);
  });

  const http = () => request(context.app.getHttpServer());
  const send = (route: (typeof ROUTES)[number], token?: string) => {
    const req = http()[route.method](route.url);
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
      expect(prismaMock.askConversation.findFirst).not.toHaveBeenCalled();
      expect(prismaMock.askConversation.create).not.toHaveBeenCalled();
      expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    });
  });

  it('lists for a viewer (graph:read is seeded to every role)', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    const res = await http().get('/api/ask/conversations').set(authHeader(user.accessToken)).expect(200);
    expect(res.body.data).toEqual({ items: [], nextCursor: null });
  });

  it.each([
    ['limit above 50', '/api/ask/conversations?limit=51'],
    ['limit below 1', '/api/ask/conversations?limit=0'],
    ['a non-uuid scopeEntityId', '/api/ask/conversations?scopeEntityId=nope'],
    ['an unreadable cursor', '/api/ask/conversations?cursor=%25%25%25'],
    ['a non-uuid before', `/api/ask/conversations/${CONV}?before=nope`],
  ])('is 400 for %s', async (_label, url) => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    await http().get(url).set(authHeader(user.accessToken)).expect(400);
  });

  it.each([
    ['an empty title', { title: '   ' }],
    ['a title over 120 characters', { title: 'x'.repeat(121) }],
    ['a non-uuid scope', { scopeEntityId: 'nope' }],
  ])('create is 400 for %s', async (_label, body) => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    await http().post('/api/ask/conversations').set(authHeader(user.accessToken)).send(body).expect(400);
    expect(prismaMock.askConversation.create).not.toHaveBeenCalled();
  });

  it('rename is 400 without a title, or with one over 120 characters', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    const url = `/api/ask/conversations/${CONV}`;
    await http().patch(url).set(authHeader(user.accessToken)).send({}).expect(400);
    await http().patch(url).set(authHeader(user.accessToken)).send({ title: 'x'.repeat(121) }).expect(400);
  });

  it('create answers 201 with a summary that is not running and has no preview', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    const now = new Date('2026-09-02T10:00:00.000Z');
    prismaMock.askConversation.create.mockResolvedValue({
      id: CONV,
      ownerId: user.id,
      title: 'Atlas',
      scopeEntityId: null,
      createdAt: now,
      updatedAt: now,
    } as never);

    const res = await http()
      .post('/api/ask/conversations')
      .set(authHeader(user.accessToken))
      .send({ title: '  Atlas  ' })
      .expect(201);

    expect(res.body.data).toMatchObject({ id: CONV, title: 'Atlas', running: false, lastMessagePreview: null, scopeEntity: null });
    expect(askConversationSummarySchema.safeParse(res.body.data).success).toBe(true);
    expect(prismaMock.askConversation.create).toHaveBeenCalledWith({
      data: { ownerId: user.id, title: 'Atlas', scopeEntityId: null },
    });
  });

  it('create with a scope that is not a readable entity of yours is 404', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    prismaMock.kgEntity.findUnique.mockResolvedValue(null as never);

    await http()
      .post('/api/ask/conversations')
      .set(authHeader(user.accessToken))
      .send({ scopeEntityId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' })
      .expect(404);
    expect(prismaMock.askConversation.create).not.toHaveBeenCalled();
  });

  it('a missing or foreign conversation is the same 404 on detail, rename and delete', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    const bodies = await Promise.all(
      ROUTES.filter((r) => r.name !== 'list' && r.name !== 'create').map(async (route) => {
        const res = await send(route, user.accessToken).expect(404);
        return res.body.message;
      }),
    );
    expect(new Set(bodies).size).toBe(1);
    expect(prismaMock.askConversation.findFirst).toHaveBeenCalledWith({ where: { id: CONV, ownerId: user.id } });
  });

  it('delete answers 204 with no body and writes the audit event', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    prismaMock.askConversation.findFirst.mockResolvedValue({ id: CONV, ownerId: user.id, scopeEntityId: null } as never);
    prismaMock.askMessage.count.mockResolvedValue(2 as never);
    prismaMock.askConversation.deleteMany.mockResolvedValue({ count: 1 } as never);
    prismaMock.auditEvent.create.mockResolvedValue({} as never);

    const res = await http().delete(`/api/ask/conversations/${CONV}`).set(authHeader(user.accessToken)).expect(204);

    expect(res.text).toBe('');
    expect(prismaMock.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'ask.conversation_deleted',
        targetType: 'ask_conversation',
        targetId: CONV,
        meta: { messageCount: 2, scopeEntityId: null },
      }),
    });
  });
});
