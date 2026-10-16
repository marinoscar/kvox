// =============================================================================
// The version summary (issue #27, epic #19)
// =============================================================================

import { OP_TYPES, type RecordedOp } from './ops';
import { summarizeOps } from './summary';

const update = (id: string): RecordedOp => ({
  op: OP_TYPES.UPDATE_TEXT,
  segmentId: id,
  rev: 1,
  text: 'x',
});

describe('summarizeOps', () => {
  it('describes a hand correction', () => {
    expect(summarizeOps([update('a'), update('b')])).toBe('Corrected 2 lines');
  });

  it('names the speaker a rename produced', () => {
    expect(
      summarizeOps([
        { op: OP_TYPES.RENAME_SPEAKER, speakerId: 'A', rev: 1, displayName: 'Dana' },
      ]),
    ).toBe('Renamed a speaker to Dana');
  });

  it('describes a find & replace by what was asked for, not by its expansion', () => {
    // The recorded ops are 12 `segment.update_text` rows; the sentence has to
    // say "one replacement across 12 lines", which only the expansion knows.
    const ops = Array.from({ length: 12 }, (_, index) => update(`s${index}`));

    expect(
      summarizeOps(ops, {
        findReplace: [{ find: 'Kvox', replace: 'KVox', segments: 12, occurrences: 19 }],
      }),
    ).toBe('Replaced “Kvox” with “KVox” (19 occurrences in 12 lines)');
  });

  it('reports hand edits beside a find & replace without double-counting', () => {
    const ops = [update('a'), update('b'), update('c')];

    expect(
      summarizeOps(ops, {
        findReplace: [{ find: 'x', replace: 'y', segments: 2, occurrences: 2 }],
      }),
    ).toBe('Replaced “x” with “y” (2 occurrences in 2 lines), Corrected 1 line');
  });

  it('names the surviving speaker of a merge', () => {
    expect(
      summarizeOps([{ op: OP_TYPES.MERGE_SPEAKERS, sourceIds: ['B', 'C'], targetId: 'A' }], {
        speakerNames: new Map([['A', 'Dana']]),
      }),
    ).toBe('Merged 2 speakers into Dana');
  });

  it('is just the restore, ignoring everything else', () => {
    expect(summarizeOps([{ op: OP_TYPES.RESTORE, fromVersion: 4 }])).toBe('Restored version 4');
  });

  it('covers the remaining ops', () => {
    expect(
      summarizeOps([
        { op: OP_TYPES.SET_SPEAKER, segmentId: 'a', rev: 1, speakerId: 'A' },
        {
          op: OP_TYPES.SPLIT,
          segmentId: 'a',
          rev: 1,
          atWordIndex: 1,
          newSegmentId: 'b',
          newSpeakerId: null,
        },
        { op: OP_TYPES.JOIN, segmentIds: ['a', 'b'], revs: [1, 1] },
        { op: OP_TYPES.DELETE, segmentId: 'c', rev: 1 },
        { op: OP_TYPES.CREATE_SPEAKER, speakerId: 'D', displayName: 'Sam', colorIndex: 3 },
      ]),
    ).toBe('Reassigned 1 line, Split 1 line, Joined 1 pair, Deleted 1 line, Added speaker Sam');
  });

  it('says so plainly when nothing changed', () => {
    expect(summarizeOps([])).toBe('No changes');
  });
});
