// =============================================================================
// The op reducers, table-driven (issue #27, epic #19, spec §4.1)
// =============================================================================
//
// Issue #27's first acceptance criterion is "table-driven reducer tests for
// every op, including split/join word partitioning, a 3 → 1 speaker merge, and
// find & replace with case, whole-word and speaker scope". The find & replace
// half lives in `find-matcher.spec.ts` (the matching rules) and
// `../transcript-editing.service.spec.ts` (the server-side expansion, which is
// the part that needs a database to read segment text from); everything else is
// here.
//
// Each case states the spec's own expected outcome, not merely "it did
// something": the `rev` bumps, which id survives a split, whose speaker
// survives a join, and what the resulting `words_alignment` is, because those
// are exactly the four things a careless refactor gets wrong without failing a
// weaker test.
// =============================================================================

import { segment, speaker, state, wordsFor } from './__fixtures__/state';
import { OpError, applyOps, countStateWords } from './reducers';
import { OP_TYPES, type RecordedOp } from './ops';
import { ORDINAL_GAP } from './ordinals';

const A = speaker('A', 'Speaker A');
const B = speaker('B', 'Speaker B', { colorIndex: 1 });
const C = speaker('C', 'Speaker C', { colorIndex: 2 });

function threeLines() {
  return state(
    [A, B, C],
    [
      segment('s1', 'A', 'hello there world', { startMs: 0 }),
      segment('s2', 'B', 'this is the second line', { startMs: 1000 }),
      segment('s3', 'C', 'and a third', { startMs: 2000 }),
    ],
  );
}

describe('applyOps — one op at a time', () => {
  it('segment.update_text replaces the text, re-aligns and bumps rev', () => {
    const before = threeLines();
    const { state: after, conflicts } = applyOps(before, [
      { op: OP_TYPES.UPDATE_TEXT, segmentId: 's1', rev: 1, text: 'hello there World' },
    ]);

    expect(conflicts).toEqual([]);

    const s1 = after.segments.find((row) => row.id === 's1');

    expect(s1?.text).toBe('hello there World');
    expect(s1?.rev).toBe(2);
    expect(s1?.origin).toBe('user');
    // Only the case changed, and `foldToken` treats that as the same word — so
    // every timing is still the provider's own.
    expect(s1?.wordsAlignment).toBe('exact');
    // The original is untouched: the reducers are pure.
    expect(before.segments[0].text).toBe('hello there world');
    expect(before.segments[0].rev).toBe(1);
  });

  it('segment.update_text refuses to empty a segment', () => {
    expect(() =>
      applyOps(threeLines(), [
        { op: OP_TYPES.UPDATE_TEXT, segmentId: 's1', rev: 1, text: '   ' },
      ]),
    ).toThrow(OpError);
  });

  it('segment.set_speaker re-points one line and bumps only its rev', () => {
    const { state: after } = applyOps(threeLines(), [
      { op: OP_TYPES.SET_SPEAKER, segmentId: 's1', rev: 1, speakerId: 'B' },
    ]);

    expect(after.segments.find((row) => row.id === 's1')?.speakerId).toBe('B');
    expect(after.segments.find((row) => row.id === 's1')?.rev).toBe(2);
    expect(after.segments.find((row) => row.id === 's2')?.rev).toBe(1);
    expect(after.speakers.map((row) => row.rev)).toEqual([1, 1, 1]);
  });

  it('segment.set_speaker naming a speaker that does not exist is a 400, not a conflict', () => {
    expect(() =>
      applyOps(threeLines(), [
        { op: OP_TYPES.SET_SPEAKER, segmentId: 's1', rev: 1, speakerId: 'nobody' },
      ]),
    ).toThrow(OpError);
  });

  it('segment.delete removes the row and nothing else', () => {
    const { state: after } = applyOps(threeLines(), [
      { op: OP_TYPES.DELETE, segmentId: 's2', rev: 1 },
    ]);

    expect(after.segments.map((row) => row.id)).toEqual(['s1', 's3']);
    // The speaker survives its last segment being deleted — a speaker is a
    // participant in the conversation, not a property of a line.
    expect(after.speakers.map((row) => row.id)).toEqual(['A', 'B', 'C']);
  });

  it('speaker.rename changes the name and bumps the speaker rev', () => {
    const { state: after } = applyOps(threeLines(), [
      { op: OP_TYPES.RENAME_SPEAKER, speakerId: 'B', rev: 1, displayName: 'Dana' },
    ]);

    expect(after.speakers.find((row) => row.id === 'B')).toMatchObject({
      displayName: 'Dana',
      rev: 2,
    });
  });

  it('speaker.create adds a label-less speaker at the id and colour the server chose', () => {
    const { state: after } = applyOps(threeLines(), [
      { op: OP_TYPES.CREATE_SPEAKER, speakerId: 'D', displayName: 'Sam', colorIndex: 3 },
    ]);

    expect(after.speakers).toHaveLength(4);
    expect(after.speakers[3]).toEqual({
      id: 'D',
      // NULL, always: a `label` is the provider's diarization key and a speaker
      // a person invented has none (spec §3.2).
      label: null,
      displayName: 'Sam',
      colorIndex: 3,
      rev: 1,
    });
  });
});

describe('segment.split — word partitioning and the stable id (spec §4.1)', () => {
  it('keeps the earlier half at the original id and ordinal, and takes the midpoint', () => {
    const before = threeLines();
    const { state: after } = applyOps(before, [
      {
        op: OP_TYPES.SPLIT,
        segmentId: 's1',
        rev: 1,
        atWordIndex: 2,
        newSegmentId: 's1b',
        newSpeakerId: null,
      },
    ]);

    const first = after.segments.find((row) => row.id === 's1');
    const second = after.segments.find((row) => row.id === 's1b');

    expect(first).toMatchObject({
      text: 'hello there',
      ordinal: ORDINAL_GAP,
      rev: 2,
      speakerId: 'A',
    });
    expect(second).toMatchObject({
      text: 'world',
      // The midpoint between 1000 and 2000, touching no other row (spec §3.4).
      ordinal: 1500,
      rev: 1,
      speakerId: 'A',
    });
    expect(after.segments.map((row) => row.id)).toEqual(['s1', 's1b', 's2', 's3']);
  });

  it('divides the word array at the split point, inventing no timing', () => {
    const words = wordsFor('hello there world', 0);
    const before = state([A], [segment('s1', 'A', 'hello there world', { words })]);

    const { state: after } = applyOps(before, [
      {
        op: OP_TYPES.SPLIT,
        segmentId: 's1',
        rev: 1,
        atWordIndex: 2,
        newSegmentId: 's1b',
        newSpeakerId: null,
      },
    ]);

    const first = after.segments.find((row) => row.id === 's1');
    const second = after.segments.find((row) => row.id === 's1b');

    expect(first?.words).toEqual(words.slice(0, 2));
    expect(second?.words).toEqual(words.slice(2));
    // Both halves stay `exact` — dividing an array does not reconstruct a
    // timing (spec §3.5).
    expect(first?.wordsAlignment).toBe('exact');
    expect(second?.wordsAlignment).toBe('exact');
    // And the spans follow the words that went to each side.
    expect(first?.endMs).toBe(200);
    expect(second?.startMs).toBe(200);
  });

  it('can hand the later half to a different speaker', () => {
    const { state: after } = applyOps(threeLines(), [
      {
        op: OP_TYPES.SPLIT,
        segmentId: 's1',
        rev: 1,
        atWordIndex: 1,
        newSegmentId: 's1b',
        newSpeakerId: 'B',
      },
    ]);

    expect(after.segments.find((row) => row.id === 's1b')?.speakerId).toBe('B');
    expect(after.segments.find((row) => row.id === 's1')?.speakerId).toBe('A');
  });

  it.each([0, 3, 9])('refuses a split at word %i, which would leave a half empty', (index) => {
    expect(() =>
      applyOps(threeLines(), [
        {
          op: OP_TYPES.SPLIT,
          segmentId: 's1',
          rev: 1,
          atWordIndex: index,
          newSegmentId: 's1b',
          newSpeakerId: null,
        },
      ]),
    ).toThrow(OpError);
  });

  it('renumbers only the neighbourhood when the gap is exhausted', () => {
    // Two segments a hair apart: the midpoint is below `MIN_ORDINAL_GAP`, so
    // `planInsertion` widens the local window rather than the document.
    const before = {
      speakers: [A],
      segments: [
        { ...segment('s1', 'A', 'one two'), ordinal: 1000 },
        { ...segment('s2', 'A', 'three four'), ordinal: 1000.00001 },
        { ...segment('s3', 'A', 'five six'), ordinal: 5000 },
      ],
    };

    const { state: after } = applyOps(before, [
      {
        op: OP_TYPES.SPLIT,
        segmentId: 's1',
        rev: 1,
        atWordIndex: 1,
        newSegmentId: 's1b',
        newSpeakerId: null,
      },
    ]);

    const ordinals = after.segments.map((row) => row.ordinal);

    // Strictly increasing, with real room between every pair.
    for (let index = 1; index < ordinals.length; index += 1) {
      expect(ordinals[index] - ordinals[index - 1]).toBeGreaterThan(1e-4);
    }

    expect(after.segments.map((row) => row.id)).toEqual(['s1', 's1b', 's2', 's3']);
    // ⚠ The renumbered neighbour did NOT have its rev bumped — its content did
    // not change, and bumping it would 409 an unrelated editor.
    expect(after.segments.find((row) => row.id === 's2')?.rev).toBe(1);
  });
});

describe('segment.join — adjacency, the surviving speaker, and concatenation', () => {
  it('keeps the first segment id, ordinal and speaker, and concatenates the words', () => {
    const before = threeLines();
    const { state: after } = applyOps(before, [
      { op: OP_TYPES.JOIN, segmentIds: ['s1', 's2'], revs: [1, 1] },
    ]);

    const joined = after.segments.find((row) => row.id === 's1');

    expect(after.segments.map((row) => row.id)).toEqual(['s1', 's3']);
    expect(joined).toMatchObject({
      // Joining across a speaker change is allowed and the FIRST segment's
      // speaker survives (spec §4.1) — a user who wanted B follows up with
      // `segment.set_speaker`.
      speakerId: 'A',
      ordinal: ORDINAL_GAP,
      rev: 2,
      text: 'hello there world this is the second line',
    });
    expect(joined?.words).toEqual([
      ...before.segments[0].words,
      ...before.segments[1].words,
    ]);
    expect(joined?.startMs).toBe(before.segments[0].startMs);
    expect(joined?.endMs).toBe(before.segments[1].endMs);
    // Nothing was invented, so nothing degrades.
    expect(joined?.wordsAlignment).toBe('exact');
  });

  it('refuses two segments that are not adjacent', () => {
    expect(() =>
      applyOps(threeLines(), [
        { op: OP_TYPES.JOIN, segmentIds: ['s1', 's3'], revs: [1, 1] },
      ]),
    ).toThrow(/adjacent/);
  });

  it('refuses the same segment twice', () => {
    expect(() =>
      applyOps(threeLines(), [
        { op: OP_TYPES.JOIN, segmentIds: ['s1', 's1'], revs: [1, 1] },
      ]),
    ).toThrow(OpError);
  });

  it('takes the worse of the two alignments', () => {
    const before = state(
      [A],
      [
        segment('s1', 'A', 'one two'),
        segment('s2', 'A', 'three four', { wordsAlignment: 'none' }),
      ],
    );

    const { state: after } = applyOps(before, [
      { op: OP_TYPES.JOIN, segmentIds: ['s1', 's2'], revs: [1, 1] },
    ]);

    expect(after.segments[0].wordsAlignment).toBe('none');
  });
});

describe('speaker.merge — 3 → 1 (spec §4.1)', () => {
  it('re-points every segment, bumps each one, and deletes the sources', () => {
    const before = threeLines();
    const { state: after, merges } = applyOps(before, [
      { op: OP_TYPES.MERGE_SPEAKERS, sourceIds: ['B', 'C'], targetId: 'A' },
    ]);

    expect(after.speakers.map((row) => row.id)).toEqual(['A']);
    expect(after.segments.map((row) => row.speakerId)).toEqual(['A', 'A', 'A']);
    // The untouched segment keeps its rev; the two re-pointed ones bump,
    // exactly as `segment.set_speaker` would (spec §4.1).
    expect(after.segments.map((row) => row.rev)).toEqual([1, 2, 2]);
    // The target keeps its own name by default.
    expect(after.speakers[0].displayName).toBe('Speaker A');
    expect(after.speakers[0].rev).toBe(1);

    // The undo payload names the source speakers' previous segments, which is
    // the half of an inverse merge the client cannot reconstruct.
    expect(merges).toEqual([
      {
        targetId: 'A',
        sources: [
          {
            speakerId: 'B',
            label: 'B',
            displayName: 'Speaker B',
            colorIndex: 1,
            segmentIds: ['s2'],
          },
          {
            speakerId: 'C',
            label: 'C',
            displayName: 'Speaker C',
            colorIndex: 2,
            segmentIds: ['s3'],
          },
        ],
      },
    ]);
  });

  it('adopts the first source name when keepName is false', () => {
    const { state: after } = applyOps(threeLines(), [
      { op: OP_TYPES.MERGE_SPEAKERS, sourceIds: ['B', 'C'], targetId: 'A', keepName: false },
    ]);

    expect(after.speakers[0]).toMatchObject({ displayName: 'Speaker B', rev: 2 });
  });

  it('refuses to merge a speaker into itself', () => {
    expect(() =>
      applyOps(threeLines(), [
        { op: OP_TYPES.MERGE_SPEAKERS, sourceIds: ['A', 'B'], targetId: 'A' },
      ]),
    ).toThrow(OpError);
  });

  it('refuses a source or target that does not exist', () => {
    expect(() =>
      applyOps(threeLines(), [
        { op: OP_TYPES.MERGE_SPEAKERS, sourceIds: ['Z'], targetId: 'A' },
      ]),
    ).toThrow(OpError);

    expect(() =>
      applyOps(threeLines(), [
        { op: OP_TYPES.MERGE_SPEAKERS, sourceIds: ['B'], targetId: 'Z' },
      ]),
    ).toThrow(OpError);
  });
});

describe('conflicts (spec §5)', () => {
  it('collects EVERY stale entity rather than stopping at the first', () => {
    const { conflicts } = applyOps(threeLines(), [
      { op: OP_TYPES.UPDATE_TEXT, segmentId: 's1', rev: 99, text: 'nope' },
      { op: OP_TYPES.RENAME_SPEAKER, speakerId: 'B', rev: 99, displayName: 'nope' },
      { op: OP_TYPES.DELETE, segmentId: 's3', rev: 99 },
    ]);

    // One 409 naming all three, so a client resolves them in ONE re-fetch.
    expect(conflicts).toEqual([
      { entity: 'segment', id: 's1', current: 1 },
      { entity: 'speaker', id: 'B', current: 1 },
      { entity: 'segment', id: 's3', current: 1 },
    ]);
  });

  it('reports a segment somebody else deleted as `current: null`', () => {
    const { conflicts } = applyOps(threeLines(), [
      { op: OP_TYPES.UPDATE_TEXT, segmentId: 'gone', rev: 1, text: 'x' },
    ]);

    expect(conflicts).toEqual([{ entity: 'segment', id: 'gone', current: null }]);
  });

  it('does not let a batch conflict with itself', () => {
    // Both ops carry rev 1 because the client never saw the intermediate state.
    const { conflicts, state: after } = applyOps(threeLines(), [
      { op: OP_TYPES.UPDATE_TEXT, segmentId: 's1', rev: 1, text: 'first correction' },
      { op: OP_TYPES.UPDATE_TEXT, segmentId: 's1', rev: 1, text: 'second correction' },
    ]);

    expect(conflicts).toEqual([]);
    expect(after.segments[0].text).toBe('second correction');
    expect(after.segments[0].rev).toBe(3);
  });

  it('throws instead of collecting when replaying a version log', () => {
    expect(() =>
      applyOps(
        threeLines(),
        [{ op: OP_TYPES.UPDATE_TEXT, segmentId: 's1', rev: 99, text: 'x' }],
        { mode: 'replay' },
      ),
    ).toThrow(/version log disagrees/);
  });
});

describe('restore is not reducible', () => {
  it('throws, rather than pretending it applied', () => {
    expect(() =>
      applyOps(threeLines(), [{ op: OP_TYPES.RESTORE, fromVersion: 1 } as RecordedOp]),
    ).toThrow(/materialized, never reduced/);
  });
});

describe('countStateWords', () => {
  it('counts text tokens across every segment', () => {
    expect(countStateWords(threeLines())).toBe(3 + 5 + 3);
  });
});
