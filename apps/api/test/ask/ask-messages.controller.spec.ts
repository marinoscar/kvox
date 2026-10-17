import { Prisma } from '@prisma/client';
import request from 'supertest';

import { AiReadinessService } from '../../src/ai-port/ai-readiness.service';
import { notReadyReadiness, readyReadiness } from '../helpers/ai-readiness.fixtures';
import { GraphAiRunResolver } from '@marinoscar/kvox-api/graph';
import { postAskMessageResponseSchema } from '@marinoscar/kvox-contract/ask';
import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { prismaMock, resetPrismaMock, mockPrismaTransaction } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';

// =============================================================================
// `POST /api/ask/conversations/:id/messages` over the wire (issue #378)
// =============================================================================
//
// The REAL `AppModule` — guards, Zod pipe, envelope, and the REAL `KVOX_AI`
// binding — with `PrismaService` mocked and the readiness the binding reads
// scripted (`AiReadinessService`, the reader `createKvoxAi` shares). What it pins:
//   - 401 / 403 (without `graph:read`, before any row is read) / 400 bodies;
//   - 404 for a conversation that is not the caller's;
//   - the readiness refusals answered as the 409s the product always sent (a model the
//     deployment does not permit now answers like one that cannot call tools: the AI port has one
//     'capability' class for both), before any write;
//   - the running-turn index violation → 409 `ask_turn_running`;
//   - 202 with both messages, the job enqueued at priority −10 with the
//     assistant message as its subject, and the derived title.
// The real index race is `ask-respond.db.spec.ts`.
// =============================================================================

const CONV = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const URL = `/api/ask/conversations/${CONV}/messages`;


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
  /** The deployment's `ai` namespace as the graph's resolver reads it (the switch is the resolver's, not the port's). */
  let policy: jest.SpyInstance;
  /** The readiness the bound `KVOX_AI` resolves the target through. */
  let readiness: jest.SpyInstance;

  /** Every readiness call: (userId, feature, requested model). */
  const readinessCalls = () => readiness.mock.calls as Array<[string, string, string | null | undefined]>;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    mockPrismaTransaction();
    readiness?.mockRestore();
    policy?.mockRestore();
    policy = jest
      .spyOn(context.app.get(GraphAiRunResolver) as unknown as { policy(): Promise<unknown> }, 'policy')
      .mockResolvedValue({ graphEnabled: true });
    readiness = jest
      .spyOn(context.app.get(AiReadinessService), 'readiness')
      .mockResolvedValue(readyReadiness({ model: 'gpt-test', reasoningEffort: 'low', source: 'task' }));
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
    expect(readinessCalls()).toHaveLength(0);
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
    expect(readinessCalls()).toHaveLength(0);
    const where = (prismaMock.askConversation.findFirst.mock.calls[0][0] as { where: unknown }).where;
    expect(where).toEqual({ id: CONV, ownerId: user.id });
  });

  it.each(['graph_disabled', 'ai_not_configured', 'ai_key_missing', 'model_lacks_capability'] as const)(
    'answers the readiness refusal %s as a 409 with that reason, writing nothing',
    async (reason) => {
      const user = await createMockTestUser(context, { roleName: 'viewer' });
      if (reason === 'graph_disabled') policy.mockResolvedValue({ graphEnabled: false });
      else readiness.mockResolvedValue(notReadyReadiness(reason));
      const res = await post(user.accessToken, { content: 'Hi?' }).expect(409);
      expect(res.body.details).toMatchObject({ reason });
      expect(prismaMock.askMessage.create).not.toHaveBeenCalled();
    },
  );

  it('answers a model the deployment does not permit as model_lacks_capability (409), naming the task and the model', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    readiness.mockResolvedValue(notReadyReadiness('model_not_permitted'));
    const res = await post(user.accessToken, { content: 'Hi?', model: 'gpt-nope' }).expect(409);
    expect(res.body.details).toMatchObject({ reason: 'model_lacks_capability', task: 'graph.agent', model: 'gpt-nope', missing: ['toolCalling'] });
    expect(readinessCalls().at(-1)).toEqual([user.id, 'graph_agent', 'gpt-nope']);
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
