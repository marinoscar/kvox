import { z } from 'zod';

import type { JsonSchema } from '../types/index.js';

// =============================================================================
// Prompted structured output: the schema in the prompt, one repair (issue #581)
// =============================================================================
//
// Some models are reached through a provider that cannot hold them to a JSON
// Schema (GitHub Copilot's Claude models: the Copilot SDK's `responseSchema` is
// honoured only by the models it can constrain natively). For a model whose
// `structuredOutputMode` is `prompted`, `createKvoxAi.generateStructured` does
// the provider's job itself, the same way for every adapter:
//
//   1. REQUEST. The system prompt gains ONE generic block: answer with a single
//      JSON value only, conforming to this JSON Schema (named, pretty-printed).
//      The request carries NO `structuredOutput`; the user prompt is unchanged.
//   2. PARSE. Trim, strip one surrounding ```json / ``` fence, `JSON.parse`.
//   3. VALIDATE TWICE, as the native path does: the constrained schema (the
//      caller's JSON Schema converted to Zod, when there is one) and then the
//      caller's own Zod schema, which decides the value.
//   4. ONE REPAIR. A failed parse or validation (of an answer that was not cut
//      off) is answered with ONE more call: the same system prompt, and as the
//      ONLY input a string holding the original user text, the previous answer
//      and the problems, asking for the corrected JSON only. A string input works
//      on every adapter, including one that takes a single user message.
//
// This file holds the PURE half (text building, parsing, validation). The calls,
// the finish-reason rules (`length` is `truncated`, `content_filter` a refusal)
// and the error classes are the port's (`port/create-kvox-ai.ts`).
//
// ⚠ THE ONLY RETRY. It lives here, in kvox-ai, and nowhere else: an adapter has
// no retry loop of its own (the Copilot adapter suppresses the SDK's).
// ⚠ THE BLOCK IS GENERIC. It names no KVox concept; the caller's prompt and
// schema carry all of the meaning. Changing the wording changes every prompted
// request, so it is a deliberate edit with the eval suite run after it.
// =============================================================================

/**
 * The most validation problems a repair request lists (the rest are counted).
 *
 * @stability experimental
 */
export const PROMPTED_REPAIR_ISSUE_LIMIT = 20;

/** The longest single problem message a repair request carries. */
const ISSUE_MESSAGE_LIMIT = 200;

/**
 * One reason a prompted answer was not usable: where (a JSON path as segments)
 * and why.
 *
 * @stability experimental
 */
export interface PromptedStructuredIssue {
  /** The path of the offending value inside the answer; empty for the whole answer. */
  path: Array<string | number>;
  /** The validator's code (`invalid_json` when the answer is not JSON at all). */
  code: string;
  /** What is wrong, in the validator's words. */
  message: string;
}

/**
 * The outcome of {@link parsePromptedStructuredAnswer}.
 *
 * @typeParam T - the caller's value type.
 * @stability experimental
 */
export type PromptedStructuredParse<T> =
  | {
      /** The answer parsed and validated. */
      ok: true;
      /** The value the caller's schema produced. */
      value: T;
    }
  | {
      /** The answer is not usable. */
      ok: false;
      /** True when the answer is not JSON at all (a truncation candidate), false for a schema mismatch. */
      notJson: boolean;
      /** Why, in order. */
      issues: PromptedStructuredIssue[];
    };

/**
 * The JSON Schema a prompted request shows the model: the caller's own JSON
 * Schema when it gave one, else its Zod schema converted (without `$schema`,
 * which describes the document, not the value).
 *
 * @param schema - the caller's Zod schema.
 * @param jsonSchema - the caller's strict JSON Schema, when it gave one.
 * @returns the JSON Schema to embed.
 * @stability experimental
 */
export function promptedJsonSchemaOf(schema: z.ZodType, jsonSchema?: JsonSchema): JsonSchema {
  if (jsonSchema !== undefined) return jsonSchema;
  const { $schema: _document, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

/**
 * The system prompt of a prompted structured request: the caller's system prompt,
 * a blank line, then the generic schema block.
 *
 * @example
 * ```ts
 * const instructions = buildPromptedStructuredInstructions({
 *   system: 'Extract the title.',
 *   schemaName: 'title',
 *   jsonSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false },
 * });
 * ```
 *
 * @param input - the caller's system prompt, the schema's name and the JSON Schema.
 * @returns the instructions to send.
 * @stability experimental
 */
export function buildPromptedStructuredInstructions(input: {
  system: string;
  schemaName: string;
  jsonSchema: JsonSchema;
}): string {
  const block = [
    `Answer with a single JSON value only: no prose before or after it, and no code fence. The value must conform to this JSON Schema, named "${input.schemaName}":`,
    JSON.stringify(input.jsonSchema, null, 2),
  ].join('\n\n');
  return input.system.length > 0 ? `${input.system}\n\n${block}` : block;
}

/**
 * The single input string of the one repair request: the original user text,
 * a separator, the previous answer and its problems, and the ask for corrected
 * JSON only.
 *
 * @param input - the original user text, the schema's name, the previous answer and its problems.
 * @returns the repair request's `input`.
 * @stability experimental
 */
export function buildPromptedRepairInput(input: {
  user: string;
  schemaName: string;
  answer: string;
  issues: readonly PromptedStructuredIssue[];
}): string {
  const listed = input.issues.slice(0, PROMPTED_REPAIR_ISSUE_LIMIT).map((issue) => `- ${formatIssue(issue)}`);
  const more = input.issues.length - listed.length;
  if (more > 0) listed.push(`- ...and ${more} more`);

  return [
    input.user,
    '---',
    `Your previous answer is not a valid JSON value for the JSON Schema "${input.schemaName}". The previous answer:`,
    input.answer,
    'The problems:',
    listed.length > 0 ? listed.join('\n') : '- the answer could not be read',
    'Answer again with the corrected JSON value only.',
  ].join('\n\n');
}

/**
 * Parses and validates a prompted answer.
 *
 * @remarks
 * Trims the text and strips ONE surrounding Markdown code fence (three backticks,
 * optionally followed by a language tag such as `json`), then `JSON.parse`. The value is validated by every schema of
 * `schemas` in order (the constrained schema, then the caller's); the first
 * failure's issues are returned. The value returned is the LAST schema's output.
 *
 * @typeParam T - the last schema's output type.
 * @param text - the model's text answer.
 * @param schemas - the validators, the caller's own last (at least one).
 * @returns the value, or why it is not usable.
 * @stability experimental
 */
export function parsePromptedStructuredAnswer<T>(
  text: string,
  schemas: readonly [...z.ZodType[], z.ZodType<T>],
): PromptedStructuredParse<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(stripFence(text));
  } catch (err) {
    return {
      ok: false,
      notJson: true,
      issues: [{ path: [], code: 'invalid_json', message: err instanceof Error ? err.message : 'not valid JSON' }],
    };
  }

  let value: unknown = raw;
  for (const schema of schemas) {
    const checked = schema.safeParse(raw);
    if (!checked.success) {
      return {
        ok: false,
        notJson: false,
        issues: checked.error.issues.map((issue) => ({
          path: issue.path.map((segment) => (typeof segment === 'symbol' ? String(segment) : segment)),
          code: issue.code,
          message: issue.message,
        })),
      };
    }
    value = checked.data;
  }
  return { ok: true, value: value as T };
}

/** The text without surrounding whitespace and without one surrounding code fence. */
function stripFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed);
  return (fenced ? fenced[1] : trimmed).trim();
}

/** `$.a[0].b: message`, capped. */
function formatIssue(issue: PromptedStructuredIssue): string {
  const path = issue.path.reduce<string>(
    (out, segment) => (typeof segment === 'number' ? `${out}[${segment}]` : `${out}.${segment}`),
    '$',
  );
  const message = issue.message.length > ISSUE_MESSAGE_LIMIT ? `${issue.message.slice(0, ISSUE_MESSAGE_LIMIT)}...` : issue.message;
  return `${path}: ${message}`;
}
