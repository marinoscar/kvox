import { randomUUID } from 'node:crypto';

import type { AskConversationRow, AskMessageDbRow, KvoxAskDb } from '../data/ask-db.js';

// =============================================================================
// An in-memory copy of the tables the Ask turn writes (issue #497, epic #491)
// =============================================================================
//
// Enough of `KvoxAskDb` for `AskRespondHandler` to run a turn without a database: the two Ask
// tables, the scope-entity read, `$transaction` and `$queryRaw`. It understands exactly the
// filters the handler uses (`id`, `status`, `{ in }`, `{ lte }`, a nested `conversation.ownerId`)
// and nothing else: a new filter shape fails loudly instead of matching by accident.
//
// DELETING A CONVERSATION CASCADES TO ITS MESSAGES, as the foreign key does, so the "deleted
// mid-turn" rule is testable: the turn's next `WHERE status = 'streaming'` write finds no row.
// =============================================================================

/**
 * An entity the scope lookup can find.
 *
 * @stability experimental
 */
export interface InMemoryAskEntity {
  /** The entity id. */
  id: string;
  /** Its label. */
  label: string;
  /** Its type key. */
  type: string;
}

/**
 * The in-memory Ask tables.
 *
 * @stability experimental
 */
export interface InMemoryAskDb {
  /** The client the handler and services are given. */
  readonly db: KvoxAskDb;
  /** Every conversation row. */
  readonly conversations: Map<string, AskConversationRow>;
  /** Every message row. */
  readonly messages: Map<string, AskMessageDbRow>;
  /** Entities the scope lookup finds, by id. */
  readonly entities: Map<string, InMemoryAskEntity>;
  /** Adds a conversation. */
  addConversation(over?: Partial<AskConversationRow>): AskConversationRow;
  /** Adds a message. */
  addMessage(over: Partial<AskMessageDbRow> & Pick<AskMessageDbRow, 'conversationId' | 'role'>): AskMessageDbRow;
  /** Deletes a conversation and, with it, its messages. */
  deleteConversation(id: string): void;
}

type Where = Record<string, unknown>;

function matches(row: Record<string, unknown>, where: Where | undefined, db: InMemoryAskDb): boolean {
  if (!where) return true;

  return Object.entries(where).every(([key, wanted]) => {
    if (key === 'conversation') {
      const conversation = db.conversations.get(row.conversationId as string);

      return conversation !== undefined && matches(conversation as unknown as Record<string, unknown>, wanted as Where, db);
    }
    const actual = row[key];
    if (wanted !== null && typeof wanted === 'object' && !(wanted instanceof Date)) {
      const filter = wanted as Record<string, unknown>;
      if ('in' in filter) return (filter.in as unknown[]).includes(actual);
      if ('lte' in filter) return (actual as Date).getTime() <= (filter.lte as Date).getTime();
      throw new Error(`in-memory Ask db: unsupported filter on "${key}": ${JSON.stringify(Object.keys(filter))}`);
    }

    return actual === wanted;
  });
}

/**
 * Builds the in-memory Ask tables.
 *
 * @returns the tables and the client over them.
 * @stability experimental
 */
export function createInMemoryAskDb(): InMemoryAskDb {
  const conversations = new Map<string, AskConversationRow>();
  const messages = new Map<string, AskMessageDbRow>();
  const entities = new Map<string, InMemoryAskEntity>();
  let tick = 0;

  const store: InMemoryAskDb = {
    conversations,
    messages,
    entities,
    db: undefined as unknown as KvoxAskDb,

    addConversation(over = {}) {
      const now = new Date(Date.UTC(2026, 8, 26, 10, 0, 0) + tick++);
      const row: AskConversationRow = {
        id: randomUUID(),
        ownerId: randomUUID(),
        title: null,
        scopeEntityId: null,
        createdAt: now,
        updatedAt: now,
        ...over,
      };
      conversations.set(row.id, row);

      return row;
    },

    addMessage(over) {
      const row: AskMessageDbRow = {
        id: randomUUID(),
        content: '',
        status: over.role === 'user' ? 'complete' : 'pending',
        toolCalls: [],
        citations: [],
        model: null,
        provider: null,
        promptTokens: null,
        completionTokens: null,
        errorClass: null,
        finishReason: null,
        jobId: null,
        createdAt: new Date(Date.UTC(2026, 8, 26, 10, 0, 0) + tick++),
        ...over,
      };
      messages.set(row.id, row);

      return row;
    },

    deleteConversation(id) {
      conversations.delete(id);
      for (const [messageId, row] of messages) if (row.conversationId === id) messages.delete(messageId);
    },
  };

  const update = (row: Record<string, unknown>, data: Record<string, unknown>): void => {
    Object.assign(row, data);
  };

  const messageDelegate = {
    async findFirst(args: { where?: Where; include?: { conversation?: boolean } } = {}) {
      const row = [...messages.values()].find((candidate) => matches(candidate as never, args.where, store));
      if (!row) return null;

      return args.include?.conversation ? { ...row, conversation: conversations.get(row.conversationId) } : { ...row };
    },
    async findMany(args: { where?: Where; orderBy?: unknown; take?: number } = {}) {
      const rows = [...messages.values()].filter((candidate) => matches(candidate as never, args.where, store));
      // The only ordering the handler asks for: newest first.
      rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));

      return rows.slice(0, args.take ?? rows.length).map((row) => ({ ...row }));
    },
    async updateMany(args: { where?: Where; data: Record<string, unknown> }) {
      const rows = [...messages.values()].filter((candidate) => matches(candidate as never, args.where, store));
      for (const row of rows) update(row as never, args.data);

      return { count: rows.length };
    },
    async update(args: { where: { id: string }; data: Record<string, unknown> }) {
      const row = messages.get(args.where.id);
      if (!row) throw new Error('in-memory Ask db: no such message');
      update(row as never, args.data);

      return { ...row };
    },
    async create(args: { data: Partial<AskMessageDbRow> & Pick<AskMessageDbRow, 'conversationId' | 'role'> }) {
      return { ...store.addMessage(args.data) };
    },
    async count(args: { where?: Where } = {}) {
      return [...messages.values()].filter((candidate) => matches(candidate as never, args.where, store)).length;
    },
  };

  const conversationDelegate = {
    async findFirst(args: { where?: Where } = {}) {
      const row = [...conversations.values()].find((candidate) => matches(candidate as never, args.where, store));

      return row ? { ...row } : null;
    },
    async updateMany(args: { where?: Where; data: Record<string, unknown> }) {
      const rows = [...conversations.values()].filter((candidate) => matches(candidate as never, args.where, store));
      for (const row of rows) update(row as never, args.data);

      return { count: rows.length };
    },
    async deleteMany(args: { where?: Where } = {}) {
      const rows = [...conversations.values()].filter((candidate) => matches(candidate as never, args.where, store));
      for (const row of rows) store.deleteConversation(row.id);

      return { count: rows.length };
    },
    async create(args: { data: Partial<AskConversationRow> }) {
      return { ...store.addConversation(args.data) };
    },
  };

  const client = {
    askMessage: messageDelegate,
    askConversation: conversationDelegate,
    kgEntity: {
      async findFirst(args: { where?: { id?: string } } = {}) {
        return (args.where?.id ? entities.get(args.where.id) : undefined) ?? null;
      },
    },
    async $queryRaw() {
      return [];
    },
    async $transaction(arg: unknown) {
      return Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => Promise<unknown>)(client);
    },
  };

  (store as { db: KvoxAskDb }).db = client as unknown as KvoxAskDb;

  return store;
}
