// =============================================================================
// The diff that decides what is actually written (issue #27, epic #19)
// =============================================================================
//
// The assertion that matters most here is the one about a segment whose
// `words` array was never loaded: `TranscriptMaterializeService.loadLiveState`
// leaves it `[]` for every segment the batch does not touch, and if the diff
// reported that as a change the first speaker rename on a ten-hour transcript
// would silently blank ninety thousand word timings.
// =============================================================================

import { segment, speaker, state } from './__fixtures__/state';
import { applyOps } from './reducers';
import { diffState } from './state-diff';
import { OP_TYPES } from './ops';

const A = speaker('A', 'Speaker A');
const B = speaker('B', 'Speaker B', { colorIndex: 1 });

function twoLines() {
  return state(
    [A, B],
    [segment('s1', 'A', 'one two three'), segment('s2', 'B', 'four five six', { startMs: 1000 })],
  );
}

describe('diffState', () => {
  it('reports nothing for an untouched state', () => {
    const before = twoLines();

    expect(diffState(before, before)).toMatchObject({ empty: true });
  });

  it('lists only the fields a single correction moved', () => {
    const before = twoLines();
    const after = applyOps(before, [
      { op: OP_TYPES.UPDATE_TEXT, segmentId: 's1', rev: 1, text: 'one two THREE' },
    ]).state;

    const diff = diffState(before, after);

    expect(diff.segmentsUpdated).toHaveLength(1);
    expect(diff.segmentsUpdated[0].id).toBe('s1');
    // `words` is in the list because the re-alignment rewrote the changed
    // token's own text, not because the whole array was replaced wholesale.
    expect(Object.keys(diff.segmentsUpdated[0].patch).sort()).toEqual([
      'origin',
      'rev',
      'text',
      'words',
    ]);
    expect(diff.segmentsCreated).toEqual([]);
    expect(diff.segmentsDeleted).toEqual([]);
  });

  it('never writes `words` for a segment whose array was not loaded', () => {
    // The narrow-load shape: `words: []` on every segment the batch does not
    // touch. A merge re-points both of them and must still write two columns.
    const before = {
      speakers: [A, B],
      segments: twoLines().segments.map((row) => ({ ...row, words: [] })),
    };

    const after = applyOps(before, [
      { op: OP_TYPES.MERGE_SPEAKERS, sourceIds: ['B'], targetId: 'A' },
    ]).state;

    const diff = diffState(before, after);

    expect(diff.segmentsUpdated).toHaveLength(1);
    expect(Object.keys(diff.segmentsUpdated[0].patch).sort()).toEqual(['rev', 'speakerId']);
    expect(diff.speakersDeleted).toEqual(['B']);
  });

  it('reports a split as one update and one create', () => {
    const before = twoLines();
    const after = applyOps(before, [
      {
        op: OP_TYPES.SPLIT,
        segmentId: 's1',
        rev: 1,
        atWordIndex: 1,
        newSegmentId: 's1b',
        newSpeakerId: null,
      },
    ]).state;

    const diff = diffState(before, after);

    expect(diff.segmentsCreated.map((row) => row.id)).toEqual(['s1b']);
    expect(diff.segmentsUpdated.map((row) => row.id)).toEqual(['s1']);
    expect(diff.segmentsDeleted).toEqual([]);
  });

  it('reports a join as one update and one delete', () => {
    const before = twoLines();
    const after = applyOps(before, [
      { op: OP_TYPES.JOIN, segmentIds: ['s1', 's2'], revs: [1, 1] },
    ]).state;

    const diff = diffState(before, after);

    expect(diff.segmentsDeleted).toEqual(['s2']);
    expect(diff.segmentsUpdated.map((row) => row.id)).toEqual(['s1']);
  });

  it('notices a word array whose content changed even in a fresh array', () => {
    const before = twoLines();
    const after = {
      ...before,
      segments: before.segments.map((row, index) =>
        index === 0 ? { ...row, words: row.words.map((word) => ({ ...word, s: word.s + 1 })) } : row,
      ),
    };

    expect(diffState(before, after).segmentsUpdated[0].patch.words).toBeDefined();
  });

  it('reports a created speaker', () => {
    const before = twoLines();
    const after = applyOps(before, [
      { op: OP_TYPES.CREATE_SPEAKER, speakerId: 'C', displayName: 'Sam', colorIndex: 2 },
    ]).state;

    expect(diffState(before, after).speakersCreated.map((row) => row.id)).toEqual(['C']);
  });
});
