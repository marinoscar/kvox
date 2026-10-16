// =============================================================================
// The shape the correction reducers operate on (issue #27, epic #19, spec §4.1)
// =============================================================================
//
// EVERYTHING IN THIS DIRECTORY IS PURE. No `PrismaService`, no `@Injectable`,
// no `import type { Prisma }` — the reducers take a `{ speakers, segments }`
// value and return the next one, and that is the whole contract.
//
// It is not a stylistic preference. Spec §4.4's invariant is that
// `materialize(currentVersion)` — replaying a version log from the nearest
// snapshot — equals the live database tables, and the only way to get that
// invariant *by construction* rather than by hoping two implementations stay
// in step is for the live edit path and the replay path to call THE SAME
// FUNCTION. A reducer that could read a row would be a reducer the replay path
// could not call against a snapshot it holds in memory.
//
// -----------------------------------------------------------------------------
// `words` MAY BE ABSENT, AND THE LOADER DECIDES WHICH SEGMENTS GET THEM
// -----------------------------------------------------------------------------
//
// A ten-hour transcript's word arrays are the single largest thing in this
// schema (spec §3.3). A correction batch that renames a speaker has no business
// pulling ninety thousand word timings through the database driver to do it, so
// `TranscriptEditingService` loads `words` only for the segments whose ops
// actually touch them (`segment.update_text`, `segment.split`, `segment.join`)
// and leaves every other segment's array EMPTY.
//
// That is safe precisely because the persist path is a DIFF against the state
// as it was loaded: a segment whose words were `[]` before and `[]` after
// produces no `words` write at all. It is also why the reducers below must
// never read `words` for an op that is not one of those three — a rule that is
// stated once here and enforced by `requiredWordSegmentIds()` in `ops.ts`
// computing exactly that set from the batch.
//
// `materialize()` loads every word for every segment, because a snapshot that
// dropped them would not be a snapshot of anything.
// =============================================================================

/** How much to trust a segment's word timings after an edit (spec §3.5). */
export type WordsAlignmentValue = 'exact' | 'interpolated' | 'none';

/** Whether a segment's text came from the provider or from a person. */
export type SegmentOriginValue = 'ai' | 'user';

/**
 * One word timing.
 *
 * Terse keys — text, start, end, confidence — matching the JSONB column
 * verbatim (spec §3.3), because a long transcript has millions of these and
 * the key names are a material fraction of the bytes.
 */
export interface TimedWord {
  t: string;
  s: number;
  e: number;
  c: number | null;
}

/** One speaker, as the reducers see it. */
export interface EditableSpeaker {
  id: string;
  /** The provider's own diarization label, or null for a user-created one. */
  label: string | null;
  displayName: string;
  colorIndex: number;
  /** Per-entity optimistic-concurrency counter (spec §5). */
  rev: number;
}

/** One segment, as the reducers see it. */
export interface EditableSegment {
  id: string;
  speakerId: string;
  startMs: number;
  endMs: number;
  /** Gap-based float, so an insert needs no renumbering (spec §3.4). */
  ordinal: number;
  text: string;
  /** May be `[]` for a segment this batch does not touch — see the header. */
  words: TimedWord[];
  wordsAlignment: WordsAlignmentValue;
  confidence: number | null;
  origin: SegmentOriginValue;
  rev: number;
}

/** The whole editable document. */
export interface EditingState {
  speakers: EditableSpeaker[];
  segments: EditableSegment[];
}

/**
 * A shallow-per-entity copy, so a reducer may replace fields freely without
 * the caller's "before" snapshot moving underneath the diff.
 *
 * `words` is copied by REFERENCE, not cloned. Every reducer that changes a
 * segment's words assigns a brand-new array rather than mutating the existing
 * one, so sharing the reference is what makes "did the words change?" a cheap
 * identity comparison in `diffState` for the overwhelming majority of segments
 * that were never touched.
 */
export function cloneState(state: EditingState): EditingState {
  return {
    speakers: state.speakers.map((speaker) => ({ ...speaker })),
    segments: state.segments.map((segment) => ({ ...segment })),
  };
}

/**
 * Reading order for a segment list, matching `GET /api/transcripts/:id/segments`
 * exactly: `startMs` first, `ordinal` as the tiebreak.
 *
 * ⚠ NOT the order the reducers work in. Adjacency — what `segment.join`
 * requires and what `segment.split` computes a midpoint against — is defined
 * by `ordinal` alone (spec §3.4), and after enough editing the two orders can
 * legitimately disagree: a user who retimes nothing but re-splits a line
 * produces segments whose `startMs` ties. Sorting by `ordinal` is therefore
 * what `sortByOrdinal` below is for, and this function exists purely so that a
 * correction response and a plain segment fetch never disagree about the order
 * to paint rows in.
 */
export function sortForRead<T extends { startMs: number; ordinal: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.startMs - b.startMs || a.ordinal - b.ordinal);
}

/** The reducers' own canonical order. See `sortForRead` for why they differ. */
export function sortByOrdinal<T extends { ordinal: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.ordinal - b.ordinal);
}
