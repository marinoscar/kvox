// =============================================================================
// Voiceprint policy: which audio to fingerprint and when to suggest a name (#823)
// =============================================================================
//
// Pure functions, no I/O. The thresholds were calibrated on real read speech
// (see VOICEPRINT_SUGGESTION_DEFAULTS).
//
// A voiceprint is biometric data. These helpers never transmit anything.
// =============================================================================

/**
 * A stretch of one speaker's speech, in milliseconds from the start of the recording.
 *
 * @stability experimental
 */
export interface VoiceprintSegment {
  /** Start, in milliseconds. */
  startMs: number;
  /** End, in milliseconds. */
  endMs: number;
}

/**
 * What {@link selectVoiceprintWindows} takes.
 *
 * @stability experimental
 */
export interface VoiceprintWindowOptions {
  /** Segments shorter than this are dropped (before trimming). Default 1500. */
  minSegmentMs?: number;
  /** Trimmed from each edge of a kept segment. Default 200. */
  trimMs?: number;
  /** Stop adding windows once this much speech is selected. Default 30000. */
  maxTotalMs?: number;
}

/**
 * The defaults of {@link selectVoiceprintWindows}.
 *
 * @stability experimental
 */
export const VOICEPRINT_WINDOW_DEFAULTS: Readonly<Required<VoiceprintWindowOptions>> = Object.freeze({
  minSegmentMs: 1500,
  trimMs: 200,
  maxTotalMs: 30000,
});

/**
 * The windows chosen for one speaker.
 *
 * @stability experimental
 */
export interface VoiceprintWindows {
  /** The chosen windows, sorted by start. */
  windows: VoiceprintSegment[];
  /** Their total length in milliseconds. */
  totalSpeechMs: number;
}

/**
 * Picks the audio to fingerprint: drops segments under `minSegmentMs`, trims
 * `trimMs` from each edge, then takes the longest first until `maxTotalMs` is
 * reached (the last window is cut to fit).
 *
 * @param segments - one speaker's speech segments.
 * @param opts - overrides of {@link VOICEPRINT_WINDOW_DEFAULTS}.
 * @returns the windows sorted by start, and their total length.
 *
 * @stability experimental
 */
export function selectVoiceprintWindows(segments: readonly VoiceprintSegment[], opts: VoiceprintWindowOptions = {}): VoiceprintWindows {
  const { minSegmentMs, trimMs, maxTotalMs } = { ...VOICEPRINT_WINDOW_DEFAULTS, ...opts };
  const trimmed = segments
    .filter((s) => s.endMs - s.startMs >= minSegmentMs)
    .map((s) => ({ startMs: s.startMs + trimMs, endMs: s.endMs - trimMs }))
    .filter((s) => s.endMs > s.startMs)
    .sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs) || a.startMs - b.startMs);
  const chosen: VoiceprintSegment[] = [];
  let total = 0;
  for (const s of trimmed) {
    const room = maxTotalMs - total;
    if (room <= 0) break;
    const len = s.endMs - s.startMs;
    chosen.push(len <= room ? s : { startMs: s.startMs, endMs: s.startMs + room });
    total += Math.min(len, room);
  }
  chosen.sort((a, b) => a.startMs - b.startMs);
  return { windows: chosen, totalSpeechMs: total };
}

/**
 * The cosine similarity of two vectors (0 when either has no length).
 *
 * @param a - a vector.
 * @param b - a vector of the same length.
 * @returns a value in [-1, 1].
 * @throws Error when the lengths differ.
 *
 * @stability experimental
 */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new Error('Vectors must have the same length.');
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * Scales a vector to unit length (a zero vector stays zero). Returns a new array.
 *
 * @param v - the vector.
 * @returns the unit vector.
 *
 * @stability experimental
 */
export function l2Normalize(v: ArrayLike<number>): Float32Array {
  const out = new Float32Array(v.length);
  let sum = 0;
  for (let i = 0; i < v.length; i += 1) sum += (v[i] as number) ** 2;
  const norm = Math.sqrt(sum);
  for (let i = 0; i < v.length; i += 1) out[i] = norm > 0 ? (v[i] as number) / norm : 0;
  return out;
}

/**
 * The L2-normalised mean of vectors: a person's voiceprint from their samples.
 *
 * @param vectors - at least one vector, all of one length.
 * @returns the unit-length centroid.
 * @throws Error when there is no vector or the lengths differ.
 *
 * @stability experimental
 */
export function centroid(vectors: readonly ArrayLike<number>[]): Float32Array {
  const first = vectors[0];
  if (!first) throw new Error('centroid needs at least one vector.');
  const sum = new Float64Array(first.length);
  for (const v of vectors) {
    if (v.length !== first.length) throw new Error('Vectors must have the same length.');
    for (let i = 0; i < v.length; i += 1) sum[i] = (sum[i] as number) + (v[i] as number);
  }
  return l2Normalize(sum);
}

/**
 * The most voiceprint samples kept per person.
 *
 * @stability experimental
 */
export const VOICEPRINT_MAX_SAMPLES_PER_PERSON = 10;

/**
 * The defaults of {@link decideVoiceSuggestion}.
 *
 * @remarks
 * Calibrated on real read speech (LibriSpeech dev-clean and test-clean,
 * cross-session, open set; issue #822): top-1 about 96 to 97 percent, at most 5
 * percent wrong suggestions and at most 3 percent unknown-voice false accepts.
 * Conversational or noisy audio is not covered by that calibration.
 *
 * @stability experimental
 */
export const VOICEPRINT_SUGGESTION_DEFAULTS: Readonly<Required<VoiceSuggestionOptions>> = Object.freeze({
  threshold: 0.52,
  margin: 0.05,
});

/**
 * One known person and how well a voice matches them.
 *
 * @stability experimental
 */
export interface VoiceCandidate {
  /** The person (entity) id. */
  entityId: string;
  /** The cosine similarity of the voice to the person's voiceprint. */
  score: number;
}

/**
 * A suggested speaker.
 *
 * @stability experimental
 */
export interface VoiceSuggestion {
  /** The suggested person. */
  entityId: string;
  /** Their score. */
  score: number;
  /** The best score minus the runner-up's (the best score when there is no runner-up). */
  margin: number;
}

/**
 * What {@link decideVoiceSuggestion} takes.
 *
 * @stability experimental
 */
export interface VoiceSuggestionOptions {
  /** The lowest best score that may be suggested. Default 0.52. */
  threshold?: number;
  /** The lead over the runner-up required. Default 0.05. */
  margin?: number;
}

/**
 * Decides whether to suggest a person for a voice: the best candidate is
 * suggested only when its score reaches `threshold` and it leads the runner-up
 * by at least `margin` (a lone candidate needs only the threshold).
 *
 * @param candidates - the scores against each known person.
 * @param opts - overrides of {@link VOICEPRINT_SUGGESTION_DEFAULTS}.
 * @returns the suggestion, or null.
 *
 * @stability experimental
 */
export function decideVoiceSuggestion(candidates: readonly VoiceCandidate[], opts: VoiceSuggestionOptions = {}): VoiceSuggestion | null {
  const { threshold, margin } = { ...VOICEPRINT_SUGGESTION_DEFAULTS, ...opts };
  const sorted = candidates.filter((c) => Number.isFinite(c.score)).sort((a, b) => b.score - a.score);
  const best = sorted[0];
  if (!best || best.score < threshold) return null;
  const second = sorted[1];
  const lead = second ? best.score - second.score : best.score;
  if (second && lead < margin - 1e-9) return null; // tolerance: 0.6 - 0.5 must count as a 0.1 lead
  return { entityId: best.entityId, score: best.score, margin: lead };
}
