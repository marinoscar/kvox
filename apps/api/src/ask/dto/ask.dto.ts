import { createZodDto } from 'nestjs-zod';
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

/** The longest question one user message may carry (#378). */
export const ASK_CONTENT_MAX_CHARS = 4000;
/** The longest conversation title a caller may set. */
export const ASK_TITLE_MAX_CHARS = 120;
/** Mirrors the `AskErrorClass` Prisma enum. */
export const ASK_ERROR_CLASSES = ['auth', 'refusal', 'rate_limit', 'budget', 'timeout', 'other'] as const;
/** The 409 `details.reason` values `POST …/messages` (#378) answers with. */
export const ASK_CONFLICT_REASONS = [
  'graph_disabled',
  'ai_not_configured',
  'ai_key_missing',
  'model_lacks_capability',
  'ask_turn_running',
] as const;
/** Mirrors the `AskFinishReason` Prisma enum. Anything but `stop` is "stopped early". */
export const ASK_FINISH_REASONS = ['stop', 'step_cap', 'token_cap', 'time_cap'] as const;
/** How many messages one detail read returns at most (the newest ones). */
export const ASK_DETAIL_MESSAGE_LIMIT = 100;
/** The longest `lastMessagePreview`, after citation markers are stripped. */
export const ASK_PREVIEW_MAX_CHARS = 140;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

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
export type AskCitation = z.infer<typeof askCitationSchema>;
export class AskCitationDto extends createZodDto(askCitationSchema) {}

export const askToolCallSchema = z.object({
  index: z.number().int(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).describe('As the model sent them (handles, not ids).'),
  summary: z.string().describe('A human line, e.g. "Looked up Acme (Organization)".'),
  resultCount: z.number().int(),
  durationMs: z.number().int(),
  error: z.string().nullable(),
});
export type AskToolCall = z.infer<typeof askToolCallSchema>;
export class AskToolCallDto extends createZodDto(askToolCallSchema) {}

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
export type AskMessageResponse = z.infer<typeof askMessageSchema>;
export class AskMessageDto extends createZodDto(askMessageSchema) {}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

const scopeEntitySchema = z
  .object({ id: z.uuid(), label: z.string(), type: z.string() })
  .nullable()
  .describe('The entity this conversation is scoped to, read live; `null` when unscoped, or once it was merged or forgotten.');

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
export type AskConversationSummary = z.infer<typeof askConversationSummarySchema>;
export class AskConversationSummaryDto extends createZodDto(askConversationSummarySchema) {}

export const listAskConversationsQuerySchema = z.object({
  cursor: z.string().max(500).optional().describe('`nextCursor` from the previous page.'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  scopeEntityId: z.uuid().optional().describe('Only conversations scoped to this entity (the entity page panel).'),
});
export type ListAskConversationsQuery = z.infer<typeof listAskConversationsQuerySchema>;
export class ListAskConversationsQueryDto extends createZodDto(listAskConversationsQuerySchema) {}

export const listAskConversationsResponseSchema = z.object({
  items: z.array(askConversationSummarySchema),
  nextCursor: z.string().nullable(),
});
export type ListAskConversationsResponse = z.infer<typeof listAskConversationsResponseSchema>;
export class ListAskConversationsResponseDto extends createZodDto(listAskConversationsResponseSchema) {}

export const askConversationDetailSchema = askConversationSummarySchema
  .omit({ lastMessagePreview: true })
  .extend({
    messages: z
      .array(askMessageSchema)
      .describe(`Oldest → newest, at most the newest ${ASK_DETAIL_MESSAGE_LIMIT} (before \`before\`, when given).`),
    hasEarlier: z.boolean().describe('Older messages exist; page them with `?before=<messages[0].id>`.'),
  });
export type AskConversationDetail = z.infer<typeof askConversationDetailSchema>;
export class AskConversationDetailDto extends createZodDto(askConversationDetailSchema) {}

export const getAskConversationQuerySchema = z.object({
  before: z.uuid().optional().describe('Page older messages: only those before this message id.'),
});
export type GetAskConversationQuery = z.infer<typeof getAskConversationQuerySchema>;
export class GetAskConversationQueryDto extends createZodDto(getAskConversationQuerySchema) {}

export const createAskConversationSchema = z.object({
  scopeEntityId: z.uuid().optional().describe('Scope the conversation to one of your entities. 404 when it is not one.'),
  title: z.string().trim().min(1).max(ASK_TITLE_MAX_CHARS).optional(),
});
export type CreateAskConversation = z.infer<typeof createAskConversationSchema>;
export class CreateAskConversationDto extends createZodDto(createAskConversationSchema) {}

export const renameAskConversationSchema = z.object({
  title: z.string().trim().min(1).max(ASK_TITLE_MAX_CHARS),
});
export type RenameAskConversation = z.infer<typeof renameAskConversationSchema>;
export class RenameAskConversationDto extends createZodDto(renameAskConversationSchema) {}
