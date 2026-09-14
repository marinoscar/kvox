// =============================================================================
// `note.source.extract` — the result a node posts back (issue #51, epic #45)
// =============================================================================
//
// THE TRUST BOUNDARY for the notes epic's one node-eligible job type. Every
// field below arrives from a machine this deployment may not own, over HTTP,
// from a build that may be older than this server's. `NodesService
// .submitResult` parses against this schema and `NoteSourceExtractHandler
// .persistNodeResult` writes whatever survives — so a field this schema accepts
// is a field that reaches the database, and `text` specifically is a field that
// reaches a language model on a user's own paid account.
//
// -----------------------------------------------------------------------------
// WHY IT CARRIES A FAILURE ARM AND NOT ONLY `{ text, pageCount, encoding }`
// -----------------------------------------------------------------------------
//
// Because the permanent failures — an encrypted PDF, a scan with no text layer,
// a corrupt file — are ANSWERS, not errors (see `notes/extraction/
// extraction-result.ts`), and a node that reaches one has SUCCEEDED at
// determining them. With a success-only schema, a node's only way to say "this
// PDF is password-protected" would be `POST .../failure`, which charges an
// attempt, schedules a retry, and sends the identical file to the identical
// extractor to reach the identical conclusion until the attempt budget runs
// out. The user would then see a generic job failure instead of the sentence
// that tells them what to do about it.
//
// So `outcome` discriminates, and BOTH values settle the job — mirroring
// exactly what the server-side path does with the same outcome, which is what
// lets the two paths share one write method.
//
// -----------------------------------------------------------------------------
// WHY IT IS A FLAT OBJECT WITH A REFINEMENT, NOT A `discriminatedUnion`
// -----------------------------------------------------------------------------
//
// A discriminated union is the more expressive Zod, and it is the wrong shape
// HERE because of the schema's second reader. `GET /api/nodes/job-types`
// publishes every node result schema through `z.toJSONSchema()`, and a union
// converts to a bare `oneOf` with no top-level `type` or `properties` — which
// `test/nodes/node-data-plane.integration.spec.ts` asserts against for every
// node-eligible type, because a client generating a form or a struct from the
// published schema needs a described object rather than a choice of two.
//
// The flat shape keeps that contract and loses nothing: `superRefine` still
// rejects every inconsistent combination at parse time, which is where the
// trust boundary actually is. What JSON Schema cannot express, the parser
// still enforces.
//
// -----------------------------------------------------------------------------
// WHY THIS FILE IMPORTS FROM `notes/extraction/`
// -----------------------------------------------------------------------------
//
// The two enums below — the failure reasons and the encodings — are DOMAIN
// values owned by the pure extraction core, not wire values owned by this
// schema. Restating them here would be the classic two-copies bug: a node could
// post a reason the server has no sentence for, or the server could grow a
// reason no node is allowed to report, and nothing would fail the build.
//
// The import is safe and one-directional: `notes/extraction/` is pure — no Nest
// decorators, no injection, and no import of its own out of this module — so
// there is no cycle and no provider graph involved. The sibling contracts in
// this folder import nothing because their vocabularies (a hex digest, an audio
// codec) have no domain module to own them.
//
// -----------------------------------------------------------------------------
// WHY `text` IS CAPPED HERE RATHER THAN "VALIDATED LATER"
// -----------------------------------------------------------------------------
//
// A node is a remote machine posting a JSON body. Without a maximum, one
// malformed or malicious result is an unbounded string in this process's heap,
// then an unbounded row, then an unbounded prompt. The cap is generous — far
// more than any document a prompt budget would accept anyway — precisely so it
// is a STRUCTURAL bound rather than a policy knob: the real ceiling on what
// reaches a model is `ai.maxInputTokens`, which #49's budget applies to this
// text like any other source, and which refuses rather than truncates.
// =============================================================================

import { z } from 'zod';

import {
  EXTRACTION_ENCODINGS,
  EXTRACTION_FAILURE_REASONS,
  type ExtractionEncoding,
  type ExtractionFailureReason,
  type ExtractionOutcome,
} from '../../notes/extraction/extraction-result';

/** Structural ceiling on a node-submitted extraction, in characters. */
export const NOTE_SOURCE_EXTRACT_MAX_TEXT_CHARS = 16 * 1024 * 1024;

/** Structural ceiling on a reported page count. */
const MAX_PAGE_COUNT = 1_000_000;

/** What a node reports after extracting text from a document. */
export const noteSourceExtractResultSchema = z
  .object({
    /** Which of the two settled states the node reached. */
    outcome: z.enum(['extracted', 'unextractable']),

    /**
     * The extracted plain text, exactly as the node read it. `null` when
     * `outcome` is `unextractable`.
     *
     * `.min(1)` because an empty success is the one answer this schema must
     * refuse: it is indistinguishable from a scanned PDF, and accepting it
     * would store "the document had no text" as though it were text — which
     * then generates a fluent note about nothing, with no error anywhere.
     */
    text: z.string().min(1).max(NOTE_SOURCE_EXTRACT_MAX_TEXT_CHARS).nullable(),

    /**
     * Which permanent condition the node found. `null` when it found text.
     *
     * A CLOSED ENUM, shared with the server-side extractor rather than
     * restated, so a node cannot invent a reason string this application has no
     * sentence for — the UI renders `describeExtractionFailure(reason)`, and an
     * unknown reason would render as nothing useful at all.
     */
    reason: z.enum(EXTRACTION_FAILURE_REASONS).nullable(),

    /**
     * Pages, or `null` for a format that has none (and for a file that could
     * not be parsed far enough to count them).
     *
     * NULLABLE AND REQUIRED, not optional: "this format has no pages" and "I
     * forgot to send a page count" are different claims, and only the first is
     * a legitimate thing for a node to say.
     */
    pageCount: z.number().int().min(0).max(MAX_PAGE_COUNT).nullable(),

    /** How the bytes were decoded. `null` when `outcome` is `unextractable`. */
    encoding: z.enum(EXTRACTION_ENCODINGS).nullable(),
  })
  .superRefine((value, ctx) => {
    // What the JSON Schema above cannot say, the parser says. Every one of
    // these is a body that would otherwise be written to the database in a
    // state no code path can produce and no reader expects.
    if (value.outcome === 'extracted') {
      if (value.text === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['text'],
          message: 'text is required when outcome is "extracted"',
        });
      }

      if (value.encoding === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['encoding'],
          message: 'encoding is required when outcome is "extracted"',
        });
      }

      if (value.reason !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['reason'],
          message: 'reason must be null when outcome is "extracted"',
        });
      }

      return;
    }

    if (value.reason === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'reason is required when outcome is "unextractable"',
      });
    }

    if (value.text !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['text'],
        message: 'text must be null when outcome is "unextractable"',
      });
    }
  });

/** The parsed, trusted result — the only shape `persistNodeResult` may write. */
export type NoteSourceExtractResult = z.infer<typeof noteSourceExtractResultSchema>;

/**
 * A validated node result, as the domain outcome the shared write method takes.
 *
 * ⚠ THIS IS THE JOIN BETWEEN THE TWO EXECUTION PATHS, and it is deliberately a
 * pure conversion rather than a second interpretation: it renames nothing,
 * defaults nothing, and decides nothing. The server-side extractor already
 * produces an `ExtractionOutcome`; this turns the wire shape into the same
 * type, so `recordExtraction` is genuinely one function called with one kind of
 * argument rather than two similar functions kept in step by hand.
 *
 * The non-null assertions are sound because `superRefine` above has already
 * refused every combination in which they would be null — which is precisely
 * why the refinement is not optional polish.
 */
export function toExtractionOutcome(result: NoteSourceExtractResult): ExtractionOutcome {
  if (result.outcome === 'extracted') {
    return {
      outcome: 'extracted',
      text: result.text as string,
      pageCount: result.pageCount,
      encoding: result.encoding as ExtractionEncoding,
    };
  }

  return {
    outcome: 'unextractable',
    reason: result.reason as ExtractionFailureReason,
    pageCount: result.pageCount,
  };
}
