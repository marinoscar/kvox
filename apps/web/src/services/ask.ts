/**
 * Ask — questions answered from the caller's own knowledge graph (#380, epic
 * #348; spec `docs/specs/ontology.md` §21).
 *
 * TypeScript mirrors of the API's wire schemas, field for field:
 *
 *   - `AskConversationSummary`, `AskConversationDetail`, `AskMessage`,
 *     `AskToolCall`, `AskCitation` — #376's `apps/api/src/ask/dto/ask.dto.ts`;
 *   - `postAskMessage` and its 409 reasons — #378's
 *     `POST /api/ask/conversations/:id/messages`.
 *
 * The stream (#379) is a separate module, `services/askStream.ts`, for the
 * same reason `noteGenerationStream.ts` is separate from `notes.ts`: a stream
 * is a connection with a lifecycle, not a request.
 *
 * Every route is `graph:read`-gated and owner-scoped; a conversation or
 * message that is not the caller's is an identical **404** (spec §12, never
 * 403). There is no `ask:*` permission pair.
 */

import { api, ApiError } from './api';

// =============================================================================
// Wire schemas (#376)
// =============================================================================

/** #376's `ASK_CONTENT_MAX_CHARS` — the most one question may carry. */
export const ASK_CONTENT_MAX_CHARS = 4000;
/** #376's `ASK_TITLE_MAX_CHARS`. */
export const ASK_TITLE_MAX_CHARS = 120;

export const ASK_ERROR_CLASSES = ['auth', 'refusal', 'rate_limit', 'budget', 'timeout', 'other'] as const;
export type AskErrorClass = (typeof ASK_ERROR_CLASSES)[number];

export const ASK_FINISH_REASONS = ['stop', 'step_cap', 'token_cap', 'time_cap'] as const;
/** Anything but `stop` is "stopped early" in the UI (spec §21.3). */
export type AskFinishReason = (typeof ASK_FINISH_REASONS)[number];

export type AskMessageRole = 'user' | 'assistant';
export type AskMessageStatus = 'pending' | 'streaming' | 'complete' | 'failed';

/**
 * One citation marker in an assistant answer, resolved server-side (#378).
 *
 * `marker` is as written in `content`, without the brackets: `ev7`, `ent2`,
 * `doc1`, `itm3`, `rel4`. `itm`/`rel` markers are resolved to their first
 * evidence row, so they arrive as `kind: 'evidence'` with `via` set.
 *
 * ⚠ AN INVALID MARKER STAYS IN `content`. The buffer is append-only (the SSE
 * offset contract), so the server flags it `valid: false` here and the UI
 * removes it from the rendered answer — see `components/ask/remarkAskCitations.ts`.
 */
export interface AskCitation {
  marker: string;
  kind: 'evidence' | 'entity' | 'document';
  /** Evidence id | entity id | transcript/note id; `null` when `!valid`. */
  id: string | null;
  via: { kind: 'item' | 'relation'; id: string } | null;
  /** The handle was issued by a tool in this turn and is citable. */
  valid: boolean;
  /** Entity label / source title at answer time. */
  label: string | null;
  documentKind: 'transcript' | 'note' | null;
  /** Documents: where in the recording. */
  startMs: number | null;
}

/** One tool step the agent took (#378 writes one after each tool call). */
export interface AskToolCall {
  index: number;
  name: string;
  /** As the model sent them (handles, not ids). */
  arguments: Record<string, unknown>;
  /** The human line, e.g. "Looked up Acme (Organization)". */
  summary: string;
  resultCount: number;
  durationMs: number;
  error: string | null;
}

export interface AskMessage {
  id: string;
  conversationId: string;
  role: AskMessageRole;
  /** Assistant: the durable stream buffer, append-only while streaming. */
  content: string;
  status: AskMessageStatus;
  toolCalls: AskToolCall[];
  citations: AskCitation[];
  model: string | null;
  provider: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  errorClass: AskErrorClass | null;
  finishReason: AskFinishReason | null;
  createdAt: string;
}

export interface AskScopeEntity {
  id: string;
  label: string;
  type: string;
}

export interface AskConversationSummary {
  id: string;
  /** `null` until the first message; then its first 80 characters. */
  title: string | null;
  /** Read live; `null` when the entity was merged or forgotten. */
  scopeEntity: AskScopeEntity | null;
  /** ≤ 140 chars, citation markers stripped. */
  lastMessagePreview: string | null;
  /** A turn is pending or streaming. */
  running: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AskConversationDetail extends Omit<AskConversationSummary, 'lastMessagePreview'> {
  /** Oldest → newest, at most the newest 100. */
  messages: AskMessage[];
  hasEarlier: boolean;
}

export interface AskConversationListParams {
  cursor?: string;
  limit?: number;
  /** The entity panel's filter (#381). */
  scopeEntityId?: string;
}

export interface AskConversationListResponse {
  items: AskConversationSummary[];
  nextCursor: string | null;
}

export interface CreateAskConversationInput {
  scopeEntityId?: string;
  title?: string;
}

export interface PostAskMessageInput {
  content: string;
  /** A user override from the allow-list; omitted to use the admin's `graph.agent` model. */
  model?: string;
}

export interface PostAskMessageResponse {
  userMessage: AskMessage;
  assistantMessage: AskMessage;
}

// =============================================================================
// Requests
// =============================================================================

const enc = encodeURIComponent;

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

/**
 * Refuse a list body that is not `{ items: [], nextCursor }`.
 *
 * The same load-bearing check `parseGraphEntityListResponse` makes: a proxy's
 * error page or a stub answering `{}` must become an ordinary failed request,
 * never `items: undefined` reaching render code.
 */
export function parseAskConversationList(body: unknown): AskConversationListResponse {
  if (typeof body === 'object' && body !== null) {
    const { items, nextCursor } = body as { items?: unknown; nextCursor?: unknown };
    if (Array.isArray(items) && (typeof nextCursor === 'string' || nextCursor === null || nextCursor === undefined)) {
      return { items: items as AskConversationSummary[], nextCursor: (nextCursor as string | null) ?? null };
    }
  }
  throw new ApiError('Unexpected response from the server', 502);
}

/** Likewise for a detail body: `messages` must be an array. */
export function parseAskConversationDetail(body: unknown): AskConversationDetail {
  if (typeof body === 'object' && body !== null && Array.isArray((body as { messages?: unknown }).messages)) {
    const detail = body as AskConversationDetail;
    return { ...detail, hasEarlier: Boolean(detail.hasEarlier) };
  }
  throw new ApiError('Unexpected response from the server', 502);
}

export function listAskConversations(
  params: AskConversationListParams = {},
  signal?: AbortSignal,
): Promise<AskConversationListResponse> {
  const qs = query({ cursor: params.cursor, limit: params.limit, scopeEntityId: params.scopeEntityId });
  return api.get<unknown>(`/ask/conversations${qs}`, { signal }).then(parseAskConversationList);
}

export function getAskConversation(
  id: string,
  params: { before?: string } = {},
  signal?: AbortSignal,
): Promise<AskConversationDetail> {
  return api
    .get<unknown>(`/ask/conversations/${enc(id)}${query({ before: params.before })}`, { signal })
    .then(parseAskConversationDetail);
}

/** **201**. A foreign or merged `scopeEntityId` is a 404. */
export function createAskConversation(
  body: CreateAskConversationInput = {},
): Promise<AskConversationSummary> {
  return api.post<AskConversationSummary>('/ask/conversations', body);
}

export function renameAskConversation(id: string, title: string): Promise<AskConversationSummary> {
  return api.patch<AskConversationSummary>(`/ask/conversations/${enc(id)}`, { title });
}

/** **204**. Allowed while a turn runs — the job returns normally once its row is gone. */
export function deleteAskConversation(id: string): Promise<void> {
  return api.delete<void>(`/ask/conversations/${enc(id)}`);
}

/**
 * Ask one question. **202** with both new rows: the user message (`complete`)
 * and a `pending` assistant message the stream then attaches to (#378).
 */
export function postAskMessage(id: string, body: PostAskMessageInput): Promise<PostAskMessageResponse> {
  const payload: PostAskMessageInput = { content: body.content };
  if (body.model) payload.model = body.model;
  return api.post<PostAskMessageResponse>(`/ask/conversations/${enc(id)}/messages`, payload);
}

// =============================================================================
// Errors
// =============================================================================

/** #376's `ASK_CONFLICT_REASONS` — every 409 `POST …/messages` can answer. */
export const ASK_CONFLICT_REASONS = [
  'graph_disabled',
  'ai_not_configured',
  'ai_key_missing',
  'model_lacks_capability',
  'ask_turn_running',
] as const;
export type AskConflictReason = (typeof ASK_CONFLICT_REASONS)[number];

function detailsReason(err: ApiError): string | null {
  const details = err.details;
  if (typeof details !== 'object' || details === null) return null;
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === 'string' ? reason : null;
}

/**
 * Which 409 `POST …/messages` answered, or `null`.
 *
 * Reads `ApiError.details.reason`, exactly like `noteConflictReason`. A reason
 * this build has never heard of is `null`, so the caller falls back to the
 * server's message rather than guessing.
 */
export function askConflictReason(err: unknown): AskConflictReason | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const reason = detailsReason(err);
  return reason && (ASK_CONFLICT_REASONS as readonly string[]).includes(reason)
    ? (reason as AskConflictReason)
    : null;
}

/** #360's 400 for a `model` override that is not on the allow-list. */
export function isAskModelNotPermitted(err: unknown): boolean {
  return err instanceof ApiError && err.status === 400 && detailsReason(err) === 'model_not_permitted';
}

/** The ONE 404 every Ask route answers for "not yours" and "doesn't exist". */
export function isAskNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}
