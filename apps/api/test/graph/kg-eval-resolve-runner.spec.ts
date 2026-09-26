/**
 * The `extract+resolve` kg:eval runner (#364): extraction's rows resolved in
 * memory against the fixture's known entities with the production scorer —
 * no network, no key, no database.
 */

import { loadGoldenSet, selectFixtures } from '../../scripts/kg-eval/load';
import { KG_EVAL_RUNNERS } from '../../scripts/kg-eval/runner';
import { resolveRowsInMemory, trigramSimilarity } from '../../scripts/kg-eval/runners/extract-resolve-runner';
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
});
