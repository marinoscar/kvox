// =============================================================================
// Resume state of a chunked extraction (#777; docs/specs/ontology.md §6.6)
// =============================================================================
//
// A multi-chunk `kg.extract` saves each finished chunk's validated answer on the
// proposal while it is `extracting`, so a job the queue runs again (a deferred
// rate limit, a reaped lease) continues after the last completed chunk instead
// of re-spending the user's key. It lives in `kg_proposals.commit_log`, the
// proposal's internal JSON column that is never serialized to clients and is
// empty until a commit; it is cleared when the draft is finalized or fails.
// No schema change. `stats.chunks` is the client-visible progress.
// =============================================================================

import type { BodyChunk } from './chunker.js';
import type { ChunkOutcome } from './merge-chunks.js';

export interface ChunkResume {
  kind: 'extract_resume';
  v: 1;
  noteVersion: number;
  /** `[start, end]` of every chunk: a resume only applies to the same split. */
  spans: Array<[number, number]>;
  done: ChunkOutcome[];
  usage: { inputTokens: number; outputTokens: number };
  truncationRetry: boolean;
}

export function newResume(noteVersion: number, chunks: BodyChunk[]): ChunkResume {
  return {
    kind: 'extract_resume',
    v: 1,
    noteVersion,
    spans: chunks.map((c) => [c.start, c.end]),
    done: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    truncationRetry: false,
  };
}

/** The saved state when it belongs to exactly this split of this note version; else null. */
export function readResume(raw: unknown, noteVersion: number, chunks: BodyChunk[]): ChunkResume | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Partial<ChunkResume>;
  if (r.kind !== 'extract_resume' || r.v !== 1 || r.noteVersion !== noteVersion) return null;
  if (!Array.isArray(r.spans) || r.spans.length !== chunks.length) return null;
  if (!r.spans.every((s, i) => s[0] === chunks[i].start && s[1] === chunks[i].end)) return null;
  if (!Array.isArray(r.done) || r.done.length > chunks.length || !r.usage) return null;
  return r as ChunkResume;
}
