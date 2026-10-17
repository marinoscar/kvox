import type { KvoxGraphDelegates } from '../../graph/index.js';
import type { KvoxPrismaClientLike, KvoxSql, KvoxTransactionOptions } from '../../ports/index.js';
import type { RowDelegate } from '../../transcripts/index.js';

// =============================================================================
// The Ask slice's view of the database (issue #497, epic #491)
// =============================================================================
//
// The slice never imports a generated Prisma client. It declares, here, the STRUCTURAL row
// type of the two tables it owns and the narrowed client type it injects through
// `KVOX_PRISMA` (`KvoxAskDb`). The application proves its real client satisfies this type
// with a compile-time assignment in `apps/api/test/kvox/prisma-shape.typecheck.ts`, so a
// schema change that breaks the slice fails the typecheck, not production.
//
// THE DELEGATES TAKE LOOSE ARGUMENTS ON PURPOSE (see `transcripts-db.ts`).
//
// COLUMNS: copied from `kvox.ask.prisma` in `@marinoscar/kvox-db`, which owns the schema;
// the enums are string unions of its members.
//
// TABLES THE SLICE READS BUT DOES NOT OWN: `kg_entities`, `kg_items`, `kg_relations`,
// `kg_evidence` (the graph's, reached through the graph slice's own delegates), `transcripts`
// and `notes` (the date a passage is from). The audit log and the job queue are ports.
// =============================================================================

/** The `AskMessageRole` enum. @stability experimental */
export type AskMessageRoleValue = 'user' | 'assistant';

/** The `AskMessageStatus` enum. @stability experimental */
export type AskMessageStatusValue = 'pending' | 'streaming' | 'complete' | 'failed';

/** The `AskErrorClass` enum. @stability experimental */
export type AskErrorClassValue = 'auth' | 'refusal' | 'rate_limit' | 'budget' | 'timeout' | 'other';

/** The `AskFinishReason` enum. @stability experimental */
export type AskFinishReasonValue = 'stop' | 'step_cap' | 'token_cap' | 'time_cap';

/**
 * A row of `ask_conversations`.
 *
 * @stability experimental
 */
export interface AskConversationRow {
  /** The `id` column. */
  id: string;
  /** The `owner_id` column. */
  ownerId: string;
  /** The `title` column. */
  title: string | null;
  /** The `scope_entity_id` column. */
  scopeEntityId: string | null;
  /** The `created_at` column. */
  createdAt: Date;
  /** The `updated_at` column. */
  updatedAt: Date;
}

/**
 * A row of `ask_messages`.
 *
 * @stability experimental
 */
export interface AskMessageDbRow {
  /** The `id` column. */
  id: string;
  /** The `conversation_id` column. */
  conversationId: string;
  /** The `role` column. */
  role: AskMessageRoleValue;
  /** The `content` column: the durable answer buffer. */
  content: string;
  /** The `status` column. */
  status: AskMessageStatusValue;
  /** The `tool_calls` column. */
  toolCalls: unknown;
  /** The `citations` column. */
  citations: unknown;
  /** The `model` column. */
  model: string | null;
  /** The `provider` column. */
  provider: string | null;
  /** The `prompt_tokens` column. */
  promptTokens: number | null;
  /** The `completion_tokens` column. */
  completionTokens: number | null;
  /** The `error_class` column. */
  errorClass: AskErrorClassValue | null;
  /** The `finish_reason` column. */
  finishReason: AskFinishReasonValue | null;
  /** The `job_id` column. */
  jobId: string | null;
  /** The `created_at` column. */
  createdAt: Date;
  /** The conversation, when the query included it. */
  conversation?: any;
}

/**
 * The delegates the slice works with, shared by the client and a transaction.
 *
 * @stability experimental
 */
export interface KvoxAskDelegates {
  /** `ask_conversations`. */
  askConversation: RowDelegate<AskConversationRow>;
  /** `ask_messages`. */
  askMessage: RowDelegate<AskMessageDbRow>;
  /** `kg_entities` (reads only: the scope entity). */
  kgEntity: Pick<KvoxGraphDelegates['kgEntity'], 'findFirst' | 'findMany' | 'count'>;
  /** `kg_items` (reads only: what the tools show). */
  kgItem: Pick<KvoxGraphDelegates['kgItem'], 'findFirst' | 'findMany' | 'count'>;
  /** `kg_relations` (reads only). */
  kgRelation: Pick<KvoxGraphDelegates['kgRelation'], 'findFirst' | 'findMany' | 'count'>;
  /** `kg_evidence` (reads only). */
  kgEvidence: Pick<KvoxGraphDelegates['kgEvidence'], 'findFirst' | 'findMany' | 'count'>;
  /** `transcripts` (reads only: the date a passage is from). */
  transcript: Pick<KvoxGraphDelegates['transcript'], 'findMany'>;
  /** `notes` (reads only). */
  note: Pick<KvoxGraphDelegates['note'], 'findMany'>;
}

/**
 * The client inside an interactive transaction.
 *
 * @stability experimental
 */
export interface KvoxAskTx extends KvoxAskDelegates {
  /** Runs a raw query and returns its rows. */
  $queryRaw<T = unknown>(query: TemplateStringsArray | KvoxSql, ...values: unknown[]): Promise<T>;
  /** Runs a raw statement and returns the affected row count. */
  $executeRaw(query: TemplateStringsArray | KvoxSql, ...values: unknown[]): Promise<number>;
}

/**
 * The narrowed client the slice injects through `KVOX_PRISMA`.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface KvoxAskDb extends KvoxPrismaClientLike, KvoxAskDelegates {
  /**
   * Runs a callback in a transaction on the narrowed transaction client.
   *
   * @param fn - receives the transaction client.
   * @param options - an optional timeout and isolation level.
   */
  $transaction<T>(fn: (tx: KvoxAskTx) => Promise<T>, options?: KvoxTransactionOptions): Promise<T>;
  /**
   * Runs prepared queries in one transaction and returns their results, in order.
   *
   * @param queries - the queries.
   * @param options - an optional timeout and isolation level.
   */
  $transaction<const Q extends readonly unknown[]>(
    queries: [...Q],
    options?: KvoxTransactionOptions,
  ): Promise<{ -readonly [K in keyof Q]: Awaited<Q[K]> }>;
}
