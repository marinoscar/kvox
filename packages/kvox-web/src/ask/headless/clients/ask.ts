/**
 * Ask: questions answered from the caller's own knowledge graph (#380, epic
 * #348; spec `docs/specs/ontology.md` §21).
 *
 * The wire shapes are the contract's (`@marinoscar/kvox-contract/ask`, #376),
 * re-exported here as documented aliases so a drift fails `tsc` instead of
 * rendering `undefined`; the request functions are #378's
 * `POST /api/ask/conversations/:id/messages` and the conversation CRUD around it.
 *
 * The answer stream (#379) is a separate module, `askStream.ts`, for the same
 * reason the note-generation stream is separate from the notes client: a stream
 * is a connection with a lifecycle, not a request.
 *
 * Every route is `graph:read`-gated and owner-scoped; a conversation or message
 * that is not the caller's is an identical **404** (spec §12, never 403). There
 * is no `ask:*` permission pair. Each call takes the `KvoxWebHost` first and
 * rejects with a `KvoxApiError`.
 */

import {
  ASK_CONFLICT_REASONS as CONTRACT_ASK_CONFLICT_REASONS,
  ASK_CONTENT_MAX_CHARS as CONTRACT_ASK_CONTENT_MAX_CHARS,
  ASK_ERROR_CLASSES as CONTRACT_ASK_ERROR_CLASSES,
  ASK_FINISH_REASONS as CONTRACT_ASK_FINISH_REASONS,
  ASK_TITLE_MAX_CHARS as CONTRACT_ASK_TITLE_MAX_CHARS,
} from '@marinoscar/kvox-contract/ask';
import type {
  AskCitation as ContractAskCitation,
  AskConversationDetail as ContractAskConversationDetail,
  AskConversationSummary as ContractAskConversationSummary,
  AskMessageResponse as ContractAskMessage,
  AskToolCall as ContractAskToolCall,
  PostAskMessageResponse as ContractPostAskMessageResponse,
} from '@marinoscar/kvox-contract/ask';

import {
  KvoxApiError,
  kvoxDelete,
  kvoxGet,
  kvoxPatch,
  kvoxPost,
} from '../../../core/headless/index.js';
import type { KvoxWebHost } from '../../../core/headless/index.js';

// =============================================================================
// Wire schemas (#376)
// =============================================================================

/**
 * The most one question may carry (#376's `ASK_CONTENT_MAX_CHARS`).
 *
 * @stability experimental
 */
export const ASK_CONTENT_MAX_CHARS: number = CONTRACT_ASK_CONTENT_MAX_CHARS;

/**
 * The longest conversation title a caller may set (#376's `ASK_TITLE_MAX_CHARS`).
 *
 * @stability experimental
 */
export const ASK_TITLE_MAX_CHARS: number = CONTRACT_ASK_TITLE_MAX_CHARS;

/**
 * Why a stored assistant message failed (#376's `ASK_ERROR_CLASSES`).
 *
 * @stability experimental
 */
export const ASK_ERROR_CLASSES = CONTRACT_ASK_ERROR_CLASSES;

/**
 * Why a stored assistant message failed.
 *
 * @stability experimental
 */
export type AskErrorClass = (typeof ASK_ERROR_CLASSES)[number];

/**
 * Why a turn ended (#376's `ASK_FINISH_REASONS`). Anything but `stop` is
 * "stopped early" in the UI (spec §21.3).
 *
 * @stability experimental
 */
export const ASK_FINISH_REASONS = CONTRACT_ASK_FINISH_REASONS;

/**
 * Why a turn ended. Anything but `stop` is "stopped early" in the UI (spec §21.3).
 *
 * @stability experimental
 */
export type AskFinishReason = (typeof ASK_FINISH_REASONS)[number];

/**
 * Who wrote a message.
 *
 * @stability experimental
 */
export type AskMessageRole = 'user' | 'assistant';

/**
 * Where a message is in its life.
 *
 * @stability experimental
 */
export type AskMessageStatus = 'pending' | 'streaming' | 'complete' | 'failed';

/**
 * One citation marker in an assistant answer, resolved server-side (#378).
 *
 * @remarks
 * `marker` is as written in `content`, without the brackets: `ev7`, `ent2`,
 * `doc1`, `itm3`, `rel4`. `itm`/`rel` markers are resolved to their first
 * evidence row, so they arrive as `kind: 'evidence'` with `via` set.
 *
 * AN INVALID MARKER STAYS IN `content`. The buffer is append-only (the SSE
 * offset contract), so the server flags it `valid: false` here and the UI
 * removes it from the rendered answer (`remarkAskCitations`).
 *
 * @stability experimental
 */
export type AskCitation = ContractAskCitation;

/**
 * One tool step the agent took (#378 writes one after each tool call).
 *
 * @stability experimental
 */
export type AskToolCall = ContractAskToolCall;

/**
 * One message of a conversation, as the API sends it.
 *
 * @stability experimental
 */
export type AskMessage = ContractAskMessage;

/**
 * The entity a conversation is scoped to.
 *
 * @stability experimental
 */
export interface AskScopeEntity {
  /** The entity id. */
  id: string;
  /** The entity's label at read time. */
  label: string;
  /** The ontology type. */
  type: string;
}

/**
 * A conversation as the list shows it.
 *
 * @stability experimental
 */
export type AskConversationSummary = ContractAskConversationSummary;

/**
 * A conversation with its newest messages.
 *
 * @stability experimental
 */
export type AskConversationDetail = ContractAskConversationDetail;

/**
 * Query of {@link listAskConversations}.
 *
 * @stability experimental
 */
export interface AskConversationListParams {
  /** The `nextCursor` of the previous page. */
  cursor?: string;
  /** Page size. */
  limit?: number;
  /** The entity panel's filter (#381). */
  scopeEntityId?: string;
}

/**
 * One page of conversations.
 *
 * @stability experimental
 */
export interface AskConversationListResponse {
  /** The page, newest first. */
  items: AskConversationSummary[];
  /** The cursor of the next page, or `null` on the last one. */
  nextCursor: string | null;
}

/**
 * Body of {@link createAskConversation}.
 *
 * @stability experimental
 */
export interface CreateAskConversationInput {
  /** Scopes the conversation to one entity. */
  scopeEntityId?: string;
  /** A title; the API derives one from the first question otherwise. */
  title?: string;
}

/**
 * The graph selection a question starts from (the explorer's "Ask about this selection").
 *
 * @stability experimental
 */
export interface PostAskMessageScope {
  /** Entities the question is about, at most 50. */
  entityIds?: string[];
  /** Evidence ids of the selected edge or path, at most 50. */
  evidenceIds?: string[];
}

/**
 * Body of {@link postAskMessage}.
 *
 * @stability experimental
 */
export interface PostAskMessageInput {
  /** The question. */
  content: string;
  /** A user override from the allow-list; omitted to use the admin's `graph.agent` model. */
  model?: string;
  /** The graph selection the question starts from (the explorer's "Ask about this selection"): starting handles, never evidence. An id the user cannot read answers 404. */
  scope?: PostAskMessageScope;
}

/**
 * The answer of {@link postAskMessage}: both new rows.
 *
 * @stability experimental
 */
export type PostAskMessageResponse = ContractPostAskMessageResponse;

// =============================================================================
// Requests
// =============================================================================

const enc = encodeURIComponent;

/**
 * Refuses a list body that is not `{ items: [], nextCursor }`.
 *
 * The same load-bearing check `parseGraphEntityListResponse` makes: a proxy's
 * error page or a stub answering `{}` must become an ordinary failed request,
 * never `items: undefined` reaching render code.
 *
 * @param body - The response payload.
 * @returns The page.
 * @throws `KvoxApiError` (502) when the body is not a page.
 *
 * @stability experimental
 */
export function parseAskConversationList(body: unknown): AskConversationListResponse {
  if (typeof body === 'object' && body !== null) {
    const { items, nextCursor } = body as { items?: unknown; nextCursor?: unknown };
    if (Array.isArray(items) && (typeof nextCursor === 'string' || nextCursor === null || nextCursor === undefined)) {
      return { items: items as AskConversationSummary[], nextCursor: (nextCursor as string | null) ?? null };
    }
  }
  throw new KvoxApiError('Unexpected response from the server', 502);
}

/**
 * Likewise for a detail body: `messages` must be an array.
 *
 * @param body - The response payload.
 * @returns The conversation, with `hasEarlier` defaulted to `false`.
 * @throws `KvoxApiError` (502) when the body is not a conversation.
 *
 * @stability experimental
 */
export function parseAskConversationDetail(body: unknown): AskConversationDetail {
  if (typeof body === 'object' && body !== null && Array.isArray((body as { messages?: unknown }).messages)) {
    const detail = body as AskConversationDetail;
    return { ...detail, hasEarlier: Boolean(detail.hasEarlier) };
  }
  throw new KvoxApiError('Unexpected response from the server', 502);
}

/**
 * `GET /api/ask/conversations`: the caller's conversations, newest first.
 *
 * @param host - The host.
 * @param params - Cursor, page size and the entity filter.
 * @param signal - Aborts the request.
 * @returns One page.
 *
 * @stability experimental
 */
export function listAskConversations(
  host: KvoxWebHost,
  params: AskConversationListParams = {},
  signal?: AbortSignal,
): Promise<AskConversationListResponse> {
  return kvoxGet<unknown>(host, '/ask/conversations', {
    query: {
      cursor: params.cursor || undefined,
      limit: params.limit,
      scopeEntityId: params.scopeEntityId || undefined,
    },
    signal,
  }).then(parseAskConversationList);
}

/**
 * `GET /api/ask/conversations/:id`: one conversation with its newest messages.
 *
 * @param host - The host.
 * @param id - The conversation id.
 * @param params - `before`: the id of the oldest message held, to page back.
 * @param signal - Aborts the request.
 * @returns The conversation.
 *
 * @stability experimental
 */
export function getAskConversation(
  host: KvoxWebHost,
  id: string,
  params: { before?: string } = {},
  signal?: AbortSignal,
): Promise<AskConversationDetail> {
  return kvoxGet<unknown>(host, `/ask/conversations/${enc(id)}`, {
    query: { before: params.before || undefined },
    signal,
  }).then(parseAskConversationDetail);
}

/**
 * `POST /api/ask/conversations`: **201**. A foreign or merged `scopeEntityId` is a 404.
 *
 * @param host - The host.
 * @param body - The optional scope and title.
 * @returns The new conversation.
 *
 * @stability experimental
 */
export function createAskConversation(
  host: KvoxWebHost,
  body: CreateAskConversationInput = {},
): Promise<AskConversationSummary> {
  return kvoxPost<AskConversationSummary>(host, '/ask/conversations', body);
}

/**
 * `PATCH /api/ask/conversations/:id`: renames a conversation.
 *
 * @param host - The host.
 * @param id - The conversation id.
 * @param title - The new title.
 * @returns The updated summary.
 *
 * @stability experimental
 */
export function renameAskConversation(
  host: KvoxWebHost,
  id: string,
  title: string,
): Promise<AskConversationSummary> {
  return kvoxPatch<AskConversationSummary>(host, `/ask/conversations/${enc(id)}`, { title });
}

/**
 * `DELETE /api/ask/conversations/:id`: **204**. Allowed while a turn runs; the
 * job returns normally once its row is gone.
 *
 * @param host - The host.
 * @param id - The conversation id.
 *
 * @stability experimental
 */
export function deleteAskConversation(host: KvoxWebHost, id: string): Promise<void> {
  return kvoxDelete<void>(host, `/ask/conversations/${enc(id)}`);
}

/**
 * Asks one question: `POST /api/ask/conversations/:id/messages`. **202** with
 * both new rows: the user message (`complete`) and a `pending` assistant
 * message the stream then attaches to (#378).
 *
 * @param host - The host.
 * @param id - The conversation id.
 * @param body - The question and, optionally, a model override.
 * @returns Both new messages.
 *
 * @stability experimental
 */
export function postAskMessage(
  host: KvoxWebHost,
  id: string,
  body: PostAskMessageInput,
): Promise<PostAskMessageResponse> {
  const payload: PostAskMessageInput = { content: body.content };
  if (body.model) payload.model = body.model;
  if (body.scope && ((body.scope.entityIds?.length ?? 0) > 0 || (body.scope.evidenceIds?.length ?? 0) > 0)) {
    payload.scope = body.scope;
  }
  return kvoxPost<PostAskMessageResponse>(host, `/ask/conversations/${enc(id)}/messages`, payload);
}

// =============================================================================
// Errors
// =============================================================================

/**
 * Every 409 `POST …/messages` can answer (#376's `ASK_CONFLICT_REASONS`).
 *
 * @stability experimental
 */
export const ASK_CONFLICT_REASONS = CONTRACT_ASK_CONFLICT_REASONS;

/**
 * One of the 409 reasons of {@link ASK_CONFLICT_REASONS}.
 *
 * @stability experimental
 */
export type AskConflictReason = (typeof ASK_CONFLICT_REASONS)[number];

function detailsReason(err: KvoxApiError): string | null {
  const details = err.details;
  if (typeof details !== 'object' || details === null) return null;
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === 'string' ? reason : null;
}

/**
 * Which 409 `POST …/messages` answered, or `null`.
 *
 * @remarks
 * Reads `details.reason`, exactly like `noteConflictReason`. A reason this
 * build has never heard of is `null`, so the caller falls back to the server's
 * message rather than guessing.
 *
 * @param err - Whatever the call rejected with.
 * @returns The reason, or `null`.
 *
 * @stability experimental
 */
export function askConflictReason(err: unknown): AskConflictReason | null {
  if (!(err instanceof KvoxApiError) || err.status !== 409) return null;
  const reason = detailsReason(err);
  return reason && (ASK_CONFLICT_REASONS as readonly string[]).includes(reason)
    ? (reason as AskConflictReason)
    : null;
}

/**
 * Whether the error is #360's 400 for a `model` override that is not on the allow-list.
 *
 * @param err - Whatever the call rejected with.
 * @returns `true` for that 400.
 *
 * @stability experimental
 */
export function isAskModelNotPermitted(err: unknown): boolean {
  return err instanceof KvoxApiError && err.status === 400 && detailsReason(err) === 'model_not_permitted';
}

/**
 * Whether the error is the ONE 404 every Ask route answers for "not yours" and
 * "doesn't exist".
 *
 * @param err - Whatever the call rejected with.
 * @returns `true` for a 404.
 *
 * @stability experimental
 */
export function isAskNotFound(err: unknown): boolean {
  return err instanceof KvoxApiError && err.status === 404;
}
