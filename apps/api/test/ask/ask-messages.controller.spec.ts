import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import request from 'supertest';

import { AiTaskModelResolver } from '../../src/ai/ai-task-model-resolver.service';
import { postAskMessageResponseSchema } from '../../src/ask/dto/ask-messages.dto';
import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { prismaMock, resetPrismaMock, mockPrismaTransaction } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';

// =============================================================================
// `POST /api/ask/conversations/:id/messages` over the wire (issue #378)
// =============================================================================
//
// The REAL `AppModule` — guards, Zod pipe, envelope — with `PrismaService`
// and the task-model resolver mocked. What it pins:
//   - 401 / 403 (without `graph:read`, before any row is read) / 400 bodies;
//   - 404 for a conversation that is not the caller's;
//   - the resolver's 409s and 400 passed through UNCHANGED, before any write;
//   - the running-turn index violation → 409 `ask_turn_running`;
//   - 202 with both messages, the job enqueued at priority −10 with the
//     assistant message as its subject, and the derived title.
// The real index race is `ask-respond.db.spec.ts`.
// =============================================================================

const CONV = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const URL = `/api/ask/conversations/${CONV}/messages`;

const resolver = { resolve: jest.fn() };

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

const row = (over: Record<string, unknown>) => ({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  conversationId: CONV,
  role: 'user',
  content: '',
  status: 'complete',
  toolCalls: [],
  citations: [],
  model: null,
  provider: null,
  promptTokens: null,
  completionTokens: null,
  errorClass: null,
  finishReason: null,
  jobId: null,
  createdAt: new Date('2026-09-26T10:00:00Z'),
  ...over,
});

describe('POST /api/ask/conversations/:id/messages (integration)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [{ provide: AiTaskModelResolver, useValue: resolver }],
    });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    mockPrismaTransaction();
    resolver.resolve.mockReset();
    resolver.resolve.mockResolvedValue({ model: 'gpt-test', providerId: 'openai', reasoningEffort: 'low', source: 'task' });
    prismaMock.askConversation.findFirst.mockResolvedValue({ id: CONV, ownerId: 'x', title: null, scopeEntityId: null } as never);
  });

  const http = () => request(context.app.getHttpServer());
  const post = (token: string | null, body: unknown) => {
    const req = http().post(URL);
    if (token) req.set(authHeader(token));
    return req.send(body as object);
  };

  it('is 401 without a session', async () => {
    await post(null, { content: 'Hi?' }).expect(401);
  });

  it('is 403 without graph:read, before any row is read', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    stripPermission(user.id, 'graph:read');
    await post(user.accessToken, { content: 'Hi?' }).expect(403);
    expect(prismaMock.askConversation.findFirst).not.toHaveBeenCalled();
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty question', { content: '   ' }],
    ['a missing question', {}],
    ['a question over 4000 characters', { content: 'x'.repeat(4001) }],
    ['a model over 200 characters', { content: 'Hi?', model: 'm'.repeat(201) }],
  ])('is 400 for %s', async (_label, body) => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    await post(user.accessToken, body).expect(400);
    expect(prismaMock.askMessage.create).not.toHaveBeenCalled();
  });

  it('is 400 for a non-uuid conversation id', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    await http().post('/api/ask/conversations/nope/messages').set(authHeader(user.accessToken)).send({ content: 'Hi?' }).expect(400);
  });

  it('is 404 for a conversation that is not the caller’s, before the resolver runs', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    prismaMock.askConversation.findFirst.mockResolvedValue(null as never);
    await post(user.accessToken, { content: 'Hi?' }).expect(404);
    expect(resolver.resolve).not.toHaveBeenCalled();
    const where = (prismaMock.askConversation.findFirst.mock.calls[0][0] as { where: unknown }).where;
    expect(where).toEqual({ id: CONV, ownerId: user.id });
  });

  it.each(['graph_disabled', 'ai_not_configured', 'ai_key_missing', 'model_lacks_capability'])(
    'passes the resolver 409 %s through unchanged, writing nothing',
    async (reason) => {
      const user = await createMockTestUser(context, { roleName: 'viewer' });
      resolver.resolve.mockRejectedValue(new ConflictException({ message: 'Refused.', details: { reason } }));
      const res = await post(user.accessToken, { content: 'Hi?' }).expect(409);
      expect(JSON.stringify(res.body)).toContain(reason);
      expect(prismaMock.askMessage.create).not.toHaveBeenCalled();
    },
  );

  it('passes the resolver 400 for an unpermitted model through, and asks for the override', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    resolver.resolve.mockRejectedValue(
      new BadRequestException({ message: 'Not permitted.', details: { reason: 'model_not_permitted' } }),
    );
    await post(user.accessToken, { content: 'Hi?', model: 'gpt-nope' }).expect(400);
    expect(resolver.resolve).toHaveBeenCalledWith(user.id, 'graph.agent', 'gpt-nope');
    expect(prismaMock.askMessage.create).not.toHaveBeenCalled();
  });

  it('is 409 ask_turn_running when the running-turn index refuses the assistant row', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    prismaMock.askMessage.create
      .mockResolvedValueOnce(row({ content: 'Hi?' }) as never)
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' }),
      );
    const res = await post(user.accessToken, { content: 'Hi?' }).expect(409);
    expect(JSON.stringify(res.body)).toContain('ask_turn_running');
    expect(prismaMock.job.create).not.toHaveBeenCalled();
  });

  it('is 202 with both messages, enqueues ask.respond at −10, and titles the conversation', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    const assistantId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    prismaMock.askMessage.create
      .mockResolvedValueOnce(row({ content: '  What changed   with Acme?  ' }) as never)
      .mockResolvedValueOnce(row({ id: assistantId, role: 'assistant', status: 'pending', model: 'gpt-test', provider: 'openai' }) as never);
    prismaMock.job.create.mockResolvedValue({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' } as never);
    prismaMock.askMessage.update.mockResolvedValue(
      row({
        id: assistantId,
        role: 'assistant',
        status: 'pending',
        model: 'gpt-test',
        provider: 'openai',
        jobId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      }) as never,
    );
    prismaMock.askConversation.updateMany.mockResolvedValue({ count: 1 } as never);

    const res = await post(user.accessToken, { content: '  What changed   with Acme?  ' }).expect(202);
    const body = postAskMessageResponseSchema.parse(res.body.data);
    expect(body.userMessage.role).toBe('user');
    expect(body.assistantMessage).toMatchObject({ id: assistantId, role: 'assistant', status: 'pending', model: 'gpt-test' });

    // The question is stored trimmed; the assistant row is pending with the model.
    expect(prismaMock.askMessage.create.mock.calls[0][0]).toMatchObject({
      data: { conversationId: CONV, role: 'user', status: 'complete', content: 'What changed   with Acme?' },
    });
    expect(prismaMock.askMessage.create.mock.calls[1][0]).toMatchObject({
      data: { conversationId: CONV, role: 'assistant', status: 'pending', model: 'gpt-test', provider: 'openai' },
    });
    const jobData = (prismaMock.job.create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(jobData).toMatchObject({
      type: 'ask.respond',
      subjectType: 'ask_message',
      subjectId: assistantId,
      priority: -10,
      payload: { assistantMessageId: assistantId, conversationId: CONV, userId: user.id, model: 'gpt-test', providerId: 'openai' },
    });
    expect(prismaMock.askConversation.updateMany).toHaveBeenCalledWith({
      where: { id: CONV, ownerId: user.id, title: null },
      data: { title: 'What changed with Acme?' },
    });
  });
});
