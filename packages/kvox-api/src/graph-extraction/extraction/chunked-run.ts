// =============================================================================
// Chunked extraction helpers (#777, epic #773; docs/specs/ontology.md §6.6)
// =============================================================================
//
// PURE glue between the chunker, the prompt and the validator: which chunks a
// note has, the per-chunk context the prompt and the validator read, and the
// shift that turns a chunk-relative citation offset into a note-absolute one.
// A note that came from a transcript is never chunked: its body is a summary
// and its transcript lines are cited by id.
// =============================================================================

import { planChunks, type BodyChunk, type CountTokens } from './chunker.js';
import type { ExtractionContext } from './extraction-context.js';
import type { PromptChunk } from './prompt.js';
import type { ChunkOutcome } from './merge-chunks.js';

/** The chunks of this run's note body. */
export function chunksFor(ctx: ExtractionContext, countTokens: CountTokens): BodyChunk[] {
  return planChunks(ctx.note.body, countTokens, { allowSplit: ctx.transcript === null });
}

/** The context one chunk's prompt and validation read: the body is the chunk's text. */
export function chunkContext(ctx: ExtractionContext, chunk: BodyChunk): ExtractionContext {
  if (chunk.count === 1) return ctx;
  return { ...ctx, note: { ...ctx.note, body: chunk.text } };
}

export function promptChunk(chunk: BodyChunk): PromptChunk {
  return { index: chunk.index, count: chunk.count, leadIn: chunk.leadIn };
}

/** Make note-evidence offsets (relative to the chunk text) absolute in the note body. */
export function shiftToNote(outcome: ChunkOutcome, chunk: BodyChunk): ChunkOutcome {
  if (chunk.start === 0) return outcome;
  return {
    ...outcome,
    rows: outcome.rows.map((row) => ({
      ...row,
      evidence: row.evidence.map((e) =>
        e.source === 'note' && e.charStart !== null && e.charEnd !== null
          ? { ...e, charStart: e.charStart + chunk.start, charEnd: e.charEnd + chunk.start }
          : e,
      ),
    })) as ChunkOutcome['rows'],
  };
}
