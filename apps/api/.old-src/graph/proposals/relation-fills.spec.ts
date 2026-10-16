import { computeEffectiveSchema } from '@app/shared/ontology';

import { describeFills, isAbsentPropValue, knownRelationTargetOf, relationFills } from './relation-fills';

const schema = computeEffectiveSchema({ enabledDomains: ['core', 'work'], userAttributes: [] });
const REL = '0f000000-0000-4000-8000-000000000021';

describe('relation fills (#444)', () => {
  describe('relationFills', () => {
    it('{VP} stored, {VP, Consulting} proposed → fills the business unit', () => {
      expect(relationFills(schema, 'HAS_ROLE', { title: 'VP', businessUnit: 'Consulting' }, { title: 'VP' })).toEqual({
        businessUnit: 'Consulting',
      });
    });

    it('never overwrites a stored value, identity or not', () => {
      expect(
        relationFills(schema, 'HAS_ROLE', { title: 'Vice President', businessUnit: 'Consulting' }, { title: 'VP', businessUnit: 'Advisory' }),
      ).toEqual({});
    });

    it('a stored null, blank or empty value counts as absent; a proposed one fills nothing', () => {
      expect(relationFills(schema, 'HAS_ROLE', { title: 'VP', businessUnit: 'Consulting' }, { title: 'VP', businessUnit: null })).toEqual({
        businessUnit: 'Consulting',
      });
      expect(relationFills(schema, 'HAS_ROLE', { title: 'VP', businessUnit: 'Consulting' }, { title: 'VP', businessUnit: '  ' })).toEqual({
        businessUnit: 'Consulting',
      });
      expect(relationFills(schema, 'HAS_ROLE', { title: 'VP', businessUnit: null }, { title: 'VP' })).toEqual({});
      expect(relationFills(schema, 'HAS_ROLE', { title: 'VP' }, { title: 'VP' })).toEqual({});
    });

    it('ignores keys the relation type does not declare, and unknown types', () => {
      expect(relationFills(schema, 'HAS_ROLE', { title: 'VP', salary: 1 }, { title: 'VP' })).toEqual({});
      expect(relationFills(schema, 'NOT_A_TYPE', { title: 'VP' }, {})).toEqual({});
      expect(relationFills(schema, 'WORKS_FOR', { title: 'VP' }, {})).toEqual({});
    });

    it('skips a deprecated prop', () => {
      const withDeprecated = {
        relationType: (key: string) =>
          key === 'X'
            ? ({ props: [{ key: 'old', deprecated: true }, { key: 'fresh', deprecated: false }] } as never)
            : undefined,
      };
      expect(relationFills(withDeprecated, 'X', { old: 'a', fresh: 'b' }, {})).toEqual({ fresh: 'b' });
    });
  });

  it('isAbsentPropValue', () => {
    expect([null, undefined, '', ' ', []].every(isAbsentPropValue)).toBe(true);
    expect([0, false, 'x', ['a']].some(isAbsentPropValue)).toBe(false);
  });

  it('knownRelationTargetOf reads only a known verdict with a target', () => {
    expect(knownRelationTargetOf({ dedup: { verdict: 'known', targetRelationId: REL } })).toBe(REL);
    expect(knownRelationTargetOf({ dedup: { verdict: 'new', targetRelationId: null } })).toBeNull();
    expect(knownRelationTargetOf({ dedup: { verdict: 'known', targetRelationId: null } })).toBeNull();
    expect(knownRelationTargetOf({})).toBeNull();
  });

  it('describeFills spells the fill with the prop labels', () => {
    expect(describeFills(schema, 'HAS_ROLE', { businessUnit: 'Consulting' })).toBe('adds Business unit: Consulting');
    expect(describeFills(null, 'HAS_ROLE', { businessUnit: 'Consulting' })).toBe('adds businessUnit: Consulting');
    expect(describeFills(schema, 'HAS_ROLE', {})).toBeNull();
  });
});
