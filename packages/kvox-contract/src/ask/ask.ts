import { z } from 'zod';

// =============================================================================
// Ask wire schemas (issue #376, epic #348; docs/specs/ontology.md §21)
// =============================================================================
//
// THE SINGLE CONTRACT for saved Ask conversations: this issue's CRUD routes
// return it, `ask.respond` (#378) writes rows that map onto it, the SSE stream
// (#379) emits it, and the web UI (#380/#381) and the eval harness (#382) read
// it. `askMessageSchema` in particular is used UNCHANGED by all of them, so a
// field name here is permanent once merged — add, never rename.
//
// Citation markers in `content` are written `[^ev7]`, `[^ent2]`, `[^doc1]`,
// `[^itm3]`, `[^rel4]` (#377/#378); `marker` below is that handle WITHOUT the
// brackets and caret.
// =============================================================================

/**
 * The longest question one user message may carry (#378).
 *
 * @stability experimental
 */
export const ASK_CONTENT_MAX_CHARS = 4000;
/**
 * The longest conversation title a caller may set.
 *
 * @stability experimental
 */
export const ASK_TITLE_MAX_CHARS = 120;
/**
 * Mirrors the `AskErrorClass` Prisma enum.
 *
 * @stability experimental
 */
export const ASK_ERROR_CLASSES = ['auth', 'refusal', 'rate_limit', 'budget', 'timeout', 'other'] as const;
/**
 * The 409 `details.reason` values `POST …/messages` (#378) answers with.
 *
 * @stability experimental
 */
export const ASK_CONFLICT_REASONS = [
  'graph_disabled',
  'ai_not_configured',
  'ai_key_missing',
  'model_lacks_capability',
  'ask_turn_running',
] as const;
/**
 * Mirrors the `AskFinishReason` Prisma enum. Anything but `stop` is "stopped early".
 *
 * @stability experimental
 */
export const ASK_FINISH_REASONS = ['stop', 'step_cap', 'token_cap', 'time_cap'] as const;
/**
 * How many messages one detail read returns at most (the newest ones).
 *
 * @stability experimental
 */
export const ASK_DETAIL_MESSAGE_LIMIT = 100;
/**
 * The longest `lastMessagePreview`, after citation markers are stripped.
 *
 * @stability experimental
 */
export const ASK_PREVIEW_MAX_CHARS = 140;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * Zod schema for the ask citation wire shape.
 *
 * @stability experimental
 */
export const askCitationSchema = z.object({
  marker: z
    .string()
    .describe('The handle as written in `content`, without brackets: `ev7`, `ent2`, `doc1`, `itm3`, `rel4`.'),
  kind: z
    .enum(['evidence', 'entity', 'document'])
    .describe('`itm`/`rel` markers are resolved server-side to their first evidence row, so they are `evidence`.'),
  id: z.uuid().nullable().describe('Evidence id, entity id, or transcript/note id; `null` when `valid` is false.'),
  via: z
    .object({ kind: z.enum(['item', 'relation']), id: z.uuid() })
    .nullable()
    .describe('Set when an `itm`/`rel` marker was resolved to its evidence.'),
  valid: z.boolean().describe('The handle was issued by a tool in this turn and is citable.'),
  label: z.string().nullable().describe('Entity label / source title at answer time.'),
  documentKind: z.enum(['transcript', 'note']).nullable(),
  startMs: z.number().int().nullable().describe('Documents: where in the recording.'),
});
/**
 * The parsed shape of {@link askCitationSchema}.
 *
 * @stability experimental
 */
export type AskCitation = z.infer<typeof askCitationSchema>;

/**
 * Zod schema for the ask tool call wire shape.
 *
 * @stability experimental
 */
export const askToolCallSchema = z.object({
  index: z.number().int(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).describe('As the model sent them (handles, not ids).'),
  summary: z.string().describe('A human line, e.g. "Looked up Acme (Organization)".'),
  resultCount: z.number().int(),
  durationMs: z.number().int(),
  error: z.string().nullable(),
});
/**
 * The parsed shape of {@link askToolCallSchema}.
 *
 * @stability experimental
 */
export type AskToolCall = z.infer<typeof askToolCallSchema>;

/**
 * Zod schema for the ask message wire shape.
 *
 * @stability experimental
 */
export const askMessageSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  role: z.enum(['user', 'assistant']),
  content: z.string().describe('Assistant: the durable stream buffer, append-only while `streaming`.'),
  status: z.enum(['pending', 'streaming', 'complete', 'failed']),
  toolCalls: z.array(askToolCallSchema),
  citations: z.array(askCitationSchema),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  promptTokens: z.number().int().nullable(),
  completionTokens: z.number().int().nullable(),
  errorClass: z.enum(ASK_ERROR_CLASSES).nullable(),
  finishReason: z
    .enum(ASK_FINISH_REASONS)
    .nullable()
    .describe('Why the turn ended. Anything but `stop` means it hit a cap and ended with its best answer ("stopped early").'),
  createdAt: z.string(),
});
/**
 * The parsed shape of {@link askMessageSchema}.
 *
 * @stability experimental
 */
export type AskMessageResponse = z.infer<typeof askMessageSchema>;

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

const scopeEntitySchema = z
  .object({ id: z.uuid(), label: z.string(), type: z.string() })
  .nullable()
  .describe('The entity this conversation is scoped to, read live; `null` when unscoped, or once it was merged or forgotten.');

/**
 * Zod schema for the ask conversation summary wire shape.
 *
 * @stability experimental
 */
export const askConversationSummarySchema = z.object({
  id: z.uuid(),
  title: z.string().nullable().describe('`null` until the first message.'),
  scopeEntity: scopeEntitySchema,
  lastMessagePreview: z
    .string()
    .nullable()
    .describe(`The newest message with text, at most ${ASK_PREVIEW_MAX_CHARS} characters, citation markers stripped.`),
  running: z.boolean().describe('An assistant turn is `pending` or `streaming`.'),
  createdAt: z.string(),
  updatedAt: z.string(),
});
/**
 * The parsed shape of {@link askConversationSummarySchema}.
 *
 * @stability experimental
 */
export type AskConversationSummary = z.infer<typeof askConversationSummarySchema>;

/**
 * Zod schema for the list ask conversations query wire shape.
 *
 * @stability experimental
 */
export const listAskConversationsQuerySchema = z.object({
  cursor: z.string().max(500).optional().describe('`nextCursor` from the previous page.'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  scopeEntityId: z.uuid().optional().describe('Only conversations scoped to this entity (the entity page panel).'),
});
/**
 * The parsed shape of {@link listAskConversationsQuerySchema}.
 *
 * @stability experimental
 */
export type ListAskConversationsQuery = z.infer<typeof listAskConversationsQuerySchema>;

/**
 * Zod schema for the list ask conversations response wire shape.
 *
 * @stability experimental
 */
export const listAskConversationsResponseSchema = z.object({
  items: z.array(askConversationSummarySchema),
  nextCursor: z.string().nullable(),
});
/**
 * The parsed shape of {@link listAskConversationsResponseSchema}.
 *
 * @stability experimental
 */
export type ListAskConversationsResponse = z.infer<typeof listAskConversationsResponseSchema>;

/**
 * Zod schema for the ask conversation detail wire shape.
 *
 * @stability experimental
 */
export const askConversationDetailSchema = askConversationSummarySchema
  .omit({ lastMessagePreview: true })
  .extend({
    messages: z
      .array(askMessageSchema)
      .describe(`Oldest → newest, at most the newest ${ASK_DETAIL_MESSAGE_LIMIT} (before \`before\`, when given).`),
    hasEarlier: z.boolean().describe('Older messages exist; page them with `?before=<messages[0].id>`.'),
  });
/**
 * The parsed shape of {@link askConversationDetailSchema}.
 *
 * @stability experimental
 */
export type AskConversationDetail = z.infer<typeof askConversationDetailSchema>;

/**
 * Zod schema for the get ask conversation query wire shape.
 *
 * @stability experimental
 */
export const getAskConversationQuerySchema = z.object({
  before: z.uuid().optional().describe('Page older messages: only those before this message id.'),
});
/**
 * The parsed shape of {@link getAskConversationQuerySchema}.
 *
 * @stability experimental
 */
export type GetAskConversationQuery = z.infer<typeof getAskConversationQuerySchema>;

/**
 * Zod schema for the create ask conversation wire shape.
 *
 * @stability experimental
 */
export const createAskConversationSchema = z.object({
  scopeEntityId: z.uuid().optional().describe('Scope the conversation to one of your entities. 404 when it is not one.'),
  title: z.string().trim().min(1).max(ASK_TITLE_MAX_CHARS).optional(),
});
/**
 * The parsed shape of {@link createAskConversationSchema}.
 *
 * @stability experimental
 */
export type CreateAskConversation = z.infer<typeof createAskConversationSchema>;

/**
 * Zod schema for the rename ask conversation wire shape.
 *
 * @stability experimental
 */
export const renameAskConversationSchema = z.object({
  title: z.string().trim().min(1).max(ASK_TITLE_MAX_CHARS),
});
/**
 * The parsed shape of {@link renameAskConversationSchema}.
 *
 * @stability experimental
 */
export type RenameAskConversation = z.infer<typeof renameAskConversationSchema>;
