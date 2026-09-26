import request from 'supertest';

import { ASK_MESSAGE_NOT_FOUND } from '../../src/ask/ask-access.service';
import { ASK_STREAM_TUNING, AskMessageStreamService } from '../../src/ask/stream/ask-message-stream.service';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import { TestContext, closeTestApp, createTestApp } from '../helpers/test-app.helper';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';

// =============================================================================
// GET /api/ask/messages/:id/stream over the wire (issue #379, epic #348)
// =============================================================================
//
// Through the REAL `AppModule` — guards, exception filter, and the
// `TransformInterceptor`'s `@Sse()` bypass — with only `PrismaService` a
// stand-in, so an `ask.respond` turn (#378) can be scripted poll by poll in the
// shapes the job writes. `ASK_STREAM_TUNING` is overridden to milliseconds.
//
// Pinned here: 401 / 403 (the permission guard, before any row is read) /
// 404-never-403 (foreign, missing and user-role ids, byte-identical, before any
// stream bytes), 400 for a malformed id, and the header-vs-query resume
// precedence — observed both as the offset the service is handed and as the
// text that comes back.
// =============================================================================

const MESSAGE_ID = '55555555-5555-4555-8555-555555555555';
const CONVERSATION_ID = '66666666-6666-4666-8666-666666666666';
const url = (id = MESSAGE_ID) => `/api/ask/messages/${id}/stream`;

interface Frame {
  event: string;
  id: string | null;
  data: Record<string, unknown>;
}

/** Hand-written, independent of the web client's parser (see the note stream spec). */
function parseSse(body: string): { frames: Frame[]; comments: string[] } {
  const frames: Frame[] = [];
  const comments: string[] = [];
  for (const block of body.split('\n\n')) {
    let event = 'message';
    let id: string | null = null;
    let data = '';
    for (const line of block.split('\n')) {
      if (line === '') continue;
      if (line.startsWith(':')) {
        comments.push(line.slice(1).trim());
        continue;
      }
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      else if (line.startsWith('id:')) id = line.slice('id:'.length).trim();
      else if (line.startsWith('data:')) data += line.slice('data:'.length).trim();
    }
    if (data !== '') frames.push({ event, id, data: JSON.parse(data) });
  }
  return { frames, comments };
}

const deltasOf = (frames: Frame[]) => frames.filter((f) => f.event === 'delta').map((f) => f.data.delta as string);

/** The access check's row: a message with its conversation (`requireMessage`'s `include`). */
const accessRow = (ownerId: string, overrides: Record<string, unknown> = {}) => ({
  id: MESSAGE_ID,
  conversationId: CONVERSATION_ID,
  role: 'assistant',
  content: '',
  status: 'streaming',
  toolCalls: [],
  citations: [],
  model: 'gpt-4o',
  provider: 'openai',
  promptTokens: null,
  completionTokens: null,
  errorClass: null,
  finishReason: null,
  jobId: null,
  createdAt: new Date('2026-09-20T10:00:00.000Z'),
  conversation: { id: CONVERSATION_ID, ownerId, title: 'Acme', scopeEntityId: null },
  ...overrides,
});

/** A poll row as the stream's narrow `select` returns it. */
const pollRow = (overrides: Record<string, unknown> = {}) => ({
  status: 'streaming',
  content: '',
  toolCalls: [],
  citations: [],
  promptTokens: null,
  completionTokens: null,
  errorClass: null,
  finishReason: null,
  ...overrides,
});

const step = (index: number) => ({
  index,
  name: 'search',
  arguments: { q: 'Acme' },
  summary: `Searched ${index}`,
  resultCount: 1,
  durationMs: 5,
  error: null,
});

/** Script the poll; the last row repeats. */
function scriptPolls(rows: unknown[]): void {
  let index = 0;
  prismaMock.askMessage.findUnique.mockImplementation((async () => {
    const value = rows[Math.min(index, rows.length - 1)];
    index += 1;
    return value;
  }) as never);
}

/** Same technique as `ask-conversations.controller.spec.ts`. */
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

describe('Ask message stream (#379)', () => {
  let context: TestContext;
  let streamSpy: jest.SpyInstance;

  beforeAll(async () => {
    context = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [
        { provide: ASK_STREAM_TUNING, useValue: { pollIntervalMs: 3, heartbeatIntervalMs: 10, durationCapMs: 250 } },
      ],
    });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    jest.clearAllMocks();
    streamSpy = jest.spyOn(AskMessageStreamService.prototype, 'stream');
  });

  afterEach(() => {
    streamSpy.mockRestore();
  });

  const http = () => request(context.app.getHttpServer());

  // ==========================================================================
  // Authentication, permission, access
  // ==========================================================================

  it('is 401 without a session', async () => {
    await http().get(url()).expect(401);
    expect(prismaMock.askMessage.findFirst).not.toHaveBeenCalled();
  });

  it('is 403 without graph:read — the permission guard, before any row is read', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    stripPermission(user.id, 'graph:read');

    await http().get(url()).set(authHeader(user.accessToken)).expect(403);

    expect(prismaMock.askMessage.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.askMessage.findUnique).not.toHaveBeenCalled();
  });

  it('is 400 for a malformed id', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    await http().get(url('not-a-uuid')).set(authHeader(user.accessToken)).expect(400);
    expect(prismaMock.askMessage.findFirst).not.toHaveBeenCalled();
  });

  it('answers the same JSON 404 for a missing/foreign message and a user message, before any stream', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });

    // Missing, or somebody else's: the owner-scoped lookup finds nothing.
    prismaMock.askMessage.findFirst.mockResolvedValueOnce(null as never);
    const foreign = await http().get(url()).set(authHeader(user.accessToken)).expect(404);

    // One of the caller's own messages — but a question, not an answer.
    prismaMock.askMessage.findFirst.mockResolvedValueOnce(
      accessRow(user.id, { role: 'user', status: 'complete', content: 'What about Acme?' }) as never,
    );
    const userRole = await http().get(url()).set(authHeader(user.accessToken)).expect(404);

    for (const res of [foreign, userRole]) {
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body.message).toBe(ASK_MESSAGE_NOT_FOUND);
    }
    // Byte-identical but for the error envelope's own timestamp.
    expect(foreign.body).toEqual({ ...userRole.body, timestamp: expect.any(String) });

    // Ownership is decided through the conversation, never a column of the message.
    expect(prismaMock.askMessage.findFirst).toHaveBeenCalledWith({
      where: { id: MESSAGE_ID, conversation: { ownerId: user.id } },
      include: { conversation: true },
    });
    expect(streamSpy).not.toHaveBeenCalled();
    expect(prismaMock.askMessage.findUnique).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // The stream
  // ==========================================================================

  it('streams steps, then text whose concatenation is the answer, then done', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    const answer = 'Acme renewed in March [^ev1].';
    prismaMock.askMessage.findFirst.mockResolvedValue(accessRow(user.id) as never);
    scriptPolls([
      pollRow({ status: 'pending' }),
      pollRow({ toolCalls: [step(0)] }),
      pollRow({ toolCalls: [step(0), step(1)] }),
      pollRow({ toolCalls: [step(0), step(1)], content: answer.slice(0, 12) }),
      pollRow({
        status: 'complete',
        toolCalls: [step(0), step(1)],
        content: answer,
        finishReason: 'stop',
        promptTokens: 100,
        completionTokens: 9,
      }),
    ]);

    const res = await http()
      .get(url())
      .set(authHeader(user.accessToken))
      .expect(200)
      .expect('Content-Type', /text\/event-stream/);

    const { frames, comments } = parseSse(res.text);

    expect(comments[0]).toBe('connected');
    expect(frames.map((f) => f.event)).toEqual(['step', 'step', 'delta', 'delta', 'done']);
    expect(deltasOf(frames).join('')).toBe(answer);
    expect(frames[1]).toEqual({
      event: 'step',
      id: '0',
      data: { index: 1, name: 'search', summary: 'Searched 1', resultCount: 1, error: null, offset: 0 },
    });
    expect(frames.at(-1)).toEqual({
      event: 'done',
      id: String(answer.length),
      data: {
        status: 'succeeded',
        offset: answer.length,
        citations: [],
        finishReason: 'stop',
        promptTokens: 100,
        completionTokens: 9,
      },
    });
    expect(streamSpy).toHaveBeenCalledWith(MESSAGE_ID, 0);
  });

  it('ends a failed turn with error and its stored class', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    prismaMock.askMessage.findFirst.mockResolvedValue(accessRow(user.id) as never);
    scriptPolls([pollRow({ status: 'failed', content: 'Partial', errorClass: 'refusal' })]);

    const { frames } = parseSse((await http().get(url()).set(authHeader(user.accessToken)).expect(200)).text);

    expect(frames.map((f) => f.event)).toEqual(['delta', 'error']);
    expect(frames[1].data).toEqual({ status: 'failed', offset: 7, errorClass: 'refusal', reason: null });
  });

  it('ends with error gone when the conversation is deleted mid-stream', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    prismaMock.askMessage.findFirst.mockResolvedValue(accessRow(user.id) as never);
    scriptPolls([pollRow({ content: 'Looking' }), null]);

    const { frames } = parseSse((await http().get(url()).set(authHeader(user.accessToken)).expect(200)).text);

    expect(frames.at(-1)?.data).toEqual({ status: 'failed', offset: 7, errorClass: 'gone', reason: 'message_gone' });
  });

  it('ends a turn that never settles on the cap with timeout / stream_duration_cap', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    prismaMock.askMessage.findFirst.mockResolvedValue(accessRow(user.id) as never);
    scriptPolls([pollRow({ status: 'pending' })]);

    const { frames, comments } = parseSse((await http().get(url()).set(authHeader(user.accessToken)).expect(200)).text);

    expect(frames).toHaveLength(1);
    expect(frames[0].data).toEqual({ status: 'failed', offset: 0, errorClass: 'timeout', reason: 'stream_duration_cap' });
    expect(comments).toContain('heartbeat');
  });

  // ==========================================================================
  // Resume precedence
  // ==========================================================================

  describe('resume', () => {
    const answer = 'The first connection saw this. The reconnect sees the rest.';
    const seen = 'The first connection saw this.'.length;

    const settled = async (userId: string) => {
      prismaMock.askMessage.findFirst.mockResolvedValue(accessRow(userId) as never);
      scriptPolls([pollRow({ status: 'complete', content: answer, toolCalls: [step(0)] })]);
    };

    it('resumes from Last-Event-ID, still re-sending the recorded steps first', async () => {
      const user = await createMockTestUser(context, { roleName: 'viewer' });
      await settled(user.id);

      const res = await http().get(url()).set(authHeader(user.accessToken)).set('Last-Event-ID', String(seen)).expect(200);
      const { frames } = parseSse(res.text);

      expect(frames.map((f) => f.event)).toEqual(['step', 'delta', 'done']);
      expect(frames[0].data).toMatchObject({ index: 0, offset: seen });
      expect(deltasOf(frames).join('')).toBe(answer.slice(seen));
      expect(streamSpy).toHaveBeenCalledWith(MESSAGE_ID, seen);
    });

    it('uses ?lastEventId= when the header is absent', async () => {
      const user = await createMockTestUser(context, { roleName: 'viewer' });
      await settled(user.id);

      const res = await http().get(`${url()}?lastEventId=${seen}`).set(authHeader(user.accessToken)).expect(200);

      expect(deltasOf(parseSse(res.text).frames).join('')).toBe(answer.slice(seen));
      expect(streamSpy).toHaveBeenCalledWith(MESSAGE_ID, seen);
    });

    it('prefers the header over the query when the header is > 0', async () => {
      const user = await createMockTestUser(context, { roleName: 'viewer' });
      await settled(user.id);

      await http().get(`${url()}?lastEventId=3`).set(authHeader(user.accessToken)).set('Last-Event-ID', String(seen)).expect(200);

      expect(streamSpy).toHaveBeenCalledWith(MESSAGE_ID, seen);
    });

    it('falls back to the query when the header is 0 or garbage', async () => {
      const user = await createMockTestUser(context, { roleName: 'viewer' });
      await settled(user.id);

      await http().get(`${url()}?lastEventId=${seen}`).set(authHeader(user.accessToken)).set('Last-Event-ID', 'nope').expect(200);
      expect(streamSpy).toHaveBeenLastCalledWith(MESSAGE_ID, seen);

      await settled(user.id);
      await http().get(`${url()}?lastEventId=${seen}`).set(authHeader(user.accessToken)).set('Last-Event-ID', '0').expect(200);
      expect(streamSpy).toHaveBeenLastCalledWith(MESSAGE_ID, seen);
    });

    it('treats invalid values everywhere as 0 — the whole answer is replayed', async () => {
      const user = await createMockTestUser(context, { roleName: 'viewer' });
      await settled(user.id);

      const res = await http()
        .get(`${url()}?lastEventId=-4`)
        .set(authHeader(user.accessToken))
        .set('Last-Event-ID', '1.5')
        .expect(200);

      expect(deltasOf(parseSse(res.text).frames).join('')).toBe(answer);
      expect(streamSpy).toHaveBeenCalledWith(MESSAGE_ID, 0);
    });
  });
});
