// =============================================================================
// Chunked extraction helpers (#777, epic #773; docs/specs/ontology.md §6.6)
// =============================================================================
//
// PURE glue between the chunker, the prompt and the validator: which chunks a
// note has, the per-chunk context the prompt and the validator read, and the
// shift that turns a chunk-relative citation offset into a note-absolute one.
// A note that came from a transcript is never chunked: its body is a summary
// and its transcript lines are cited by id.
//
// A note GENERATED FROM A DOCUMENT (#789) chunks the stored source text instead
// of its own body: the body is a summary, the text is the document. The summary
// is shown whole in every chunk as context, and a source-text citation's
// chunk-relative offsets are shifted to absolute offsets in the whole text.
// =============================================================================

import { planChunks, type BodyChunk, type CountTokens } from './chunker.js';
import type { ExtractionContext } from './extraction-context.js';
import type { PromptChunk } from './prompt.js';
import type { ChunkOutcome } from './merge-chunks.js';

/** The chunks of this run's input text: the source document's text when there is one, else the note body. */
export function chunksFor(ctx: ExtractionContext, countTokens: CountTokens): BodyChunk[] {
  return planChunks(ctx.source?.text ?? ctx.note.body, countTokens, { allowSplit: ctx.transcript === null });
}

/**
 * The context one chunk's prompt and validation read: the input text is the chunk's text.
 * With a source document that is the source text (the note stays whole, as context).
 */
export function chunkContext(ctx: ExtractionContext, chunk: BodyChunk): ExtractionContext {
  if (chunk.count === 1) return ctx;
  if (ctx.source) return { ...ctx, source: { ...ctx.source, text: chunk.text } };
  return { ...ctx, note: { ...ctx.note, body: chunk.text } };
}

export function promptChunk(chunk: BodyChunk): PromptChunk {
  return { index: chunk.index, count: chunk.count, leadIn: chunk.leadIn };
}

/**
 * Make note-evidence offsets (relative to the chunk text) absolute in the note body, and
 * source-text-evidence offsets absolute in the whole source text. A run has one input
 * text: its chunk is of the source when `chunkedSource` is true, else of the note.
 */
export function shiftToNote(outcome: ChunkOutcome, chunk: BodyChunk, chunkedSource = false): ChunkOutcome {
  if (chunk.start === 0) return outcome;
  const shift = <T extends { charStart: number | null; charEnd: number | null }>(e: T): T =>
    e.charStart !== null && e.charEnd !== null ? { ...e, charStart: e.charStart + chunk.start, charEnd: e.charEnd + chunk.start } : e;
  return {
    ...outcome,
    rows: outcome.rows.map((row) => ({
      ...row,
      evidence: row.evidence.map((e) => {
        // A `N` (note) citation in a source run is located in the WHOLE note: already absolute.
        if (chunkedSource) return e.source === 'source_text' ? shift(e) : e;
        return e.source === 'note' ? shift(e) : e;
      }),
    })) as ChunkOutcome['rows'],
  };
}
