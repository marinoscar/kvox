// =============================================================================
// Real-Postgres test: saved Ask conversations (issue #376, epic #348)
// =============================================================================
//
// The list/detail queries, the microsecond keyset cursor, the FK behaviours
// and the hand-written partial unique index are all SQL, so they are proven
// against Postgres. Excluded from `npm test`; run by `npm run test:db`.
//
//   - owner isolation: another user's conversation is never listed and is the
//     same 404 as a missing one;
//   - list order (`updated_at DESC, id DESC`), the cursor, the scope filter,
//     `running` and the marker-stripped `lastMessagePreview`;
//   - detail: the newest 100 oldest-first, `hasEarlier`, and `?before=`;
//   - `scope_entity_id` SetNull when the entity is forgotten; `scopeEntity:
//     null` once it is merged;
//   - deleting a conversation cascades its messages (a running turn too) and
//     audits without content; deleting the account cascades its conversations;
//   - `ask_messages_one_running_turn_uniq_idx` refuses a second running turn;
//   - the Danger Zone: `content`/`everything` delete the caller's
//     conversations (and only theirs); `notes` keeps them.
// =============================================================================

import { Prisma, type PrismaClient } from '@prisma/client';

import { AskAccessService } from '../../src/ask/ask-access.service';
import { AskConversationsService } from '../../src/ask/ask-conversations.service';
import { GraphAccessService } from '../../src/graph/access/graph-access.service';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { UserDataPurgeHandler } from '../../src/user-data/handlers/user-data-purge.handler';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { resolveDbSuite } from '../jobs/db-test-support';
import { GraphFixture, cleanupGraphFixtures, connectTestPrisma, createUser } from '../graph/graph-read.fixtures';

const { describeWithDb, dbReachable } = resolveDbSuite('ask-conversations.db.spec');

const EMAIL_PREFIX = 'ask-conversations-test';

describeWithDb('Ask conversations (real Postgres)', () => {
  let prisma: PrismaClient;
  let service: AskConversationsService;

  beforeAll(async () => {
    if (!dbReachable) return;
    prisma = connectTestPrisma();
    await prisma.$connect();
    const p = prisma as unknown as PrismaService;
    service = new AskConversationsService(p, new AskAccessService(p), new GraphAccessService(p));
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  afterEach(async () => {
    if (!dbReachable) return;
    await prisma.auditEvent.deleteMany({ where: { actorUser: { email: { startsWith: EMAIL_PREFIX } } } });
    // ask_conversations (and their messages) go with their owner — Cascade.
    await cleanupGraphFixtures(prisma, EMAIL_PREFIX);
  }, 60_000);

  const owner = (suffix: string) => createUser(prisma, EMAIL_PREFIX, suffix);

  async function message(
    conversationId: string,
    role: 'user' | 'assistant',
    content: string,
    opts: { status?: 'pending' | 'streaming' | 'complete' | 'failed'; createdAt?: Date } = {},
  ) {
    return prisma.askMessage.create({
      data: {
        conversationId,
        role,
        content,
        status: opts.status ?? 'complete',
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      },
    });
  }

  it('isolates owners: never listed, and the same 404 as a missing id', async () => {
    const a = await owner('iso-a');
    const b = await owner('iso-b');
    const conv = await service.create(a.id, { title: 'Mine' });

    await expect(service.list(b.id, { limit: 20 })).resolves.toEqual({ items: [], nextCursor: null });
    const foreign = await service.get(b.id, conv.id, {}).catch((e: Error) => e.message);
    const missing = await service.get(b.id, '00000000-0000-4000-8000-000000000000', {}).catch((e: Error) => e.message);
    expect(foreign).toBe(missing);
    await expect(service.rename(b.id, conv.id, { title: 'Stolen' })).rejects.toThrow(missing as string);
    await expect(service.remove(b.id, conv.id)).rejects.toThrow(missing as string);

    const list = await service.list(a.id, { limit: 20 });
    expect(list.items.map((i) => i.title)).toEqual(['Mine']);
  });

  it('lists newest-updated first, pages with a cursor, filters by scope, and reports running + preview', async () => {
    const user = await owner('list');
    const g = new GraphFixture(prisma, user.id);
    const sarah = await g.entity('Person', 'Sarah Chen');

    const c1 = await service.create(user.id, { title: 'First' });
    const c2 = await service.create(user.id, { title: 'Second', scopeEntityId: sarah });
    const c3 = await service.create(user.id, { title: 'Third' });
    // Same millisecond, different microseconds: the cursor must not skip c1.
    await prisma.$executeRaw`UPDATE ask_conversations SET updated_at = '2026-09-01T10:00:00.000300Z' WHERE id = ${c3.id}::uuid`;
    await prisma.$executeRaw`UPDATE ask_conversations SET updated_at = '2026-09-01T10:00:00.000200Z' WHERE id = ${c2.id}::uuid`;
    await prisma.$executeRaw`UPDATE ask_conversations SET updated_at = '2026-09-01T10:00:00.000100Z' WHERE id = ${c1.id}::uuid`;

    await message(c2.id, 'user', 'Who is Sarah?', { createdAt: new Date('2026-09-01T09:00:00Z') });
    await message(c2.id, 'assistant', 'Sarah[^ent1] leads Atlas.[^ev2]', { createdAt: new Date('2026-09-01T09:00:01Z') });
    await message(c3.id, 'user', 'What changed?', { createdAt: new Date('2026-09-01T09:00:00Z') });
    await message(c3.id, 'assistant', '', { status: 'streaming', createdAt: new Date('2026-09-01T09:00:01Z') });

    const p1 = await service.list(user.id, { limit: 2 });
    expect(p1.items.map((i) => i.id)).toEqual([c3.id, c2.id]);
    expect(p1.items[0]).toMatchObject({ running: true, lastMessagePreview: 'What changed?' });
    expect(p1.items[1]).toMatchObject({
      running: false,
      lastMessagePreview: 'Sarah leads Atlas.',
      scopeEntity: { id: sarah, label: 'Sarah Chen', type: 'Person' },
    });
    expect(p1.nextCursor).not.toBeNull();

    const p2 = await service.list(user.id, { limit: 2, cursor: p1.nextCursor! });
    expect(p2.items.map((i) => i.id)).toEqual([c1.id]);
    expect(p2.items[0]).toMatchObject({ running: false, lastMessagePreview: null });
    expect(p2.nextCursor).toBeNull();

    const scoped = await service.list(user.id, { limit: 20, scopeEntityId: sarah });
    expect(scoped.items.map((i) => i.id)).toEqual([c2.id]);
    await expect(service.list(user.id, { limit: 20, scopeEntityId: sarah, cursor: p1.nextCursor! })).rejects.toThrow(
      'different list',
    );
  });

  it('create refuses a foreign, a missing or a merged scope entity with the entity 404', async () => {
    const user = await owner('scope-404');
    const stranger = await owner('scope-404-b');
    const theirs = await new GraphFixture(prisma, stranger.id).entity('Person', 'Not yours');
    const g = new GraphFixture(prisma, user.id);
    const survivor = await g.entity('Person', 'Survivor');
    const tombstone = await g.entity('Person', 'Tombstone', { reviewStatus: 'merged', mergedIntoId: survivor });

    for (const id of [theirs, tombstone, '00000000-0000-4000-8000-000000000000']) {
      await expect(service.create(user.id, { scopeEntityId: id })).rejects.toThrow('Entity not found');
    }
    expect(await prisma.askConversation.count({ where: { ownerId: user.id } })).toBe(0);
  });

  it('keeps the conversation when its scope entity is forgotten (SetNull) or merged (null scope)', async () => {
    const user = await owner('scope-null');
    const g = new GraphFixture(prisma, user.id);
    const forgotten = await g.entity('Person', 'Forgotten');
    const merged = await g.entity('Person', 'Merged');
    const survivor = await g.entity('Person', 'Survivor');
    const a = await service.create(user.id, { scopeEntityId: forgotten });
    const b = await service.create(user.id, { scopeEntityId: merged });

    await prisma.kgEntity.delete({ where: { id: forgotten } });
    await prisma.kgEntity.update({ where: { id: merged }, data: { reviewStatus: 'merged', mergedIntoId: survivor } });

    const rowA = await prisma.askConversation.findUniqueOrThrow({ where: { id: a.id } });
    expect(rowA.scopeEntityId).toBeNull();
    await expect(service.get(user.id, a.id, {})).resolves.toMatchObject({ scopeEntity: null });
    await expect(service.get(user.id, b.id, {})).resolves.toMatchObject({ scopeEntity: null });
  });

  it('detail returns the newest 100 oldest-first with hasEarlier, and ?before= pages older ones', async () => {
    const user = await owner('paging');
    const conv = await service.create(user.id, {});
    const base = Date.UTC(2026, 8, 1, 0, 0, 0);
    await prisma.askMessage.createMany({
      data: Array.from({ length: 105 }, (_, i) => ({
        conversationId: conv.id,
        role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: `m${i}`,
        status: 'complete' as const,
        createdAt: new Date(base + i * 1000),
      })),
    });

    const newest = await service.get(user.id, conv.id, {});
    expect(newest.messages).toHaveLength(100);
    expect(newest.hasEarlier).toBe(true);
    expect(newest.messages[0].content).toBe('m5');
    expect(newest.messages[99].content).toBe('m104');

    const older = await service.get(user.id, conv.id, { before: newest.messages[0].id });
    expect(older.messages.map((m) => m.content)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    expect(older.hasEarlier).toBe(false);

    const other = await service.create(user.id, {});
    const stray = await message(other.id, 'user', 'elsewhere');
    await expect(service.get(user.id, conv.id, { before: stray.id })).rejects.toThrow('does not name a message');
  });

  it('allows one running assistant turn per conversation — the partial unique index', async () => {
    const user = await owner('uniq');
    const conv = await service.create(user.id, {});
    const other = await service.create(user.id, {});

    const first = await message(conv.id, 'assistant', '', { status: 'pending' });
    await expect(message(conv.id, 'assistant', '', { status: 'pending' })).rejects.toMatchObject({ code: 'P2002' });
    await expect(message(conv.id, 'assistant', '', { status: 'streaming' })).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    );
    // User messages, finished turns and other conversations are not constrained.
    await message(conv.id, 'user', 'follow-up', { status: 'pending' });
    await message(conv.id, 'assistant', 'done', { status: 'complete' });
    await message(other.id, 'assistant', '', { status: 'pending' });

    await prisma.askMessage.update({ where: { id: first.id }, data: { status: 'failed' } });
    await expect(message(conv.id, 'assistant', '', { status: 'pending' })).resolves.toBeDefined();

    const indexes = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'ask_messages_one_running_turn_uniq_idx'`;
    expect(indexes).toHaveLength(1);
    expect(indexes[0].indexdef).toContain('UNIQUE');
  });

  it('delete cascades the messages — a running turn included — and audits counts only', async () => {
    const user = await owner('delete');
    const g = new GraphFixture(prisma, user.id);
    const sarah = await g.entity('Person', 'Sarah Chen');
    const conv = await service.create(user.id, { scopeEntityId: sarah });
    await message(conv.id, 'user', 'A private question about Sarah');
    await message(conv.id, 'assistant', 'A private answer', { status: 'streaming' });

    await service.remove(user.id, conv.id);

    expect(await prisma.askConversation.count({ where: { id: conv.id } })).toBe(0);
    expect(await prisma.askMessage.count({ where: { conversationId: conv.id } })).toBe(0);
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { actorUserId: user.id, action: 'ask.conversation_deleted' },
    });
    expect(audit).toMatchObject({ targetType: 'ask_conversation', targetId: conv.id });
    expect(audit.meta).toEqual({ messageCount: 2, scopeEntityId: sarah });
    expect(JSON.stringify(audit.meta)).not.toContain('private');
  });

  it('rename rewrites the title; a deleted account takes its conversations with it', async () => {
    const user = await owner('rename');
    const conv = await service.create(user.id, {});
    await message(conv.id, 'user', 'hello');

    await expect(service.rename(user.id, conv.id, { title: 'Renamed' })).resolves.toMatchObject({
      id: conv.id,
      title: 'Renamed',
      lastMessagePreview: 'hello',
    });

    await prisma.user.delete({ where: { id: user.id } });
    expect(await prisma.askConversation.count({ where: { id: conv.id } })).toBe(0);
    expect(await prisma.askMessage.count({ where: { conversationId: conv.id } })).toBe(0);
  });

  describe('the Danger Zone `ask` category (user.data.purge against real rows)', () => {
    // Real Prisma; every other collaborator mocked — the same harness shape as
    // `user-data-purge.handler.spec.ts`. The owners here have no notes,
    // transcripts or files, so the other steps find nothing to do.
    function purgeHandler() {
      const ok = () => jest.fn().mockResolvedValue(undefined);
      return new UserDataPurgeHandler(
        new JobHandlerRegistry(),
        prisma as never,
        { enqueuePurge: ok() } as never,
        { remove: ok() } as never,
        { enqueuePurge: ok() } as never,
        { delete: ok() } as never,
        { revokeAllForUser: jest.fn().mockResolvedValue(0) } as never,
        { removeAll: jest.fn().mockResolvedValue(0) } as never,
        { forget: ok(), forgetOwnerDocuments: jest.fn().mockResolvedValue(0) } as never,
        { patchSettings: jest.fn().mockResolvedValue({}) } as never,
        { enqueue: jest.fn().mockResolvedValue({ id: 'kg-job', status: 'pending' }) } as never,
      );
    }
    const purge = (userId: string, scope: string) =>
      purgeHandler().process({ id: `job-${userId}`, payload: { userId, scope } } as never);

    it.each(['content', 'everything'])('scope "%s" deletes the caller\'s conversations and messages only', async (scope) => {
      const user = await owner(`dz-${scope}`);
      const bystander = await owner(`dz-${scope}-b`);
      const mine = await service.create(user.id, {});
      await message(mine.id, 'user', 'q');
      const theirs = await service.create(bystander.id, {});

      await purge(user.id, scope);

      expect(await prisma.askConversation.count({ where: { ownerId: user.id } })).toBe(0);
      expect(await prisma.askMessage.count({ where: { conversationId: mine.id } })).toBe(0);
      expect(await prisma.askConversation.count({ where: { id: theirs.id } })).toBe(1);
    });

    it('scope "notes" keeps them', async () => {
      const user = await owner('dz-notes');
      await service.create(user.id, {});

      await purge(user.id, 'notes');

      expect(await prisma.askConversation.count({ where: { ownerId: user.id } })).toBe(1);
    });
  });
});
