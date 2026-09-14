// =============================================================================
// What actually has to be written (issue #27, epic #19)
// =============================================================================
//
// The reducers hand back a whole next state. The database does not want a whole
// next state — a six-thousand-segment transcript where somebody fixed one
// misheard name must produce ONE `UPDATE`, not six thousand.
//
// So the persist path diffs the reducer's output against the state as it was
// loaded and writes only what moved. That is not merely an optimisation:
//
//   • `editing-state.ts`'s header explains that `words[]` is loaded only for
//     the segments whose ops need it and left `[]` everywhere else. A diff is
//     what makes that safe — a segment whose words were `[]` before and `[]`
//     after produces no `words` write at all, so an untouched segment can never
//     have its real word array overwritten with an empty one.
//   • A `speaker.merge` re-points thousands of segments but changes exactly two
//     columns on each (`speaker_id`, `rev`). Writing a field list rather than a
//     row keeps a merge from rewriting every word array it passes over.
// =============================================================================

import type { EditableSegment, EditableSpeaker, EditingState, TimedWord } from './editing-state';

/** The columns of a segment a correction can change. */
export type SegmentPatch = Partial<
  Pick<
    EditableSegment,
    | 'speakerId'
    | 'startMs'
    | 'endMs'
    | 'ordinal'
    | 'text'
    | 'words'
    | 'wordsAlignment'
    | 'confidence'
    | 'origin'
    | 'rev'
  >
>;

/** The columns of a speaker a correction can change. */
export type SpeakerPatch = Partial<Pick<EditableSpeaker, 'displayName' | 'colorIndex' | 'rev'>>;

export interface StateDiff {
  speakersCreated: EditableSpeaker[];
  speakersUpdated: Array<{ id: string; patch: SpeakerPatch }>;
  speakersDeleted: string[];
  segmentsCreated: EditableSegment[];
  segmentsUpdated: Array<{ id: string; patch: SegmentPatch }>;
  segmentsDeleted: string[];
  /** True when nothing at all changed — the caller can skip the whole write. */
  empty: boolean;
}

/** Word arrays are equal when they are the same array, or the same content. */
function sameWords(a: TimedWord[], b: TimedWord[]): boolean {
  // Identity first: every reducer that changes words assigns a NEW array, so
  // the overwhelming majority of segments answer here in constant time.
  if (a === b) return true;
  if (a.length !== b.length) return false;

  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];

    if (left.t !== right.t || left.s !== right.s || left.e !== right.e || left.c !== right.c) {
      return false;
    }
  }

  return true;
}

export function diffState(before: EditingState, after: EditingState): StateDiff {
  const beforeSpeakers = new Map(before.speakers.map((speaker) => [speaker.id, speaker]));
  const beforeSegments = new Map(before.segments.map((segment) => [segment.id, segment]));

  const diff: StateDiff = {
    speakersCreated: [],
    speakersUpdated: [],
    speakersDeleted: [],
    segmentsCreated: [],
    segmentsUpdated: [],
    segmentsDeleted: [],
    empty: true,
  };

  const survivingSpeakers = new Set<string>();

  for (const speaker of after.speakers) {
    survivingSpeakers.add(speaker.id);

    const original = beforeSpeakers.get(speaker.id);

    if (!original) {
      diff.speakersCreated.push(speaker);
      continue;
    }

    const patch: SpeakerPatch = {};

    if (original.displayName !== speaker.displayName) patch.displayName = speaker.displayName;
    if (original.colorIndex !== speaker.colorIndex) patch.colorIndex = speaker.colorIndex;
    if (original.rev !== speaker.rev) patch.rev = speaker.rev;

    if (Object.keys(patch).length > 0) diff.speakersUpdated.push({ id: speaker.id, patch });
  }

  for (const speaker of before.speakers) {
    if (!survivingSpeakers.has(speaker.id)) diff.speakersDeleted.push(speaker.id);
  }

  const survivingSegments = new Set<string>();

  for (const segment of after.segments) {
    survivingSegments.add(segment.id);

    const original = beforeSegments.get(segment.id);

    if (!original) {
      diff.segmentsCreated.push(segment);
      continue;
    }

    const patch: SegmentPatch = {};

    if (original.speakerId !== segment.speakerId) patch.speakerId = segment.speakerId;
    if (original.startMs !== segment.startMs) patch.startMs = segment.startMs;
    if (original.endMs !== segment.endMs) patch.endMs = segment.endMs;
    if (original.ordinal !== segment.ordinal) patch.ordinal = segment.ordinal;
    if (original.text !== segment.text) patch.text = segment.text;
    if (original.wordsAlignment !== segment.wordsAlignment) {
      patch.wordsAlignment = segment.wordsAlignment;
    }
    if (original.confidence !== segment.confidence) patch.confidence = segment.confidence;
    if (original.origin !== segment.origin) patch.origin = segment.origin;
    if (original.rev !== segment.rev) patch.rev = segment.rev;
    if (!sameWords(original.words, segment.words)) patch.words = segment.words;

    if (Object.keys(patch).length > 0) diff.segmentsUpdated.push({ id: segment.id, patch });
  }

  for (const segment of before.segments) {
    if (!survivingSegments.has(segment.id)) diff.segmentsDeleted.push(segment.id);
  }

  diff.empty =
    diff.speakersCreated.length === 0 &&
    diff.speakersUpdated.length === 0 &&
    diff.speakersDeleted.length === 0 &&
    diff.segmentsCreated.length === 0 &&
    diff.segmentsUpdated.length === 0 &&
    diff.segmentsDeleted.length === 0;

  return diff;
}
