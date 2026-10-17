import type { InputJsonValue } from './data/prisma.js';
import type { KvoxTranscriptsTx } from './data/transcripts-db.js';
import type { SegmentOriginValue, TimedWord, WordsAlignmentValue } from './editing/editing-state.js';

// =============================================================================
// Writing a transcript's version 1 (issues #25 and #571; spec §4.4)
// =============================================================================
//
// Two paths create a transcript's first content: `transcription.ingest` (what the
// provider said) and the JSON import (`POST /api/transcripts/imports`, what a
// `kvox.transcript/v1` file says). Both must leave EXACTLY the same shape behind —
// speaker rows, segment rows with gap-based ordinals, and the one
// `transcript_versions` row of `kind: ai_original` with `ops: []` and no author —
// because every later reader (materialize, the snapshot job, the editor, the
// export) assumes that shape for version 1. So the three writes live here, once,
// and both callers run them inside their own transaction.
//
// Not in `editing/`: this writes rows, and that directory stays pure.
// =============================================================================

/**
 * One speaker row to create. `key` is the caller's own handle for it (the provider's
 * label at ingest, the file's speaker id at import), used to point segments at it.
 *
 * @stability experimental
 */
export interface OriginalSpeakerInput {
  /** The caller's handle; segments name it in `speakerKey`. */
  key: string;
  /** `transcript_speakers.label`. */
  label: string | null;
  /** `transcript_speakers.display_name`. */
  displayName: string;
  /** `transcript_speakers.color_index`. */
  colorIndex: number;
}

/**
 * One segment row to create.
 *
 * @stability experimental
 */
export interface OriginalSegmentInput {
  /** The {@link OriginalSpeakerInput.key} of its speaker. */
  speakerKey: string;
  /** Start, in milliseconds (a non-negative integer). */
  startMs: number;
  /** End, in milliseconds (a non-negative integer). */
  endMs: number;
  /** The gap-based ordinal (spec §3.4). */
  ordinal: number;
  /** The text. */
  text: string;
  /** The word timings, in the column's terse shape. */
  words: TimedWord[];
  /** How far to trust `words`. */
  wordsAlignment: WordsAlignmentValue;
  /** The segment confidence, 0 to 1, or null. */
  confidence: number | null;
  /** Who wrote the text. */
  origin: SegmentOriginValue;
}

/**
 * Creates the speakers, the segments and the version-1 row of a transcript, on `tx`.
 *
 * @param tx - the caller's transaction.
 * @param input - the transcript, its rows and the version summary.
 * @returns each speaker's key mapped to the id of the row created for it.
 * @throws Error when a segment names a key no speaker carries (a caller bug, never input).
 * @stability experimental
 */
export async function writeOriginalVersion(
  tx: KvoxTranscriptsTx,
  input: {
    transcriptId: string;
    speakers: readonly OriginalSpeakerInput[];
    segments: readonly OriginalSegmentInput[];
    summary: string;
  },
): Promise<Map<string, string>> {
  const speakerIds = new Map<string, string>();

  for (const speaker of input.speakers) {
    const created = await tx.transcriptSpeaker.create({
      data: {
        transcriptId: input.transcriptId,
        label: speaker.label,
        displayName: speaker.displayName,
        colorIndex: speaker.colorIndex,
      },
      select: { id: true },
    });

    speakerIds.set(speaker.key, created.id);
  }

  // `createMany` rather than a create per segment: a six-hour recording is
  // thousands of rows, and one statement is the difference between a
  // transaction measured in milliseconds and one measured in minutes.
  const segments = input.segments.map((segment) => {
    const speakerId = speakerIds.get(segment.speakerKey);

    if (speakerId === undefined) {
      throw new Error(`A segment names speaker "${segment.speakerKey}", which is not being created.`);
    }

    return {
      transcriptId: input.transcriptId,
      speakerId,
      startMs: segment.startMs,
      endMs: segment.endMs,
      ordinal: segment.ordinal,
      text: segment.text,
      words: segment.words as unknown as InputJsonValue,
      wordsAlignment: segment.wordsAlignment,
      confidence: segment.confidence,
      origin: segment.origin,
    };
  });

  if (segments.length > 0) {
    await tx.transcriptSegment.createMany({ data: segments });
  }

  await tx.transcriptVersion.create({
    data: {
      transcriptId: input.transcriptId,
      version: 1,
      kind: 'ai_original',
      // ⚠ `authorId: null` MEANS "THE ORIGINAL", and that is the schema's own
      // convention (spec §4.5) rather than a missing value. A version
      // attributed to a user is one a user made.
      authorId: null,
      summary: input.summary,
      ops: [] as unknown as InputJsonValue,
    },
  });

  return speakerIds;
}

/**
 * Words in a transcript: the word timings when a segment has them, else its
 * whitespace-separated tokens (a provider that diarizes without word timings, or a
 * file exported without them, still has words).
 *
 * @param segments - each segment's text and word array.
 * @returns the count.
 * @stability experimental
 */
export function countSegmentWords(
  segments: ReadonlyArray<{ text: string; words: readonly unknown[] }>,
): number {
  return segments.reduce((total, segment) => {
    if (segment.words.length > 0) return total + segment.words.length;

    return total + segment.text.trim().split(/\s+/).filter(Boolean).length;
  }, 0);
}
