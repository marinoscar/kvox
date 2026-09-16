// =============================================================================
// CHUNKING A TRANSCRIPT (issue #186, epic #165)
// =============================================================================
//
// ⚠ PURE. See `chunk.types.ts`'s header for why that is the requirement.
//
// -----------------------------------------------------------------------------
// WHY THE INPUT TYPE IS STRUCTURAL AND NOT A PRISMA TYPE
// -----------------------------------------------------------------------------
//
// `ChunkableSegment` is the NARROWEST shape this function actually reads:
// `ordinal`, `text`, `speakerLabel`. It deliberately does not import
// `TranscriptSegment` from `@prisma/client`, and deliberately does not require
// the `id`, `startMs` and `endMs` a real row carries.
//
// Importing the Prisma type would couple a pure function to a generated client,
// drag the whole schema into every test that wants to chunk three lines of
// dialogue, and make a column rename in an unrelated part of the transcript
// model a compile error here. Taking a structural type instead means the
// caller — the `search.index` job of a later issue — passes its rows straight
// in (a `TranscriptSegment` structurally satisfies this), while a test builds
// literals by hand.
//
// -----------------------------------------------------------------------------
// WHY THE SPEAKER LABEL IS CARRIED INTO THE CHUNK TEXT
// -----------------------------------------------------------------------------
//
// "What did Alice say about the migration?" is a question about a speaker, and
// a chunk containing only the words has nothing for the speaker half of it to
// match. The label goes into the embedded text, at the head of the line it
// belongs to.
//
// It is emitted only when it CHANGES, and again at the head of each chunk. A
// label repeated on forty consecutive lines of one person talking spends a
// tenth of the budget on the same eleven characters and pulls the embedding
// toward the name and away from the subject; emitting it once per run of lines
// says exactly as much. Re-emitting at a chunk boundary is the other half of
// the same rule: a chunk that opens mid-monologue would otherwise be
// unattributed prose.
// =============================================================================

import {
  Chunk,
  CHUNK_OVERLAP_CHARS,
  MAX_CHUNK_CHARS,
  MAX_SPEAKER_LABEL_CHARS,
  OVERLAP_SENTENCE_LOOKAHEAD_CHARS,
} from './chunk.types';
import { ChunkUnit, packChunks } from './chunk-packer';

/**
 * The narrowest transcript segment this module reads. A Prisma
 * `TranscriptSegment` satisfies it structurally; so does an object literal.
 */
export interface ChunkableSegment {
  /** Position within the transcript. Gap-based float; see `editing/ordinals`. */
  readonly ordinal: number;
  /** The segment's current text. */
  readonly text: string;
  /**
   * The diarized speaker's display label — the provider's letter (`'A'`), or a
   * name the user corrected it to. `null`/`undefined` for a transcript with no
   * diarization, which chunks perfectly well without labels.
   */
  readonly speakerLabel?: string | null;
}

/** The separator between segments in the reconstructed source body. */
export const TRANSCRIPT_SEGMENT_SEPARATOR = '\n';

interface NormalizedLine {
  readonly text: string;
  readonly decoration: string;
}

/**
 * Segments in `ordinal` order, trimmed, with blank ones dropped and speaker
 * labels normalized.
 *
 * `Array.prototype.sort` is stable in every JavaScript engine since ES2019, so
 * two segments sharing an ordinal keep their input order — a total order rather
 * than an engine-dependent one, which is what determinism requires. The
 * comparison is arithmetic, never `localeCompare`.
 */
function normalizeSegments(
  segments: readonly ChunkableSegment[],
): NormalizedLine[] {
  return [...segments]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((segment) => {
      const label = (segment.speakerLabel ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_SPEAKER_LABEL_CHARS)
        .trim();
      return {
        text: segment.text.trim(),
        decoration: label.length > 0 ? `${label}: ` : '',
      };
    })
    .filter((line) => line.text.length > 0);
}

/**
 * The reconstructed source body `Chunk.charStart`/`charEnd` index: every
 * segment trimmed, blank segments dropped, one segment per line.
 *
 * Exported because those offsets are meaningless without it. A later snippet or
 * highlight feature calls this on the same segments, slices the result, and
 * gets exactly the region the chunk was built from — rather than guessing at a
 * reconstruction and landing a few characters off on every transcript whose
 * segments happened to carry trailing whitespace.
 */
export function transcriptSourceBody(
  segments: readonly ChunkableSegment[],
): string {
  return normalizeSegments(segments)
    .map((line) => line.text)
    .join(TRANSCRIPT_SEGMENT_SEPARATOR);
}

/**
 * Cuts a transcript into bounded, overlapping, speaker-labelled chunks.
 *
 * Empty input, or input whose every segment is blank, returns `[]` — an empty
 * document has nothing to embed, and a single empty chunk would cost a vector
 * and match everything weakly.
 */
export function chunkTranscript(
  segments: readonly ChunkableSegment[],
): Chunk[] {
  const lines = normalizeSegments(segments);
  if (lines.length === 0) return [];

  const units: ChunkUnit[] = [];
  let offset = 0;
  lines.forEach((line, index) => {
    const separator = index === 0 ? '' : TRANSCRIPT_SEGMENT_SEPARATOR;
    offset += separator.length;
    units.push({
      source: line.text,
      sourceStart: offset,
      decoration: line.decoration,
      precedingSeparator: separator,
    });
    offset += line.text.length;
  });

  return packChunks(units, {
    prefix: '',
    maxChars: MAX_CHUNK_CHARS,
    overlapChars: CHUNK_OVERLAP_CHARS,
    sentenceLookaheadChars: OVERLAP_SENTENCE_LOOKAHEAD_CHARS,
  });
}
