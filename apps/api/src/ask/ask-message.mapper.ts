import type { AskMessage } from '@prisma/client';

import {
  ASK_PREVIEW_MAX_CHARS,
  askCitationSchema,
  askToolCallSchema,
  type AskCitation,
  type AskMessageResponse,
  type AskToolCall,
} from './dto/ask.dto';

// =============================================================================
// Row → wire mapping for Ask messages (issue #376, epic #348)
// =============================================================================
//
// Pure, so the service, `ask.respond` (#378) and the SSE stream (#379) all
// produce the byte-identical `AskMessage` shape from one function.
// =============================================================================

/**
 * Every citation marker the agent writes into `content` (#377/#378):
 * `[^ev7]`, `[^ent2]`, `[^doc1]`, `[^itm3]`, `[^rel4]`.
 */
export const ASK_CITATION_MARKER_PATTERN = /\[\^(ev|ent|doc|itm|rel)\d+\]/g;

/** `content` without its citation markers — for previews and titles, never for the stored text. */
export function stripCitationMarkers(content: string): string {
  return content.replace(ASK_CITATION_MARKER_PATTERN, '');
}

/**
 * A one-line preview: markers stripped, whitespace collapsed, at most
 * {@link ASK_PREVIEW_MAX_CHARS} characters (an ellipsis marks a cut). `null`
 * when nothing readable is left.
 */
export function previewText(content: string | null | undefined, max = ASK_PREVIEW_MAX_CHARS): string | null {
  if (!content) return null;
  const text = stripCitationMarkers(content).replace(/\s+/g, ' ').trim();
  if (text.length === 0) return null;
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The JSONB array column, element by element. A row written by an older (or
 * buggy) writer must not 500 a read, so an element that does not match the
 * wire schema is dropped rather than passed through unvalidated.
 */
function parseArray<T>(value: unknown, parse: (element: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const element of value) {
    const parsed = parse(element);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

const parseToolCall = (e: unknown): AskToolCall | null => {
  const r = askToolCallSchema.safeParse(e);
  return r.success ? r.data : null;
};

const parseCitation = (e: unknown): AskCitation | null => {
  const r = askCitationSchema.safeParse(e);
  return r.success ? r.data : null;
};

/** The columns the mapper reads — a Prisma row, or a raw-SQL row aliased to the same names. */
export type AskMessageRow = Pick<
  AskMessage,
  | 'id'
  | 'conversationId'
  | 'role'
  | 'content'
  | 'status'
  | 'toolCalls'
  | 'citations'
  | 'model'
  | 'provider'
  | 'promptTokens'
  | 'completionTokens'
  | 'errorClass'
  | 'finishReason'
  | 'createdAt'
>;

export function toAskMessage(row: AskMessageRow): AskMessageResponse {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role,
    content: row.content,
    status: row.status,
    toolCalls: parseArray(row.toolCalls, parseToolCall),
    citations: parseArray(row.citations, parseCitation),
    model: row.model,
    provider: row.provider,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    errorClass: row.errorClass,
    finishReason: row.finishReason,
    createdAt: row.createdAt.toISOString(),
  };
}
