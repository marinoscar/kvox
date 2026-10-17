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
// reaches a model is #49's token budget (the model's own window, or a typed
// `ai.maxInputTokens` spend cap when one is set — #436), which applies to this
// text like any other source, and which refuses rather than truncates.
// =============================================================================

import {
  NOTE_SOURCE_EXTRACT_MAX_TEXT_CHARS,
  noteSourceExtractResultSchema,
  type NoteSourceExtractResult,
} from '@marinoscar/kvox-contract/notes';

import type {
  ExtractionEncoding,
  ExtractionFailureReason,
  ExtractionOutcome,
} from '../extraction/extraction-result.js';

// The schema itself lives in `@marinoscar/kvox-contract/notes` (issue #495), so a future
// `kvox-node` imports the very shape the server validates against. It is re-exported here,
// beside its handler, under the names the handler has always used.
export { NOTE_SOURCE_EXTRACT_MAX_TEXT_CHARS, noteSourceExtractResultSchema, type NoteSourceExtractResult };

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
 *
 * @stability experimental
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
