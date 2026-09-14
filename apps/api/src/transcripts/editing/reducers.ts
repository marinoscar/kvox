// =============================================================================
// The op reducers (issue #27, epic #19, spec §4.1)
// =============================================================================
//
// Pure functions over `{ speakers, segments }`. No database, no clock, no
// `randomUUID()` — see `editing-state.ts`'s header for why that is the whole
// point, and `ops.ts`'s for why every server-chosen value is already in the op
// by the time it gets here.
//
// -----------------------------------------------------------------------------
// TWO MODES, AND THE DIFFERENCE IS WHO IS TO BLAME
// -----------------------------------------------------------------------------
//
//   • `live` — a client's batch. A stale `rev` or a segment somebody else has
//     already deleted is a CONCURRENCY OUTCOME: it is collected into
//     `conflicts` and the op is skipped, so that one response can name every
//     conflicting entity at once (spec §5) and the client resolves them all in
//     one re-fetch rather than discovering them one at a time.
//
//   • `replay` — `materialize()` walking a version log. The same situation is
//     a CORRUPT HISTORY, because these ops already applied cleanly once: it
//     throws. A replay that quietly skipped an op would produce a version that
//     silently disagrees with what was actually saved — exactly what spec
//     §4.4's invariant exists to rule out.
//
// -----------------------------------------------------------------------------
// A BATCH IS ONE CLIENT'S UNIT OF WORK, SO IT DOES NOT CONFLICT WITH ITSELF
// -----------------------------------------------------------------------------
//
// A client that corrects a segment twice in one burst sends two
// `segment.update_text` ops, both carrying the `rev` it last SAW — which is the
// same number for both, because the client never observed the intermediate
// state. Checking the second op against the rev the first one produced would
// 409 a batch nobody else touched. So a rev check passes when the op names a
// rev the current row actually has **or** when an earlier op in this same batch
// already modified that entity. Concurrency is between CLIENTS; a batch is one.
// =============================================================================

import {
  cloneState,
  sortByOrdinal,
  type EditableSegment,
  type EditableSpeaker,
  type EditingState,
} from './editing-state';
import { planInsertion } from './ordinals';
import { OP_TYPES, type ReducibleOp, type RecordedOp } from './ops';
import {
  joinWords,
  realignWords,
  splitWords,
  tokenize,
  worstAlignment,
} from './word-alignment';

/** One entity a batch could not be applied to. The body of the 409 (spec §5). */
export interface OpConflict {
  entity: 'segment' | 'speaker';
  id: string;
  /**
   * The entity's `rev` as it actually stands, or `null` when the entity is
   * gone entirely.
   *
   * ⚠ `null` IS A REAL ANSWER, not a missing one. A concurrent editor deleting
   * the segment this op names is a genuine concurrency outcome and belongs in
   * the same 409 as a stale `rev`, not in a 400 that blames the caller for a
   * body that was correct when they wrote it.
   */
  current: number | null;
}

/**
 * Something structurally wrong with an op: a split past the end of a segment,
 * a join of two segments that are not adjacent, a merge naming its own target
 * as a source. These are 400s — no amount of re-fetching makes them apply.
 */
export class OpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpError';
  }
}

/** What a `speaker.merge` moved, so the UI can offer an undo (issue #27). */
export interface MergeUndoRecord {
  targetId: string;
  sources: Array<{
    speakerId: string;
    label: string | null;
    displayName: string;
    colorIndex: number;
    /** Every segment that was on this speaker, and is now on the target. */
    segmentIds: string[];
  }>;
}

export interface ApplyOptions {
  mode?: 'live' | 'replay';
}

export interface ApplyResult {
  state: EditingState;
  /** Non-empty means the whole batch must be rejected with a 409. */
  conflicts: OpConflict[];
  merges: MergeUndoRecord[];
}

/**
 * Apply a batch of recorded ops.
 *
 * ⚠ `restore` IS NOT REDUCIBLE and throws here. Replaying it means
 * materializing another version, which is a database read; `materialize()`
 * intercepts it before a reducer ever sees it (see `ops.ts`'s header).
 */
export function applyOps(
  initial: EditingState,
  ops: readonly RecordedOp[],
  options: ApplyOptions = {},
): ApplyResult {
  const mode = options.mode ?? 'live';
  const state = cloneState(initial);

  state.segments = sortByOrdinal(state.segments);

  const conflicts: OpConflict[] = [];
  const merges: MergeUndoRecord[] = [];
  const touched = new Set<string>();

  for (const op of ops) {
    if (op.op === OP_TYPES.RESTORE) {
      throw new OpError(
        'A `restore` op is materialized, never reduced — see materialize() in ' +
          'transcript-materialize.service.ts',
      );
    }

    const before = conflicts.length;

    applyOne(state, op, { mode, conflicts, merges, touched });

    if (conflicts.length !== before && mode === 'replay') {
      const conflict = conflicts[conflicts.length - 1];

      throw new OpError(
        `Replaying ${op.op} found ${conflict.entity} ${conflict.id} at rev ` +
          `${conflict.current ?? 'gone'} — the version log disagrees with the state it ` +
          'is being replayed onto',
      );
    }
  }

  return { state, conflicts, merges };
}

interface ApplyContext {
  mode: 'live' | 'replay';
  conflicts: OpConflict[];
  merges: MergeUndoRecord[];
  touched: Set<string>;
}

function applyOne(state: EditingState, op: ReducibleOp, context: ApplyContext): void {
  switch (op.op) {
    case OP_TYPES.UPDATE_TEXT:
      return updateText(state, op, context);
    case OP_TYPES.SET_SPEAKER:
      return setSpeaker(state, op, context);
    case OP_TYPES.SPLIT:
      return splitSegment(state, op, context);
    case OP_TYPES.JOIN:
      return joinSegments(state, op, context);
    case OP_TYPES.DELETE:
      return deleteSegment(state, op, context);
    case OP_TYPES.RENAME_SPEAKER:
      return renameSpeaker(state, op, context);
    case OP_TYPES.CREATE_SPEAKER:
      return createSpeaker(state, op);
    case OP_TYPES.MERGE_SPEAKERS:
      return mergeSpeakers(state, op, context);
    /* istanbul ignore next — the union is exhaustive; this is the compiler's proof */
    default: {
      const unreachable: never = op;

      throw new OpError(`Unknown op ${JSON.stringify(unreachable)}`);
    }
  }
}

// -----------------------------------------------------------------------------
// rev checking
// -----------------------------------------------------------------------------

/**
 * Find a segment and confirm the op is allowed to change it.
 *
 * Returns `null` when it is not, having already recorded the conflict — every
 * caller treats that as "skip this op" so the rest of the batch keeps
 * collecting conflicts for one complete 409.
 */
function takeSegment(
  state: EditingState,
  id: string,
  rev: number,
  context: ApplyContext,
): EditableSegment | null {
  const segment = state.segments.find((candidate) => candidate.id === id);

  if (!segment) {
    context.conflicts.push({ entity: 'segment', id, current: null });

    return null;
  }

  const key = `segment:${id}`;

  if (segment.rev !== rev && !context.touched.has(key)) {
    context.conflicts.push({ entity: 'segment', id, current: segment.rev });

    return null;
  }

  context.touched.add(key);

  return segment;
}

function takeSpeaker(
  state: EditingState,
  id: string,
  rev: number,
  context: ApplyContext,
): EditableSpeaker | null {
  const speaker = state.speakers.find((candidate) => candidate.id === id);

  if (!speaker) {
    context.conflicts.push({ entity: 'speaker', id, current: null });

    return null;
  }

  const key = `speaker:${id}`;

  if (speaker.rev !== rev && !context.touched.has(key)) {
    context.conflicts.push({ entity: 'speaker', id, current: speaker.rev });

    return null;
  }

  context.touched.add(key);

  return speaker;
}

// -----------------------------------------------------------------------------
// Segment ops
// -----------------------------------------------------------------------------

function updateText(
  state: EditingState,
  op: Extract<ReducibleOp, { op: 'segment.update_text' }>,
  context: ApplyContext,
): void {
  const segment = takeSegment(state, op.segmentId, op.rev, context);

  if (!segment) return;

  const text = op.text.trim();

  if (text.length === 0) {
    throw new OpError(
      `segment.update_text on ${op.segmentId} would leave the segment empty — ` +
        'delete it with segment.delete instead',
    );
  }

  const aligned = realignWords({
    oldWords: segment.words,
    newText: text,
    startMs: segment.startMs,
    endMs: segment.endMs,
    previousAlignment: segment.wordsAlignment,
  });

  segment.text = text;
  segment.words = aligned.words;
  segment.wordsAlignment = aligned.alignment;
  segment.origin = 'user';
  segment.rev += 1;
}

function setSpeaker(
  state: EditingState,
  op: Extract<ReducibleOp, { op: 'segment.set_speaker' }>,
  context: ApplyContext,
): void {
  const speaker = state.speakers.find((candidate) => candidate.id === op.speakerId);

  if (!speaker) {
    throw new OpError(`segment.set_speaker names speaker ${op.speakerId}, which does not exist`);
  }

  const segment = takeSegment(state, op.segmentId, op.rev, context);

  if (!segment) return;

  segment.speakerId = op.speakerId;
  segment.rev += 1;
}

function splitSegment(
  state: EditingState,
  op: Extract<ReducibleOp, { op: 'segment.split' }>,
  context: ApplyContext,
): void {
  if (op.newSpeakerId && !state.speakers.some((candidate) => candidate.id === op.newSpeakerId)) {
    throw new OpError(`segment.split names speaker ${op.newSpeakerId}, which does not exist`);
  }

  const index = state.segments.findIndex((candidate) => candidate.id === op.segmentId);
  const segment = takeSegment(state, op.segmentId, op.rev, context);

  if (!segment) return;

  const tokens = tokenize(segment.text);

  // 0 and `tokens.length` are both refused: either one produces an EMPTY half,
  // which is a segment with no text — a row nothing can render and the next
  // `segment.update_text` would have to reject anyway.
  if (op.atWordIndex <= 0 || op.atWordIndex >= tokens.length) {
    throw new OpError(
      `segment.split at word ${op.atWordIndex} of ${op.segmentId} would produce an empty ` +
        `half — the segment has ${tokens.length} word(s)`,
    );
  }

  const [firstWords, secondWords] = splitWords(segment.words, op.atWordIndex, tokens.length);

  const boundaryMs =
    secondWords.length > 0
      ? secondWords[0].s
      : // No word timings to split on: divide the span in proportion to how
        // much of the text went to each half, which is the only signal left.
        Math.round(
          segment.startMs +
            (segment.endMs - segment.startMs) * (op.atWordIndex / Math.max(1, tokens.length)),
        );

  const firstEndMs = firstWords.length > 0 ? firstWords[firstWords.length - 1].e : boundaryMs;

  const plan = planInsertion(state.segments, index);

  for (const moved of plan.renumbered) {
    const target = state.segments.find((candidate) => candidate.id === moved.id);

    // ⚠ NO `rev` BUMP. See `ordinals.ts`'s header: a neighbour whose number
    // moved so that somebody else's split had room did not have its content
    // edited, and bumping its counter would 409 an unrelated editor.
    if (target) target.ordinal = moved.ordinal;
  }

  const later: EditableSegment = {
    id: op.newSegmentId,
    speakerId: op.newSpeakerId ?? segment.speakerId,
    startMs: Math.min(boundaryMs, segment.endMs),
    endMs: segment.endMs,
    ordinal: plan.ordinal,
    text: tokens.slice(op.atWordIndex).join(' '),
    words: secondWords,
    // Nothing was invented — the array was divided (spec §3.5) — so both halves
    // keep whatever the original's alignment already was.
    wordsAlignment: segment.wordsAlignment,
    confidence: segment.confidence,
    origin: 'user',
    rev: 1,
  };

  // ⚠ THE EARLIER HALF KEEPS THE ORIGINAL ID AND ORDINAL (spec §4.1's test
  // vector). A bookmark, an export reference, or a concurrent editor's stale
  // `rev` for this segment must still name something real afterwards.
  segment.text = tokens.slice(0, op.atWordIndex).join(' ');
  segment.words = firstWords;
  segment.endMs = Math.max(segment.startMs, Math.min(firstEndMs, segment.endMs));
  segment.origin = 'user';
  segment.rev += 1;

  state.segments = sortByOrdinal([...state.segments, later]);
  context.touched.add(`segment:${later.id}`);
}

function joinSegments(
  state: EditingState,
  op: Extract<ReducibleOp, { op: 'segment.join' }>,
  context: ApplyContext,
): void {
  const [firstId, secondId] = op.segmentIds;

  if (firstId === secondId) {
    throw new OpError('segment.join names the same segment twice');
  }

  const firstIndex = state.segments.findIndex((candidate) => candidate.id === firstId);
  const secondIndex = state.segments.findIndex((candidate) => candidate.id === secondId);

  // ADJACENT ONLY (spec §4.1). Joining across a gap would silently swallow
  // every segment in between, or produce a segment whose words are out of
  // order — neither is something a user asked for by clicking "join".
  if (firstIndex !== -1 && secondIndex !== -1 && secondIndex !== firstIndex + 1) {
    throw new OpError(
      `segment.join requires adjacent segments; ${firstId} and ${secondId} are not`,
    );
  }

  const first = takeSegment(state, firstId, op.revs[0], context);
  const second = takeSegment(state, secondId, op.revs[1], context);

  if (!first || !second) return;

  // ⚠ THE RESULT KEEPS THE FIRST SEGMENT'S SPEAKER, deliberately (spec §4.1).
  // The payload carries no speaker override, joining across a speaker change is
  // allowed, and a user who wanted the second speaker follows up with
  // `segment.set_speaker` — which is one more op, not a guess.
  first.text = `${first.text.trim()} ${second.text.trim()}`.trim();
  first.words = joinWords(first.words, second.words);
  first.startMs = Math.min(first.startMs, second.startMs);
  first.endMs = Math.max(first.endMs, second.endMs);
  first.wordsAlignment = worstAlignment(first.wordsAlignment, second.wordsAlignment);
  first.confidence = null;
  first.origin = 'user';
  first.rev += 1;

  state.segments = state.segments.filter((candidate) => candidate.id !== secondId);
}

function deleteSegment(
  state: EditingState,
  op: Extract<ReducibleOp, { op: 'segment.delete' }>,
  context: ApplyContext,
): void {
  const segment = takeSegment(state, op.segmentId, op.rev, context);

  if (!segment) return;

  state.segments = state.segments.filter((candidate) => candidate.id !== op.segmentId);
}

// -----------------------------------------------------------------------------
// Speaker ops
// -----------------------------------------------------------------------------

function renameSpeaker(
  state: EditingState,
  op: Extract<ReducibleOp, { op: 'speaker.rename' }>,
  context: ApplyContext,
): void {
  const speaker = takeSpeaker(state, op.speakerId, op.rev, context);

  if (!speaker) return;

  speaker.displayName = op.displayName.trim();
  speaker.rev += 1;
}

function createSpeaker(
  state: EditingState,
  op: Extract<ReducibleOp, { op: 'speaker.create' }>,
): void {
  if (state.speakers.some((candidate) => candidate.id === op.speakerId)) {
    throw new OpError(`speaker.create names id ${op.speakerId}, which already exists`);
  }

  state.speakers = [
    ...state.speakers,
    {
      id: op.speakerId,
      // NULL, always. A `label` is the PROVIDER's own diarization key (spec
      // §3.2), and a speaker a person invented has none — which is exactly why
      // the unique index on `(transcript_id, label)` is partial.
      label: null,
      displayName: op.displayName.trim(),
      colorIndex: op.colorIndex,
      rev: 1,
    },
  ];
}

function mergeSpeakers(
  state: EditingState,
  op: Extract<ReducibleOp, { op: 'speaker.merge' }>,
  context: ApplyContext,
): void {
  const target = state.speakers.find((candidate) => candidate.id === op.targetId);

  if (!target) {
    throw new OpError(`speaker.merge names target ${op.targetId}, which does not exist`);
  }

  const sourceIds = [...new Set(op.sourceIds)];

  if (sourceIds.includes(op.targetId)) {
    throw new OpError('speaker.merge cannot name its own target as a source');
  }

  const sources = sourceIds.map((id) => {
    const speaker = state.speakers.find((candidate) => candidate.id === id);

    if (!speaker) {
      throw new OpError(`speaker.merge names source ${id}, which does not exist`);
    }

    return speaker;
  });

  const undo: MergeUndoRecord = { targetId: op.targetId, sources: [] };

  for (const source of sources) {
    const segmentIds: string[] = [];

    for (const segment of state.segments) {
      if (segment.speakerId !== source.id) continue;

      segmentIds.push(segment.id);
      segment.speakerId = op.targetId;
      // ⚠ EVERY RE-POINTED SEGMENT'S `rev` BUMPS, exactly as
      // `segment.set_speaker` would bump it (spec §4.1) — a concurrent editor
      // holding a stale rev for one of these lines correctly gets a 409 rather
      // than silently overwriting a re-attribution they never saw.
      segment.rev += 1;
      context.touched.add(`segment:${segment.id}`);
    }

    undo.sources.push({
      speakerId: source.id,
      label: source.label,
      displayName: source.displayName,
      colorIndex: source.colorIndex,
      segmentIds,
    });
  }

  // `keepName` defaults to TRUE: the surviving speaker keeps its own name
  // (spec §4.1). `false` adopts the first source's name instead.
  if (op.keepName === false) {
    target.displayName = sources[0].displayName;
    target.rev += 1;
    context.touched.add(`speaker:${target.id}`);
  }

  const removed = new Set(sourceIds);

  state.speakers = state.speakers.filter((candidate) => !removed.has(candidate.id));
  context.merges.push(undo);
}

/** Words in a transcript, counted the way the list view reports them. */
export function countStateWords(state: EditingState): number {
  return state.segments.reduce((total, segment) => total + tokenize(segment.text).length, 0);
}
