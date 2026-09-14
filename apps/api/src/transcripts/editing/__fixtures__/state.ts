// =============================================================================
// A tiny state builder for the correction-core tests (issue #27, epic #19)
// =============================================================================
//
// Every reducer test needs a `{ speakers, segments }` and none of them needs a
// realistic one, so this keeps the noise out of the assertions: readable ids
// (`s1`, `A`) rather than uuids, ordinals on the real `ORDINAL_GAP` grid, and
// word timings derived from the text unless a test cares about them.
//
// ⚠ The ids here are NOT uuids on purpose. The reducers never parse an id — the
// Zod schemas at the HTTP boundary do — so a test that used uuids everywhere
// would be harder to read for no extra coverage. The integration and
// real-Postgres suites use real uuids, which is where the format actually
// matters.
// =============================================================================

import type {
  EditableSegment,
  EditableSpeaker,
  EditingState,
  TimedWord,
} from '../editing-state';
import { ORDINAL_GAP } from '../ordinals';

export function speaker(
  id: string,
  displayName = id,
  overrides: Partial<EditableSpeaker> = {},
): EditableSpeaker {
  return { id, label: id, displayName, colorIndex: 0, rev: 1, ...overrides };
}

/** Words for `text`, 100 ms each starting at `startMs`. */
export function wordsFor(text: string, startMs = 0, step = 100): TimedWord[] {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token, index) => ({
      t: token,
      s: startMs + index * step,
      e: startMs + (index + 1) * step,
      c: 0.9,
    }));
}

export function segment(
  id: string,
  speakerId: string,
  text: string,
  overrides: Partial<EditableSegment> = {},
): EditableSegment {
  const words = overrides.words ?? wordsFor(text, overrides.startMs ?? 0);

  return {
    id,
    speakerId,
    startMs: overrides.startMs ?? (words[0]?.s ?? 0),
    endMs: overrides.endMs ?? (words[words.length - 1]?.e ?? 0),
    ordinal: ORDINAL_GAP,
    text,
    words,
    wordsAlignment: 'exact',
    confidence: 0.9,
    origin: 'ai',
    rev: 1,
    ...overrides,
  };
}

/** A state whose segments are numbered 1000, 2000, 3000, … in the order given. */
export function state(speakers: EditableSpeaker[], segments: EditableSegment[]): EditingState {
  return {
    speakers,
    segments: segments.map((row, index) => ({ ...row, ordinal: (index + 1) * ORDINAL_GAP })),
  };
}
