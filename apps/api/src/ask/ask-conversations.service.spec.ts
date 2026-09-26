// =============================================================================
// AskConversationsService — the pure mapping and the service's own decisions
// (issue #376, epic #348)
// =============================================================================
//
// The SQL is proven against Postgres in `test/ask/ask-conversations.db.spec.ts`;
// this file pins what needs no database: title/preview mapping, citation
// marker stripping, the running flag, the cursor round trip (and its refusals),
// row → wire message mapping, and the create/delete decisions around the
// access checks and the audit.
// =============================================================================

import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { GRAPH_NOT_FOUND_MESSAGES } from '../graph/access/graph-access.service';
import { AskAccessService, ASK_CONVERSATION_NOT_FOUND, ASK_MESSAGE_NOT_FOUND } from './ask-access.service';
import {
  ASK_CONVERSATION_DELETED_ACTION,
  AskConversationsService,
  toAskConversationSummary,
  type AskSummaryRow,
} from './ask-conversations.service';
import { AskCursorError, decodeAskCursor, encodeAskCursor } from './ask-cursor';
import { previewText, stripCitationMarkers, toAskMessage, type AskMessageRow } from './ask-message.mapper';
import { askConversationSummarySchema, askMessageSchema } from './dto/ask.dto';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CONV = '33333333-3333-4333-8333-333333333333';
const ENTITY = '44444444-4444-4444-8444-444444444444';
const MSG = '55555555-5555-4555-8555-555555555555';

const summaryRow = (overrides: Partial<AskSummaryRow> = {}): AskSummaryRow => ({
  id: CONV,
  title: 'Who owns Atlas?',
  createdAt: new Date('2026-09-01T10:00:00.000Z'),
  updatedAt: new Date('2026-09-02T10:00:00.000Z'),
  cursorKey: '2026-09-02T10:00:00.123456Z',
  scopeId: null,
  scopeLabel: null,
  scopeType: null,
  preview: null,
  running: false,
  ...overrides,
});

const messageRow = (overrides: Partial<AskMessageRow> = {}): AskMessageRow => ({
  id: MSG,
  conversationId: CONV,
  role: 'assistant',
  content: 'Sarah owns it.[^ev1]',
  status: 'complete',
  toolCalls: [],
  citations: [],
  model: 'gpt-x',
  provider: 'openai',
  promptTokens: 10,
  completionTokens: 5,
  errorClass: null,
  finishReason: 'stop',
  createdAt: new Date('2026-09-02T10:00:00.000Z'),
  ...overrides,
});

describe('citation markers', () => {
  it('strips every marker kind and nothing else', () => {
    expect(stripCitationMarkers('A[^ev7] B[^ent2] C[^doc1] D[^itm3] E[^rel4] F[^foo1] [ev9]')).toBe(
      'A B C D E F[^foo1] [ev9]',
    );
  });

  it('previews: markers stripped, whitespace collapsed, capped at 140 with an ellipsis', () => {
    expect(previewText('  Sarah[^ev1]\n\n owns   Atlas[^ent2]. ')).toBe('Sarah owns Atlas.');
    const long = previewText('word '.repeat(100));
    expect(long).not.toBeNull();
    expect(long!.length).toBeLessThanOrEqual(140);
    expect(long!.endsWith('…')).toBe(true);
    expect(previewText('x'.repeat(140))).toBe('x'.repeat(140));
  });

  it('previews nothing for empty or marker-only text', () => {
    expect(previewText(null)).toBeNull();
    expect(previewText('')).toBeNull();
    expect(previewText('[^ev1] [^ent2]')).toBeNull();
  });
});

describe('toAskConversationSummary', () => {
  it('maps title, timestamps, running and a null scope; conforms to the wire schema', () => {
    const s = toAskConversationSummary(summaryRow({ running: true, preview: 'It is Sarah.[^ev3]' }));
    expect(s).toEqual({
      id: CONV,
      title: 'Who owns Atlas?',
      scopeEntity: null,
      lastMessagePreview: 'It is Sarah.',
      running: true,
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-02T10:00:00.000Z',
    });
    expect(askConversationSummarySchema.safeParse(s).success).toBe(true);
  });

  it('carries the live scope entity, and a null title before the first message', () => {
    const s = toAskConversationSummary(
      summaryRow({ title: null, scopeId: ENTITY, scopeLabel: 'Sarah Chen', scopeType: 'Person' }),
    );
    expect(s.title).toBeNull();
    expect(s.scopeEntity).toEqual({ id: ENTITY, label: 'Sarah Chen', type: 'Person' });
    expect(s.running).toBe(false);
  });
});

describe('toAskMessage', () => {
  it('maps a row to the wire shape', () => {
    const m = toAskMessage(
      messageRow({
        toolCalls: [
          { index: 0, name: 'find_entities', arguments: { q: 'Atlas' }, summary: 'Looked up Atlas', resultCount: 1, durationMs: 12, error: null },
        ],
        citations: [
          { marker: 'ev1', kind: 'evidence', id: ENTITY, via: null, valid: true, label: 'Weekly sync', documentKind: 'transcript', startMs: 1200 },
        ],
      }),
    );
    expect(askMessageSchema.safeParse(m).success).toBe(true);
    expect(m.createdAt).toBe('2026-09-02T10:00:00.000Z');
    expect(m.toolCalls).toHaveLength(1);
    expect(m.citations[0].marker).toBe('ev1');
    expect(m.content).toBe('Sarah owns it.[^ev1]'); // the stored text keeps its markers
  });

  it('drops malformed JSONB elements rather than failing the read', () => {
    const m = toAskMessage(messageRow({ toolCalls: [{ nope: true }] as never, citations: 'garbage' as never }));
    expect(m.toolCalls).toEqual([]);
    expect(m.citations).toEqual([]);
  });
});

describe('the conversation-list cursor', () => {
  const scope = { userId: USER, scopeEntityId: null };

  it('round-trips the microsecond key and the id', () => {
    const cursor = encodeAskCursor(scope, { k: '2026-09-02T10:00:00.123456Z', id: CONV });
    expect(decodeAskCursor(cursor, scope)).toEqual({ k: '2026-09-02T10:00:00.123456Z', id: CONV });
  });

  it('refuses a cursor minted for another caller or another scope filter', () => {
    const cursor = encodeAskCursor(scope, { k: '2026-09-02T10:00:00Z', id: CONV });
    expect(() => decodeAskCursor(cursor, { userId: OTHER, scopeEntityId: null })).toThrow('different list');
    expect(() => decodeAskCursor(cursor, { userId: USER, scopeEntityId: ENTITY })).toThrow(AskCursorError);
  });

  it.each([
    ['not base64 JSON', '%%%'],
    ['an array', Buffer.from('[]').toString('base64url')],
    ['another version', Buffer.from(JSON.stringify({ v: 99 })).toString('base64url')],
  ])('refuses %s', (_label, cursor) => {
    expect(() => decodeAskCursor(cursor, scope)).toThrow(AskCursorError);
  });

  it('refuses a tampered key or id even under the right fingerprint', () => {
    const good = JSON.parse(
      Buffer.from(encodeAskCursor(scope, { k: '2026-09-02T10:00:00Z', id: CONV }), 'base64url').toString(),
    );
    const tamper = (patch: object) => Buffer.from(JSON.stringify({ ...good, ...patch })).toString('base64url');
    expect(() => decodeAskCursor(tamper({ k: "2026'; DROP TABLE x;--" }), scope)).toThrow(AskCursorError);
    expect(() => decodeAskCursor(tamper({ id: 'not-a-uuid' }), scope)).toThrow(AskCursorError);
  });
});

describe('AskConversationsService', () => {
  function harness() {
    const tx = {
      askMessage: { count: jest.fn().mockResolvedValue(3) },
      askConversation: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
      auditEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      askConversation: {
        findFirst: jest.fn().mockResolvedValue({ id: CONV, ownerId: USER, scopeEntityId: ENTITY }),
        create: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      askMessage: { findFirst: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const graphAccess = { require: jest.fn() };
    const access = new AskAccessService(prisma as never);
    const service = new AskConversationsService(prisma as never, access, graphAccess as never);
    return { service, prisma, tx, graphAccess };
  }

  it('create: an unscoped conversation is running: false with no preview', async () => {
    const { service, prisma, graphAccess } = harness();
    const now = new Date('2026-09-02T10:00:00.000Z');
    prisma.askConversation.create.mockResolvedValue({ id: CONV, title: null, createdAt: now, updatedAt: now });

    const s = await service.create(USER, {});

    expect(graphAccess.require).not.toHaveBeenCalled();
    expect(prisma.askConversation.create).toHaveBeenCalledWith({
      data: { ownerId: USER, title: null, scopeEntityId: null },
    });
    expect(s).toMatchObject({ id: CONV, title: null, scopeEntity: null, running: false, lastMessagePreview: null });
  });

  it('create: the scope is authorised through GraphAccessService, and its 404 passes through', async () => {
    const { service, prisma, graphAccess } = harness();
    graphAccess.require.mockRejectedValue(new NotFoundException(GRAPH_NOT_FOUND_MESSAGES.entity));

    await expect(service.create(USER, { scopeEntityId: ENTITY })).rejects.toThrow(GRAPH_NOT_FOUND_MESSAGES.entity);
    expect(graphAccess.require).toHaveBeenCalledWith(USER, 'entity', ENTITY, 'view');
    expect(prisma.askConversation.create).not.toHaveBeenCalled();
  });

  it('create: an entity forgotten between the check and the insert is the entity 404, not a 500', async () => {
    const { service, prisma, graphAccess } = harness();
    graphAccess.require.mockResolvedValue({ id: ENTITY, label: 'Sarah', type: 'Person' });
    prisma.askConversation.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('fk', { code: 'P2003', clientVersion: 'test' }),
    );

    await expect(service.create(USER, { scopeEntityId: ENTITY })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('get/rename/delete: a foreign or missing conversation is the same 404, before anything else runs', async () => {
    const { service, prisma, tx } = harness();
    prisma.askConversation.findFirst.mockResolvedValue(null);

    await expect(service.get(USER, CONV, {})).rejects.toThrow(ASK_CONVERSATION_NOT_FOUND);
    await expect(service.rename(USER, CONV, { title: 'x' })).rejects.toThrow(ASK_CONVERSATION_NOT_FOUND);
    await expect(service.remove(USER, CONV)).rejects.toThrow(ASK_CONVERSATION_NOT_FOUND);
    expect(prisma.askConversation.findFirst).toHaveBeenCalledWith({ where: { id: CONV, ownerId: USER } });
    expect(prisma.askConversation.updateMany).not.toHaveBeenCalled();
    expect(tx.askConversation.deleteMany).not.toHaveBeenCalled();
  });

  it('get: `before` must name a message in this conversation (400)', async () => {
    const { service, prisma } = harness();
    prisma.$queryRaw.mockResolvedValueOnce([summaryRow()]);
    prisma.askMessage.findFirst.mockResolvedValue(null);

    await expect(service.get(USER, CONV, { before: MSG })).rejects.toThrow('does not name a message');
    expect(prisma.askMessage.findFirst).toHaveBeenCalledWith({
      where: { id: MSG, conversationId: CONV },
      select: { id: true },
    });
  });

  it('get: returns the newest 100 oldest-first, with hasEarlier when a 101st exists', async () => {
    const { service, prisma } = harness();
    const rows = Array.from({ length: 101 }, (_, i) =>
      messageRow({ id: `00000000-0000-4000-8000-${String(1000 - i).padStart(12, '0')}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 101 - i)) }),
    );
    prisma.$queryRaw.mockResolvedValueOnce([summaryRow()]).mockResolvedValueOnce(rows);

    const detail = await service.get(USER, CONV, {});

    expect(detail.hasEarlier).toBe(true);
    expect(detail.messages).toHaveLength(100);
    expect(detail.messages[0].createdAt < detail.messages[99].createdAt).toBe(true);
    expect('lastMessagePreview' in detail).toBe(false);
  });

  it('list: a cursor from another filter is a 400, before the query runs', async () => {
    const { service, prisma } = harness();
    const cursor = encodeAskCursor({ userId: USER, scopeEntityId: null }, { k: '2026-09-02T10:00:00Z', id: CONV });

    await expect(service.list(USER, { limit: 20, cursor, scopeEntityId: ENTITY })).rejects.toThrow('different list');
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('list: mints a cursor from the last row\'s microsecond key only when there is another page', async () => {
    const { service, prisma } = harness();
    const second = '66666666-6666-4666-8666-666666666666';
    prisma.$queryRaw.mockResolvedValueOnce([summaryRow(), summaryRow({ id: second, cursorKey: '2026-09-01T00:00:00.000001Z' })]);

    const page = await service.list(USER, { limit: 1 });

    expect(page.items.map((i) => i.id)).toEqual([CONV]);
    expect(decodeAskCursor(page.nextCursor!, { userId: USER, scopeEntityId: null })).toEqual({
      k: '2026-09-02T10:00:00.123456Z',
      id: CONV,
    });

    prisma.$queryRaw.mockResolvedValueOnce([summaryRow()]);
    await expect(service.list(USER, { limit: 1 })).resolves.toMatchObject({ nextCursor: null });
  });

  it('remove: deletes by owner and audits counts and ids only — never content', async () => {
    const { service, tx } = harness();

    await service.remove(USER, CONV);

    expect(tx.askConversation.deleteMany).toHaveBeenCalledWith({ where: { id: CONV, ownerId: USER } });
    expect(tx.auditEvent.create).toHaveBeenCalledWith({
      data: {
        actorUserId: USER,
        action: ASK_CONVERSATION_DELETED_ACTION,
        targetType: 'ask_conversation',
        targetId: CONV,
        meta: { messageCount: 3, scopeEntityId: ENTITY },
      },
    });
    expect(ASK_CONVERSATION_DELETED_ACTION).toBe('ask.conversation_deleted');
  });
});

describe('AskAccessService.requireMessage', () => {
  it('joins through the conversation owner, and a malformed id is the same 404 without a query', async () => {
    const prisma = { askMessage: { findFirst: jest.fn().mockResolvedValue(null) } };
    const access = new AskAccessService(prisma as never);

    await expect(access.requireMessage(USER, MSG)).rejects.toThrow(ASK_MESSAGE_NOT_FOUND);
    expect(prisma.askMessage.findFirst).toHaveBeenCalledWith({
      where: { id: MSG, conversation: { ownerId: USER } },
      include: { conversation: true },
    });

    prisma.askMessage.findFirst.mockClear();
    await expect(access.requireMessage(USER, 'nope')).rejects.toThrow(ASK_MESSAGE_NOT_FOUND);
    expect(prisma.askMessage.findFirst).not.toHaveBeenCalled();
  });
});
