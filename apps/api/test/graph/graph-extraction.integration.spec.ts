import request from 'supertest';

import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';

// =============================================================================
// The graph extraction routes over the wire (#363)
// =============================================================================
//
// Through the REAL `AppModule` (guards, the envelope, the error filter) with
// `PrismaService` mocked: the routes exist, an EMPTY body is a valid request,
// a note you cannot see is the byte-identical 404, `graph:write` gates the
// request, and the deployment's default (connected knowledge switched off)
// answers 409 `graph_disabled` before anything is written.
// =============================================================================

const NOTE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** Same technique as `graph-entities.integration.spec.ts`. */
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

describe('graph extraction routes (integration)', () => {
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
  });

  function seedNote(ownerId: string, over: Record<string, unknown> = {}) {
    const note = {
      id: NOTE_ID,
      ownerId,
      title: 'Kickoff',
      body: 'Body',
      status: 'ready',
      currentVersion: 1,
      deletedAt: null,
      sourceType: 'document',
      sourceTranscriptId: null,
      sourceNoteId: null,
      contextText: null,
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
      ...over,
    };
    prismaMock.note.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === NOTE_ID ? note : null,
    );
  }

  it('POST with an empty body reaches the service: 409 graph_disabled on a default deployment', async () => {
    const owner = await createMockTestUser(context, { roleName: 'viewer' });
    seedNote(owner.id);

    const res = await request(context.app.getHttpServer())
      .post(`/api/graph/notes/${NOTE_ID}/extract`)
      .set(authHeader(owner.accessToken))
      .expect(409);

    expect(res.body.details).toEqual({ reason: 'graph_disabled' });
    expect(prismaMock.kgProposal.create).not.toHaveBeenCalled();
  });

  it('POST for a note that is not ready is 409 note_not_ready', async () => {
    const owner = await createMockTestUser(context, { roleName: 'viewer' });
    seedNote(owner.id, { status: 'generating' });

    const res = await request(context.app.getHttpServer())
      .post(`/api/graph/notes/${NOTE_ID}/extract`)
      .set(authHeader(owner.accessToken))
      .send({})
      .expect(409);
    expect(res.body.details).toEqual({ reason: 'note_not_ready' });
  });

  it("answers another user's note with the same 404 a missing one gets", async () => {
    const owner = await createMockTestUser(context, { roleName: 'viewer' });
    const stranger = await createMockTestUser(context, { roleName: 'admin' });
    seedNote(owner.id);

    const theirs = await request(context.app.getHttpServer())
      .post(`/api/graph/notes/${NOTE_ID}/extract`)
      .set(authHeader(stranger.accessToken))
      .send({})
      .expect(404);
    const missing = await request(context.app.getHttpServer())
      .post('/api/graph/notes/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/extract')
      .set(authHeader(stranger.accessToken))
      .send({})
      .expect(404);
    expect(theirs.body.message).toBe('Note not found');
    expect(missing.body.message).toBe(theirs.body.message);
  });

  it('refuses an unknown body key with 400', async () => {
    const owner = await createMockTestUser(context, { roleName: 'viewer' });
    seedNote(owner.id);
    await request(context.app.getHttpServer())
      .post(`/api/graph/notes/${NOTE_ID}/extract`)
      .set(authHeader(owner.accessToken))
      .send({ model: 'gpt-4o', surprise: true })
      .expect(400);
  });

  it('GET estimate: 400 without a valid noteId, 404 for a note you cannot see, 409 graph_disabled otherwise', async () => {
    const owner = await createMockTestUser(context, { roleName: 'viewer' });
    const stranger = await createMockTestUser(context, { roleName: 'viewer' });
    seedNote(owner.id);
    const server = context.app.getHttpServer();

    await request(server).get('/api/graph/extract/estimate?noteId=nope').set(authHeader(owner.accessToken)).expect(400);
    await request(server).get(`/api/graph/extract/estimate?noteId=${NOTE_ID}`).set(authHeader(stranger.accessToken)).expect(404);
    const res = await request(server)
      .get(`/api/graph/extract/estimate?noteId=${NOTE_ID}`)
      .set(authHeader(owner.accessToken))
      .expect(409);
    expect(res.body.details).toEqual({ reason: 'graph_disabled' });
  });

  it('POST without graph:write is 403', async () => {
    const owner = await createMockTestUser(context, { roleName: 'viewer' });
    seedNote(owner.id);
    stripPermission(owner.id, 'graph:write');
    await request(context.app.getHttpServer())
      .post(`/api/graph/notes/${NOTE_ID}/extract`)
      .set(authHeader(owner.accessToken))
      .send({})
      .expect(403);
  });

  it('answers 401 without a token', async () => {
    await request(context.app.getHttpServer()).post(`/api/graph/notes/${NOTE_ID}/extract`).send({}).expect(401);
    await request(context.app.getHttpServer()).get(`/api/graph/extract/estimate?noteId=${NOTE_ID}`).expect(401);
  });
});
