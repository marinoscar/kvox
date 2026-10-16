// =============================================================================
// NormalizedTranscript — the one shape every provider is flattened into (#23)
// =============================================================================
//
// A transcription provider's own result is its own business: AssemblyAI returns
// `utterances[]` with `speaker`/`start`/`end`, a different vendor returns
// `results.channels[].alternatives[].words[]`, a third returns SRT. Everything
// downstream of this module — the editor, playback, search, export — reads
// exactly one shape, declared here, so adding a provider never touches a
// consumer.
//
// THE RAW RESPONSE IS KEPT TOO. `TranscriptionProvider.fetchResult` returns
// `{ raw, normalized }`, not just this: a normalization bug that drops a field
// must be repairable from stored data rather than by re-running (and re-paying
// for) the job. This type is therefore a PROJECTION, never the record of truth.
//
// -----------------------------------------------------------------------------
// WHY SEGMENTS ARE SPLIT AT ~45 SECONDS
// -----------------------------------------------------------------------------
//
// Diarized providers emit one "utterance" per uninterrupted speaker turn, and a
// turn is not bounded: a lecture, a deposition or a podcast monologue routinely
// produces a single utterance several minutes long. That is a perfectly correct
// transcript and a useless editing unit — a segment is what the UI seeks to,
// highlights while playing, and lets someone correct in place, and a four-minute
// block is none of those things.
//
// So `splitLongSegment` below cuts at SENTENCE PUNCTUATION, which is the only
// boundary that is both cheap to detect and meaningful to a reader, and falls
// back to a word count when a stretch of speech has no punctuation at all
// (dictation without punctuation commands, a provider model that does not
// punctuate, a language whose punctuation this heuristic does not know).
//
// THE ONE RULE THE SPLIT MUST NEVER BREAK: every word of the input appears in
// exactly one output segment, in order. Duplicating a word duplicates its audio
// range and makes two segments claim the same moment; dropping one loses
// transcript text with no error anywhere. `partitionWords` is the only function
// that moves words between segments, and it is a pure `slice` walk over one
// array for exactly that reason.
// =============================================================================

/** One word, with the timings the provider measured. */
export interface NormalizedWord {
  text: string;
  /** Milliseconds from the start of the media. */
  startMs: number;
  /** Milliseconds from the start of the media. */
  endMs: number;
  /**
   * The provider's confidence in this word, 0..1, or `null` when it reported
   * none. NULLABLE RATHER THAN DEFAULTED TO 1: "the provider is certain" and
   * "the provider did not say" are different facts, and a UI that dims
   * low-confidence words must not dim-or-not based on a number nobody produced.
   */
  confidence: number | null;
}

/** One speaker turn, or one slice of a long turn. See the header for the split. */
export interface NormalizedSegment {
  /** The provider's speaker label, verbatim (`"A"`, `"speaker_1"`, …). */
  speakerLabel: string;
  startMs: number;
  endMs: number;
  text: string;
  /** 0..1, or `null` when the provider reported none. */
  confidence: number | null;
  /**
   * The words of this segment, in order.
   *
   * Possibly EMPTY: a provider that diarizes but does not emit word timings is
   * a real configuration, and an empty array says so honestly rather than
   * inventing evenly-spaced timings nobody measured.
   */
  words: NormalizedWord[];
}

/**
 * A distinct speaker in this transcript.
 *
 * An object rather than a bare string so a later issue can attach a
 * human-assigned name without changing this type's shape — and therefore
 * without a migration of every stored transcript.
 */
export interface NormalizedSpeaker {
  label: string;
}

/** Which provider produced this, and what it called the job on its side. */
export interface NormalizedTranscriptProvider {
  /** `TranscriptionProvider.id`, e.g. `'assemblyai'`. */
  id: string;
  /** The model the provider actually used, or `null` when it did not say. */
  model: string | null;
  /** The provider's own job id — what `deleteRemote` and `getStatus` address. */
  remoteId: string;
}

/** The provider-independent transcript. */
export interface NormalizedTranscript {
  /** BCP-47-ish language code as the provider reported it, or `null`. */
  language: string | null;
  /** Media duration in MILLISECONDS. Providers that report seconds convert here. */
  durationMs: number;
  speakers: NormalizedSpeaker[];
  segments: NormalizedSegment[];
  provider: NormalizedTranscriptProvider;
}

/**
 * The longest segment this normalization will emit, in milliseconds.
 *
 * 45 seconds is a compromise with two hard edges: short enough that a segment
 * is a usable editing and seeking unit, long enough that ordinary conversational
 * turns (which are seconds, not minutes) are never cut mid-thought. It is a
 * CEILING, not a target — a natural 50-second turn with one sentence boundary at
 * 30s becomes 30s + 20s, not two 25s halves.
 */
export const MAX_SEGMENT_MS = 45_000;

/**
 * Words per chunk when a stretch of speech offers no sentence boundary at all.
 *
 * Only reached by the fallback path below, and deliberately generous: cutting
 * unpunctuated speech is guessing, so the guess should be rare and coarse
 * rather than frequent and confident.
 */
export const FALLBACK_WORDS_PER_SEGMENT = 60;

/**
 * Does this token end a sentence?
 *
 * Matched at the END of the token so that `"Dr."` is not treated as a boundary
 * by accident — it is, and that is a known and accepted false positive of every
 * punctuation heuristic; the cost is one extra segment boundary, never a lost or
 * duplicated word. The closing-quote/bracket class after the terminator is what
 * keeps `he said "stop."` from being missed.
 */
export function endsSentence(token: string): boolean {
  return /[.!?…][)\]"'”’»]*$/.test(token.trim());
}

/** Duration of a contiguous word run. Zero for an empty run. */
function spanMs(words: NormalizedWord[]): number {
  if (words.length === 0) return 0;
  return words[words.length - 1].endMs - words[0].startMs;
}

/**
 * Mean of the confidences that exist, or `null` when none do.
 *
 * A segment produced by a split has no confidence of its own — the provider
 * scored the whole utterance — so it is derived from the words that landed in
 * it. `null` in, `null` out: see `NormalizedWord.confidence` for why a missing
 * confidence is never silently 1.
 */
function meanConfidence(words: NormalizedWord[]): number | null {
  const scored = words.filter(
    (word): word is NormalizedWord & { confidence: number } =>
      typeof word.confidence === 'number' && Number.isFinite(word.confidence),
  );

  if (scored.length === 0) return null;

  const total = scored.reduce((sum, word) => sum + word.confidence, 0);
  return total / scored.length;
}

/**
 * Cut one word array into runs no longer than `maxMs`, preferring sentence
 * boundaries.
 *
 * EXHAUSTIVE AND DISJOINT BY CONSTRUCTION: the walk only ever `slice`s a prefix
 * off `pending` and pushes it, so every input word lands in exactly one run, in
 * order. That property is the whole reason this is a separate function with its
 * own test rather than a loop inside the segment builder.
 *
 * The `while` (rather than `if`) matters: after cutting at a sentence boundary
 * the REMAINDER can itself already be over the limit, and re-checking
 * immediately is what stops a single 90-second run from surviving because the
 * boundary happened to fall early.
 */
export function partitionWords(
  words: NormalizedWord[],
  maxMs: number = MAX_SEGMENT_MS,
  fallbackWords: number = FALLBACK_WORDS_PER_SEGMENT,
): NormalizedWord[][] {
  if (words.length === 0) return [];

  const runs: NormalizedWord[][] = [];
  let pending: NormalizedWord[] = [];
  // Index WITHIN `pending` of the last word that ended a sentence, or -1.
  let lastBoundary = -1;

  for (const word of words) {
    pending.push(word);
    if (endsSentence(word.text)) {
      lastBoundary = pending.length - 1;
    }

    while (spanMs(pending) > maxMs) {
      let cutAfter: number;

      if (lastBoundary >= 0) {
        // The preferred cut: end the run on a finished sentence.
        cutAfter = lastBoundary;
      } else {
        // NO PUNCTUATION IN THIS STRETCH. Fall back to a word count, bounded
        // by TWO clamps that are both load-bearing:
        //
        //   • `pending.length - 2` — cut BEFORE the word that pushed the run
        //     over, so the piece that is emitted is actually under the limit.
        //     Cutting at `length - 1` would emit the over-long run itself,
        //     which is the bug this whole function exists to prevent and is
        //     invisible unless the run is shorter than `fallbackWords`.
        //   • `Math.max(…, 0)` — never a negative index, so a single word
        //     longer than `maxMs` (a stall in the provider's timings, a
        //     mis-aligned long pause) is emitted alone rather than spinning
        //     here forever.
        cutAfter = Math.max(
          Math.min(fallbackWords - 1, pending.length - 2),
          0,
        );
      }

      runs.push(pending.slice(0, cutAfter + 1));
      pending = pending.slice(cutAfter + 1);
      // Every boundary seen so far was at or before the cut, so the remainder
      // has none until a later word supplies one.
      lastBoundary = -1;
    }
  }

  if (pending.length > 0) {
    runs.push(pending);
  }

  return runs;
}

/**
 * Split one segment into segments no longer than `maxMs`.
 *
 * Returns `[segment]` unchanged when it is already short enough, and — this is
 * deliberate — also when it is long but carries NO WORDS. Splitting a
 * word-less segment would mean inventing timings and cutting text at a
 * character offset that corresponds to nothing the provider measured; a long
 * un-split segment is a worse editing experience, but it is not fiction.
 *
 * `text` of a produced segment is its words joined with single spaces. The
 * provider's original spacing is not recoverable from the word array, and
 * re-slicing the original string by character offset is exactly the kind of
 * guess that silently loses a character. The full original text survives in the
 * `raw` payload `fetchResult` returns alongside this.
 */
export function splitLongSegment(
  segment: NormalizedSegment,
  maxMs: number = MAX_SEGMENT_MS,
  fallbackWords: number = FALLBACK_WORDS_PER_SEGMENT,
): NormalizedSegment[] {
  if (segment.endMs - segment.startMs <= maxMs) return [segment];
  if (segment.words.length === 0) return [segment];

  const runs = partitionWords(segment.words, maxMs, fallbackWords);

  if (runs.length <= 1) return [segment];

  return runs.map((run) => ({
    speakerLabel: segment.speakerLabel,
    startMs: run[0].startMs,
    endMs: run[run.length - 1].endMs,
    text: run.map((word) => word.text).join(' '),
    confidence: meanConfidence(run),
    words: run,
  }));
}

/**
 * Apply {@link splitLongSegment} across a whole transcript's segments.
 *
 * The single call site every provider's normalizer ends with, so "how long may
 * a segment be" is one constant in one file rather than a rule each provider
 * re-implements slightly differently.
 */
export function splitLongSegments(
  segments: NormalizedSegment[],
  maxMs: number = MAX_SEGMENT_MS,
  fallbackWords: number = FALLBACK_WORDS_PER_SEGMENT,
): NormalizedSegment[] {
  return segments.flatMap((segment) =>
    splitLongSegment(segment, maxMs, fallbackWords),
  );
}

/**
 * The distinct speaker labels of a segment list, in first-appearance order.
 *
 * First-appearance rather than alphabetical: a UI colouring speakers wants
 * "whoever spoke first is speaker one", and alphabetical ordering of `"A"`,
 * `"B"`, `"C"` only coincidentally agrees with that.
 */
export function collectSpeakers(
  segments: NormalizedSegment[],
): NormalizedSpeaker[] {
  const seen = new Set<string>();
  const speakers: NormalizedSpeaker[] = [];

  for (const segment of segments) {
    if (seen.has(segment.speakerLabel)) continue;
    seen.add(segment.speakerLabel);
    speakers.push({ label: segment.speakerLabel });
  }

  return speakers;
}
