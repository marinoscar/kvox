import { randomUUID } from 'node:crypto';

import { ConflictException, NotFoundException } from '@nestjs/common';

import {
  ASK_CONVERSATION_NOT_FOUND,
  ASK_RESPOND_JOB_TYPE,
  AskAccessService,
  AskConversationsService,
  resolveAskOptions,
} from '../src/ask/index.js';
import { AskMessagesService } from '../src/ask/ask-messages.service.js';
import { AskRespondHandler } from '../src/ask/handlers/ask-respond.handler.js';
import { createScriptedChat, step, text } from '../src/ask/testing/index.js';
import type { AskToolset } from '../src/ask/tools/ask-toolset.js';
import { HandleRegistry } from '../src/ask/tools/handle-registry.js';
import { GraphAccessService, GraphAiRunResolver } from '../src/graph/index.js';
import type { KvoxJob, KvoxSettingsPort } from '../src/ports/index.js';
import { OwnerOnlyTranscriptVisibility } from '../src/search/index.js';
import { createFakeKvoxJobs, createRecordingKvoxAudit } from '../src/testing/index.js';
import { createTestDb, type TestDb } from './host/db.js';

// =============================================================================
// Ask on the test host: a real PostgreSQL, no platform (issue #497, epic #491)
// =============================================================================
//
// What only a database can prove, run against the migrated test host with the OWNER-ONLY defaults of
// the slice (sharing and row-level security are the web edition's and stay in the application's db
// specs):
//
//   • the conversation list/detail SQL (order, the microsecond cursor key, `running`, the marker-stripped
//     preview) and owner isolation: another user's conversation is the SAME 404 as a missing one;
//   • `ask_messages_one_running_turn_uniq_idx`: two concurrent questions let exactly one through, and the
//     loser's transaction rolls back whole;
//   • a whole turn through the real handler (scripted model, stub toolset): the answer, citations and
//     tokens land in the row, and the conversation's `updated_at` moves;
//   • deleting a conversation cascades its messages, records the audit event with counts only, and a turn
//     whose conversation vanished before the job ran is a no-op.
//
// Needs `npm run test:host:prepare -w @marinoscar/kvox-api` and PostgreSQL 16 with pgvector; run by
// `npm run test:db -w @marinoscar/kvox-api -- ask`.
// =============================================================================

const ANSWER = 'Acme renewed in March, according to the sync you recorded last week and the notes that followed it.';

describe('Ask (real PostgreSQL, owner-only defaults)', () => {
  let db: TestDb;
  let access: AskAccessService;
  let conversations: AskConversationsService;
  let messages: AskMessagesService;
  let handler: AskRespondHandler;
  let jobs: ReturnType<typeof createFakeKvoxJobs>;
  let audit: ReturnType<typeof createRecordingKvoxAudit>;
  let chat: ReturnType<typeof createScriptedChat>;

  const user = async (): Promise<string> => (await db.prisma.user.create({ data: { email: `ask-${randomUUID()}@example.test` } })).id;
  const job = (messageId: string, userId: string, conversationId: string): KvoxJob => ({
    id: randomUUID(),
    type: ASK_RESPOND_JOB_TYPE,
    subjectType: 'ask_message',
    subjectId: messageId,
    payload: { assistantMessageId: messageId, conversationId, userId, model: 'scripted-model', providerId: 'openai' },
    attempts: 0,
    orgId: null,
  });

  beforeAll(async () => {
    db = await createTestDb();
    const client = db.prisma as never;
    jobs = createFakeKvoxJobs();
    // `ask_messages.job_id` is a foreign key to the queue's table, so the job is a real row inside the caller's transaction.
    const queue = {
      ...jobs,
      enqueueWithin: async (
        tx: { job: { create(args: { data: Record<string, unknown> }): Promise<{ id: string }> } },
        input: { type: string; subjectType?: string; subjectId?: string; priority?: number; payload: Record<string, unknown> },
      ) => {
        const row = await tx.job.create({
          data: { type: input.type, reason: 'upload', subjectType: input.subjectType, subjectId: input.subjectId, priority: input.priority ?? 0, payload: input.payload },
        });
        await jobs.enqueue({ ...input, skipDedup: true });

        return { id: row.id, deduplicated: false };
      },
    } as unknown as typeof jobs;
    audit = createRecordingKvoxAudit();
    chat = createScriptedChat();
    const settings = {
      registerNamespace: () => undefined,
      readSystem: async () => ({ value: { graphEnabled: true }, version: 1 }),
    } as unknown as KvoxSettingsPort;
    const ai = { ...chat, chat: chat.chat.bind(chat), resolveTask: chat.resolveTask.bind(chat), capabilities: chat.capabilities.bind(chat), countTokens: chat.countTokens.bind(chat) } as never;
    const resolver = new GraphAiRunResolver(ai, settings);

    access = new AskAccessService(client);
    conversations = new AskConversationsService(client, access, new GraphAccessService(client), audit);
    messages = new AskMessagesService(client, access, resolver, queue);
    const toolset = {
      definitions: () => [{ name: 'search', description: 'Search', parameters: { type: 'object', properties: {} } }],
      createContext: async (actor: { id: string }) => ({ user: actor, handles: new HandleRegistry(), personalFactsAllowed: false, scopeEntityId: null, now: new Date() }),
      execute: async () => ({ ok: true as const, result: { data: {}, resultCount: 0, summary: 'Nothing', truncated: false }, json: '{}' }),
    } as unknown as AskToolset;
    handler = new AskRespondHandler(
      jobs,
      client,
      ai,
      { hasPermission: async () => true, authenticate: async () => null },
      resolver,
      toolset,
      new OwnerOnlyTranscriptVisibility(client),
      resolveAskOptions(),
    );
  });

  afterAll(async () => {
    await db.dispose();
  });

  beforeEach(() => {
    chat.reset();
    audit.recorded.length = 0;
  });

  it('isolates owners: another user\'s conversation is never listed and is the same 404 as a missing one', async () => {
    const [a, b] = [await user(), await user()];
    const mine = await conversations.create(a, { title: 'Acme' });

    expect((await conversations.list(b, { limit: 20 })).items).toEqual([]);
    expect((await conversations.list(a, { limit: 20 })).items.map((c) => c.id)).toEqual([mine.id]);

    const foreign = await conversations.get(b, mine.id, {}).catch((e: Error) => e);
    const missing = await conversations.get(b, randomUUID(), {}).catch((e: Error) => e);
    expect(foreign).toBeInstanceOf(NotFoundException);
    expect((foreign as Error).message).toBe(ASK_CONVERSATION_NOT_FOUND);
    expect((missing as Error).message).toBe((foreign as Error).message);
  });

  it('lists newest first with a marker-stripped preview and the running flag, and pages by cursor', async () => {
    const owner = await user();
    const older = await conversations.create(owner, { title: 'Older' });
    const newer = await conversations.create(owner, { title: 'Newer' });
    await db.prisma.askMessage.create({ data: { conversationId: older.id, role: 'user', content: 'Who runs Acme?', status: 'complete' } });
    await db.prisma.askMessage.create({ data: { conversationId: older.id, role: 'assistant', content: 'Sarah runs Acme.[^ent1]', status: 'complete' } });
    await db.prisma.askMessage.create({ data: { conversationId: newer.id, role: 'user', content: 'Still working?', status: 'complete' } });
    await db.prisma.askMessage.create({ data: { conversationId: newer.id, role: 'assistant', status: 'streaming' } });
    await db.prisma.askConversation.update({ where: { id: newer.id }, data: { updatedAt: new Date(Date.now() + 5_000) } });

    const page = await conversations.list(owner, { limit: 1 });
    expect(page.items.map((c) => [c.title, c.running])).toEqual([['Newer', true]]);
    expect(page.nextCursor).not.toBeNull();

    const next = await conversations.list(owner, { limit: 1, cursor: page.nextCursor ?? undefined });
    expect(next.items.map((c) => [c.title, c.running, c.lastMessagePreview])).toEqual([['Older', false, 'Sarah runs Acme.']]);
    expect(next.nextCursor).toBeNull();

    const detail = await conversations.get(owner, older.id, {});
    expect(detail.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(detail.hasEarlier).toBe(false);
  });

  it('lets exactly one of two concurrent questions through (409 ask_turn_running, index-enforced)', async () => {
    const owner = await user();
    const conv = await conversations.create(owner, {});
    chat.enqueue(step([text(ANSWER)]));

    const results = await Promise.allSettled([
      messages.post(owner, conv.id, { content: 'First?' }),
      messages.post(owner, conv.id, { content: 'Second?' }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictException);
    expect(JSON.stringify((rejected[0].reason as ConflictException).getResponse())).toContain('ask_turn_running');
    // The loser rolled back whole: one question, one answer.
    expect(await db.prisma.askMessage.count({ where: { conversationId: conv.id } })).toBe(2);
  });

  it('runs a whole turn: the answer, tokens and finish reason land in the row and the title is derived', async () => {
    const owner = await user();
    const conv = await conversations.create(owner, {});
    const posted = await messages.post(owner, conv.id, { content: 'When   did Acme renew?' });
    expect(posted.assistantMessage).toMatchObject({ status: 'pending', model: 'scripted-model' });
    expect(jobs.jobs.at(-1)?.input).toMatchObject({ type: ASK_RESPOND_JOB_TYPE, subjectId: posted.assistantMessage.id, priority: -10 });

    chat.enqueue({ events: [text(ANSWER)], usage: { inputTokens: 120, outputTokens: 30 } });
    await handler.process(job(posted.assistantMessage.id, owner, conv.id));

    const row = await db.prisma.askMessage.findUniqueOrThrow({ where: { id: posted.assistantMessage.id } });
    expect(row).toMatchObject({ status: 'complete', content: ANSWER, finishReason: 'stop', promptTokens: 120, completionTokens: 30, errorClass: null });
    expect((await db.prisma.askConversation.findUniqueOrThrow({ where: { id: conv.id } })).title).toBe('When did Acme renew?');
  });

  it('deletes a conversation with its messages, audits counts only, and a turn whose conversation vanished is a no-op', async () => {
    const owner = await user();
    const conv = await conversations.create(owner, {});
    const posted = await messages.post(owner, conv.id, { content: 'private question' });

    await conversations.remove(owner, conv.id);

    expect(await db.prisma.askMessage.count({ where: { conversationId: conv.id } })).toBe(0);
    expect(audit.recorded).toEqual([
      expect.objectContaining({
        actorUserId: owner,
        action: 'ask.conversation_deleted',
        targetType: 'ask_conversation',
        targetId: conv.id,
        meta: { messageCount: 2, scopeEntityId: null },
      }),
    ]);
    expect(JSON.stringify(audit.recorded)).not.toContain('private question');

    const calls = chat.requests.length;
    await expect(handler.process(job(posted.assistantMessage.id, owner, conv.id))).resolves.toBeUndefined();
    expect(chat.requests).toHaveLength(calls);
  });

  it('keeps the other owner\'s conversation when an account\'s data is deleted', async () => {
    const [a, b] = [await user(), await user()];
    const mine = await conversations.create(a, {});
    const theirs = await conversations.create(b, {});
    await db.prisma.askMessage.create({ data: { conversationId: mine.id, role: 'user', content: 'q', status: 'complete' } });

    const { AskUserDataService } = await import('../src/ask/index.js');
    await expect(new AskUserDataService(db.prisma as never).deleteAll(a)).resolves.toEqual({ conversations: 1, messages: 1 });
    expect(await db.prisma.askConversation.count({ where: { id: theirs.id } })).toBe(1);
  });
});
