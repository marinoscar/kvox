// =============================================================================
// Real-Postgres test: the Ask answer stream (issue #379, epic #348)
// =============================================================================
//
// The poll's narrow `select` and the cascade that ends a stream with `gone`
// are Prisma/SQL behaviour, so they are proven against Postgres here. The
// rows are written the way `ask.respond` (#378) writes them — `pending`,
// `streaming` with `tool_calls` grown per tool and `content` grown by whole
// flushes, then `complete` — by plain updates standing in for the job.
// Excluded from `npm test`; run by `npm run test:db`.
// =============================================================================

import type { PrismaClient } from '@prisma/client';
import { firstValueFrom, toArray } from 'rxjs';

import { AskAccessService } from '../../src/ask/ask-access.service';
import { AskMessageStreamService } from '../../src/ask/stream/ask-message-stream.service';
import type { AskStreamMessage } from '../../src/ask/stream/ask-stream';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { resolveDbSuite } from '../jobs/db-test-support';
import { cleanupGraphFixtures, connectTestPrisma, createUser } from '../graph/graph-read.fixtures';

const { describeWithDb, dbReachable } = resolveDbSuite('ask-message-stream.db.spec');

const EMAIL_PREFIX = 'ask-stream-test';

const step = (index: number) => ({
  index,
  name: 'search',
  arguments: { q: 'Acme' },
  summary: `Searched ${index}`,
  resultCount: 2,
  durationMs: 7,
  error: null,
});

const frames = (messages: AskStreamMessage[]) => messages.filter((m) => m.comment === undefined);
const deltas = (messages: AskStreamMessage[]) =>
  frames(messages)
    .filter((m) => m.type === 'delta')
    .map((m) => (m.data as { delta: string }).delta);

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

describeWithDb('Ask message stream (real Postgres)', () => {
  let prisma: PrismaClient;
  let streams: AskMessageStreamService;
  let access: AskAccessService;

  beforeAll(async () => {
    if (!dbReachable) return;
    prisma = connectTestPrisma();
    await prisma.$connect();
    const p = prisma as unknown as PrismaService;
    streams = new AskMessageStreamService(p, { pollIntervalMs: 5, heartbeatIntervalMs: 10_000, durationCapMs: 20_000 });
    access = new AskAccessService(p);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  afterEach(async () => {
    if (!dbReachable) return;
    await cleanupGraphFixtures(prisma, EMAIL_PREFIX);
  }, 60_000);

  async function turn(suffix: string) {
    const owner = await createUser(prisma, EMAIL_PREFIX, suffix);
    const conversation = await prisma.askConversation.create({ data: { ownerId: owner.id, title: 'Acme' } });
    await prisma.askMessage.create({
      data: { conversationId: conversation.id, role: 'user', status: 'complete', content: 'What about Acme?' },
    });
    const assistant = await prisma.askMessage.create({
      data: { conversationId: conversation.id, role: 'assistant', status: 'pending' },
    });
    return { owner, conversation, assistant };
  }

  it('tails a live turn written the way ask.respond writes it, ending in done', async () => {
    const { owner, assistant } = await turn('live');
    const answer = 'Acme renewed in March [^ev1]. Two-year term.';

    // Authorised exactly as the controller does it.
    await expect(access.requireMessage(owner.id, assistant.id)).resolves.toMatchObject({ role: 'assistant' });

    const collected = firstValueFrom(streams.stream(assistant.id, 0).pipe(toArray()));

    await tick();
    await prisma.askMessage.update({ where: { id: assistant.id }, data: { status: 'streaming' } });
    await tick();
    await prisma.askMessage.update({ where: { id: assistant.id }, data: { toolCalls: [step(0)] } });
    await tick();
    await prisma.askMessage.update({ where: { id: assistant.id }, data: { toolCalls: [step(0), step(1)] } });
    await tick();
    await prisma.askMessage.update({
      where: { id: assistant.id },
      data: { content: answer.slice(0, 20) },
    });
    await tick();
    await prisma.askMessage.update({
      where: { id: assistant.id },
      data: {
        content: answer,
        status: 'complete',
        finishReason: 'stop',
        promptTokens: 321,
        completionTokens: 12,
        citations: [
          {
            marker: 'ev1',
            kind: 'evidence',
            id: '11111111-1111-4111-8111-111111111111',
            via: null,
            valid: true,
            label: 'Weekly sync',
            documentKind: null,
            startMs: null,
          },
        ],
      },
    });

    const emitted = frames(await collected);

    expect(emitted.filter((m) => m.type === 'step').map((m) => (m.data as { index: number }).index)).toEqual([0, 1]);
    expect(deltas(emitted).join('')).toBe(answer);
    expect(emitted.at(-1)).toMatchObject({
      type: 'done',
      id: String(answer.length),
      data: { finishReason: 'stop', promptTokens: 321, completionTokens: 12, citations: [{ marker: 'ev1' }] },
    });
  });

  it('resumes a settled turn from an offset, re-sending its steps', async () => {
    const { assistant } = await turn('resume');
    const answer = 'First part. Second part.';
    await prisma.askMessage.update({
      where: { id: assistant.id },
      data: { status: 'complete', content: answer, toolCalls: [step(0)] },
    });

    const emitted = frames(await firstValueFrom(streams.stream(assistant.id, 11).pipe(toArray())));

    expect(emitted.map((m) => m.type)).toEqual(['step', 'delta', 'done']);
    expect(deltas(emitted).join('')).toBe(answer.slice(11));
  });

  it('ends with error gone when the conversation is deleted mid-stream (cascade)', async () => {
    const { conversation, assistant } = await turn('gone');
    await prisma.askMessage.update({
      where: { id: assistant.id },
      data: { status: 'streaming', content: 'Looking' },
    });

    const collected = firstValueFrom(streams.stream(assistant.id, 0).pipe(toArray()));
    await tick();
    await prisma.askConversation.delete({ where: { id: conversation.id } });

    const emitted = frames(await collected);

    expect(deltas(emitted)).toEqual(['Looking']);
    expect(emitted.at(-1)?.data).toEqual({ status: 'failed', offset: 7, errorClass: 'gone', reason: 'message_gone' });
  });

  it('carries a stored failure class through', async () => {
    const { assistant } = await turn('failed');
    await prisma.askMessage.update({
      where: { id: assistant.id },
      data: { status: 'failed', errorClass: 'budget' },
    });

    const emitted = frames(await firstValueFrom(streams.stream(assistant.id, 0).pipe(toArray())));

    expect(emitted).toEqual([
      { type: 'error', id: '0', data: { status: 'failed', offset: 0, errorClass: 'budget', reason: null } },
    ]);
  });

  it('never lets another user authorise the message', async () => {
    const { assistant } = await turn('owner');
    const stranger = await createUser(prisma, EMAIL_PREFIX, 'stranger');

    await expect(access.requireMessage(stranger.id, assistant.id)).rejects.toThrow('Message not found');
  });
});
