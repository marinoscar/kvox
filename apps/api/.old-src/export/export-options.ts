// =============================================================================
// Export options: one declaration, three consumers (issue #28, epic #19, §8.1)
// =============================================================================
//
// An exporter's options have to be three things at once, and the whole point of
// this file is that they are ONE declaration rather than three:
//
//   1. a **Zod schema**, because `POST /:id/exports` validates the body through
//      the global `ZodValidationPipe` and an unvalidated option would reach a
//      renderer as `undefined` and silently change the output;
//   2. a **published description**, because `GET /api/transcripts/exporters`
//      tells the export dialog what to draw, and the dialog must not carry a
//      second copy of "Markdown has an `includeTimestamps` boolean";
//   3. a **hash input**, because spec §8.5 reuses an existing export keyed on
//      `{ format, version, options }` and two requests that render identical
//      bytes must produce the same `options_hash`.
//
// Declaring the fields and DERIVING the schema from them is what makes (1) and
// (2) unable to drift. The alternative — a Zod schema plus a hand-written
// descriptor list beside it — is a pair somebody eventually edits one half of,
// and the symptom is a checkbox in the dialog that the API rejects, or worse,
// one it silently ignores.
//
// -----------------------------------------------------------------------------
// BOOLEANS ONLY, DELIBERATELY, FOR NOW
// -----------------------------------------------------------------------------
//
// All five options across the three v1 exporters are switches. `type` is
// declared as a union of one member rather than omitted so that adding a
// `select` or a `number` later is an additive change to this file and a
// compiler error at every site that renders a field — instead of a silent
// widening the dialog quietly draws as a checkbox.
//
// -----------------------------------------------------------------------------
// THE SCHEMA IS STRICT, AND THAT IS A CHOICE ABOUT SILENCE
// -----------------------------------------------------------------------------
//
// An unknown key is a 400, not a stripped field. Stripping is friendlier to a
// stale client and worse for everybody else: somebody who sends
// `{ includeTimestamp: true }` (singular, a plausible typo) would otherwise get
// a perfectly successful export with timestamps they did not ask for, no error
// anywhere, and no way to tell from the response that the option never applied.
// The reuse lookup makes that worse rather than better — the typo'd request
// hashes to the SAME key as the default request, so they would also be handed
// back somebody else's already-rendered file as if it were theirs.
//
// -----------------------------------------------------------------------------
// THE HASH IS OVER THE PARSED OPTIONS, NEVER THE RAW BODY
// -----------------------------------------------------------------------------
//
// `{}` and `{ "includeTimestamps": true }` describe the same Markdown file when
// `includeTimestamps` defaults to true, and they must reuse each other's
// render. Hashing the raw body would make them different keys and render the
// identical document twice; hashing the PARSED options — defaults applied, keys
// sorted — makes "same bytes ⇒ same hash" true by construction.
// =============================================================================

import { createHash } from 'node:crypto';
import { z } from 'zod';

/** One option an exporter accepts, as both a schema and a piece of UI. */
export interface ExportOptionField {
  /** The key in the options object. Permanent once published, like a format. */
  key: string;
  /** Sentence-case label for the dialog's checkbox. */
  label: string;
  /** One line under the label saying what turning it on actually does. */
  description: string;
  /** See the header: a union of one, on purpose. */
  type: 'boolean';
  /** What this option is when the request does not mention it. */
  default: boolean;
}

/** Options as every renderer receives them: defaults applied, nothing absent. */
export type ExportOptions = Record<string, boolean>;

/** The schema shape `optionsSchemaFor` produces. */
export type ExportOptionsSchema = z.ZodType<ExportOptions, unknown>;

/**
 * The Zod schema for a field list.
 *
 * `z.strictObject`, so an unknown key is refused rather than stripped — see the
 * header. Every field is optional-with-a-default, so an omitted options object
 * is legal and parses to the full defaults.
 */
export function optionsSchemaFor(fields: readonly ExportOptionField[]): ExportOptionsSchema {
  const shape: Record<string, z.ZodType<boolean, unknown>> = {};

  for (const field of fields) {
    shape[field.key] = z
      .boolean()
      .default(field.default)
      .describe(field.description) as unknown as z.ZodType<boolean, unknown>;
  }

  return z.strictObject(shape) as unknown as ExportOptionsSchema;
}

/** The all-defaults options for a field list, for a request that sent none. */
export function defaultOptions(fields: readonly ExportOptionField[]): ExportOptions {
  return Object.fromEntries(fields.map((field) => [field.key, field.default]));
}

/**
 * A value as canonical JSON: object keys sorted, recursively.
 *
 * `JSON.stringify` preserves insertion order, so `{a:1,b:2}` and `{b:2,a:1}`
 * stringify differently while describing the same options — and would then
 * hash differently, rendering the same file twice. Sorting removes that.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';

  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);

  return `{${entries.join(',')}}`;
}

/**
 * The `options_hash` spec §8.5 reuses an export by.
 *
 * ⚠ `format` AND `version` ARE INSIDE THE HASH even though both are also
 * columns the lookup filters on. It costs nothing and it removes a whole class
 * of future mistake: a query that forgot one of them cannot then match a row
 * rendered for a different version, because the hash itself would differ.
 */
export function hashExportRequest(input: {
  format: string;
  version: number;
  options: ExportOptions;
  /**
   * Anything OTHER than the version that changes what the rendered file says.
   *
   * A transcript's speaker identities (#323) are the case that needed it: naming
   * "Speaker A" as "Oscar" changes every export's speaker column without moving
   * the version, so an export of v7 rendered before the naming must not be
   * handed back after it. Included in the hash ONLY when present, so that every
   * existing row's hash — and every note export's, which never passes one —
   * stays byte-for-byte what it was.
   */
  contentFingerprint?: string | null;
}): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        format: input.format,
        version: input.version,
        options: input.options,
        ...(input.contentFingerprint ? { contentFingerprint: input.contentFingerprint } : {}),
      }),
    )
    .digest('hex');
}
