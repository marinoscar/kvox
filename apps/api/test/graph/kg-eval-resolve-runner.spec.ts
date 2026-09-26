/**
 * The `extract+resolve` kg:eval runner (#364): extraction's rows resolved in
 * memory against the fixture's known entities with the production scorer —
 * no network, no key, no database.
 */

import { loadGoldenSet, selectFixtures } from '../../scripts/kg-eval/load';
import { KG_EVAL_RUNNERS } from '../../scripts/kg-eval/runner';
import { applyDedupStagesInMemory, resolveRowsInMemory, trigramSimilarity } from '../../scripts/kg-eval/runners/extract-resolve-runner';
import { fixtureToInput } from '../../scripts/kg-eval/runners/extract-runner';
import type { ProposedRow } from '../../src/graph/extraction/validate';

const [m01] = selectFixtures(loadGoldenSet(), ['m01'], null);

function personRow(ref: string, label: string, aliases: string[] = []): ProposedRow {
  return {
    kind: 'entity',
    payload: { ref, type: 'Person', label, aliases, props: {}, occurredAt: null },
    resolution: null,
    flags: [],
    evidence: [],
  };
}

describe('kg:eval extract+resolve runner (#364)', () => {
  it('is registered as `extract+resolve`', async () => {
    const runner = await KG_EVAL_RUNNERS['extract+resolve']();
    expect(runner.name).toBe('extract+resolve');
  });

  it('ports pg_trgm similarity closely enough to catch a misspelling', () => {
    expect(trigramSimilarity('Sarah Chen', 'Sarah Chen')).toBe(1);
    expect(trigramSimilarity('Sara Chen', 'Sarah Chen')).toBeGreaterThanOrEqual(0.4);
    expect(trigramSimilarity('Tom Hale', 'Sarah Chen')).toBeLessThan(0.4);
  });

  it('links a speaker-identified person outright and leaves an unknown one new', () => {
    const [sarah, stranger] = resolveRowsInMemory(m01, [personRow('e1', 'Sarah Chen'), personRow('e2', 'Zebulon Quux')]);
    expect(sarah.resolution).toMatchObject({ ref: 'g-person-sarah-chen', score: 1, source: 'speaker' });
    expect(stranger.resolution).toMatchObject({ ref: null });
  });

  it('scores a known non-speaker by alias through the production scorer', () => {
    const nonSpeaker = (f: typeof m01) => {
      const speakerIds = new Set(fixtureToInput(f).speakers.map((s) => s.personEntityId));
      return f.knownEntities.find((k) => !speakerIds.has(k.id));
    };
    const fixture = loadGoldenSet().find((f) => nonSpeaker(f) !== undefined)!;
    const known = nonSpeaker(fixture)!;
    const [row] = resolveRowsInMemory(fixture, [{ ...personRow('e1', known.label), payload: { ...personRow('e1', known.label).payload, type: known.type } } as ProposedRow]);
    expect(row.resolution?.candidates[0]).toMatchObject({ entityId: known.id });
    expect(row.resolution?.candidates[0].signals).toContain('alias_exact');
  });

  describe('#365 dedup and closing, in memory', () => {
    const linkedEntity = (ref: string, type: string, id: string): ProposedRow => ({
      kind: 'entity',
      payload: { ref, type, label: ref, aliases: [], props: {}, occurredAt: null },
      resolution: { ref: id, score: 1, source: 'alias', candidates: [], adjudication: null },
      flags: [],
      evidence: [],
    });
    const worksFor = (validFrom: string, to = 'e2'): ProposedRow => ({
      kind: 'relation',
      payload: { ref: 'r1', type: 'WORKS_FOR', from: { ref: 'e1' }, to: { ref: to }, props: {}, validFrom, validTo: null, precision: 'year' },
      resolution: null,
      flags: [],
      evidence: [],
    });
    const withPrior = {
      ...m01,
      knownRelations: [
        { id: 'k-works', type: 'WORKS_FOR', from: 'g-joe', to: 'g-acme', props: {}, validFrom: '2019-01-01', validTo: '2025-01-01', precision: 'year' as const },
        { id: 'k-role', type: 'WORKS_FOR', from: 'g-ann', to: 'g-acme', props: {}, validFrom: '2019-01-01', validTo: null, precision: 'year' as const },
      ],
    };

    it('a fact inside a known edge is known; a new employer closes an open edge', () => {
      const known = applyDedupStagesInMemory(withPrior, [linkedEntity('e1', 'Person', 'g-joe'), linkedEntity('e2', 'Organization', 'g-acme'), worksFor('2020-01-01')]);
      expect(known.rows[2].flags).toEqual(['known']);
      expect(known.stats).toMatchObject({ known: 1, closings: 0 });

      const moved = applyDedupStagesInMemory(withPrior, [
        linkedEntity('e1', 'Person', 'g-ann'),
        linkedEntity('e3', 'Organization', 'g-globex'),
        worksFor('2026-01-01', 'e3'),
      ]);
      expect(moved.stats).toMatchObject({ known: 0, closings: 1, overlaps: 0 });
    });

    it('does nothing without prior edges (every golden fixture today)', () => {
      const out = applyDedupStagesInMemory(m01, [linkedEntity('e1', 'Person', 'g-joe'), linkedEntity('e2', 'Organization', 'g-acme'), worksFor('2020-01-01')]);
      expect(out.stats).toEqual({ known: 0, closings: 0, overlaps: 0, unordered: 0 });
      expect(out.rows[2].flags).toEqual([]);
    });
  });
});
