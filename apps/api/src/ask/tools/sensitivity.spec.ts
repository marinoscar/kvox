import { GRAPH_PREFERENCE_DEFAULTS } from '../../graph/preferences/graph-preferences.service';
import { itemVisible, personalFactsAllowedFor, sensitivityVisible, visiblePersonFactIds } from './sensitivity';

// =============================================================================
// Sensitivity rules (#377; spec §5.6/§14/§15): `sensitive` never, `personal`
// (and unclassified) only with the opt-in, `business` always.
// =============================================================================

describe('sensitivity rules', () => {
  it.each([
    ['sensitive', false, false],
    ['sensitive', true, false],
    ['personal', false, false],
    ['personal', true, true],
    [null, false, false],
    [null, true, true],
    ['business', false, true],
  ])('%s with opt-in=%s → %s', (s, allowed, expected) => {
    expect(sensitivityVisible(s, allowed)).toBe(expected);
  });

  it('applies only to PersonFacts among items', () => {
    expect(itemVisible({ kind: 'decision', sensitivity: null }, false)).toBe(true);
    expect(itemVisible({ kind: 'person_fact', sensitivity: 'personal' }, false)).toBe(false);
    expect(itemVisible({ kind: 'person_fact', sensitivity: 'sensitive' }, true)).toBe(false);
  });

  it('keeps the §14 opt-in off until a preference exists — even with the personal domain on', () => {
    expect(personalFactsAllowedFor(GRAPH_PREFERENCE_DEFAULTS)).toBe(false);
    expect(personalFactsAllowedFor({ ...GRAPH_PREFERENCE_DEFAULTS, domains: { core: true, work: true, personal: true } })).toBe(false);
  });

  it('looks up PersonFact sensitivity owner-scoped', async () => {
    const prisma = {
      kgItem: {
        findMany: jest.fn(async () => [
          { id: 'a', sensitivity: 'business' },
          { id: 'b', sensitivity: 'personal' },
          { id: 'c', sensitivity: 'sensitive' },
        ]),
      },
    };
    const visible = await visiblePersonFactIds(prisma as never, 'owner', ['a', 'b', 'c', 'd'], false);
    expect([...visible]).toEqual(['a']);
    expect(prisma.kgItem.findMany).toHaveBeenCalledWith({
      where: { ownerId: 'owner', id: { in: ['a', 'b', 'c', 'd'] }, kind: 'person_fact' },
      select: { id: true, sensitivity: true },
    });
    expect(await visiblePersonFactIds(prisma as never, 'owner', [], false)).toEqual(new Set());
  });
});
