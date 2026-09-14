// =============================================================================
// Gap-based ordinals and the local renumber (issue #27, spec §3.4)
// =============================================================================

import { MIN_ORDINAL_GAP, ORDINAL_GAP, planInsertion } from './ordinals';

const rows = (...ordinals: number[]) =>
  ordinals.map((ordinal, index) => ({ id: `s${index + 1}`, ordinal }));

describe('planInsertion', () => {
  it('takes the midpoint and moves nobody, which is the whole point', () => {
    expect(planInsertion(rows(1000, 2000, 3000), 0)).toEqual({
      ordinal: 1500,
      renumbered: [],
    });
  });

  it('appends a gap past the end for the last segment', () => {
    expect(planInsertion(rows(1000, 2000), 1)).toEqual({
      ordinal: 2000 + ORDINAL_GAP,
      renumbered: [],
    });
  });

  it('survives dozens of splits at the same seam', () => {
    // The pathological sequence spec §3.4 names: repeatedly split the SAME
    // segment, halving the gap each time. Without the local renumber this stops
    // producing distinguishable ordinals after a few dozen rounds.
    let segments = rows(1000, 2000, 3000);

    for (let round = 0; round < 200; round += 1) {
      const plan = planInsertion(segments, 0);

      for (const moved of plan.renumbered) {
        segments = segments.map((row) => (row.id === moved.id ? { ...row, ordinal: moved.ordinal } : row));
      }

      segments = [...segments, { id: `new${round}`, ordinal: plan.ordinal }].sort(
        (a, b) => a.ordinal - b.ordinal,
      );

      for (let index = 1; index < segments.length; index += 1) {
        expect(segments[index].ordinal - segments[index - 1].ordinal).toBeGreaterThanOrEqual(
          MIN_ORDINAL_GAP * 0.999,
        );
      }
    }

    expect(segments).toHaveLength(203);
  });

  it('renumbers a NEIGHBOURHOOD, not the document', () => {
    // A thousand segments, with the seam jammed shut in one place. The fix must
    // not touch a thousand rows.
    const segments = [
      ...rows(...Array.from({ length: 500 }, (_, index) => (index + 1) * ORDINAL_GAP)),
    ];
    segments[250] = { id: 'jam', ordinal: segments[249].ordinal + 1e-9 };

    const plan = planInsertion(segments, 249);

    expect(plan.renumbered.length).toBeLessThan(10);
    expect(plan.ordinal).toBeGreaterThan(segments[248].ordinal);
  });

  it('throws for an index that names no segment', () => {
    expect(() => planInsertion(rows(1000), 5)).toThrow(/no segment at index/);
  });
});
