import { expandNamesWith, groupAppliesToType, normalizeSynonymTerms } from './synonym-terms.js';

describe('normalizeSynonymTerms', () => {
  it('normalizes with normalizeAlias and keeps the first spelling of each distinct form', () => {
    expect(normalizeSynonymTerms([' OAC ', 'Org  Alpha  Consulting', 'oac.', 'O&C'])).toEqual({
      terms: ['OAC', 'Org  Alpha  Consulting', 'O&C'],
      normalized: ['oac', 'org alpha consulting', 'o&c'],
    });
  });

  it('collapses case-only differences to fewer than two distinct terms', () => {
    expect(normalizeSynonymTerms(['OAC', 'oac', 'Oac']).normalized).toEqual(['oac']);
  });

  it('refuses a term with no letter or digit', () => {
    expect(() => normalizeSynonymTerms(['OAC', '---'])).toThrow();
  });
});

describe('expandNamesWith', () => {
  const groups = [
    { normalized: ['oac', 'org alpha consulting'], entityType: null },
    { normalized: ['mit', 'massachusetts institute of technology'], entityType: 'Organization' },
  ];
  it('adds the other terms of a group containing a name', () => {
    expect(expandNamesWith(['oac'], 'Organization', groups)).toEqual(['org alpha consulting']);
  });
  it('honours the group entity type', () => {
    expect(expandNamesWith(['mit'], 'Person', groups)).toEqual([]);
    expect(expandNamesWith(['mit'], 'Organization', groups)).toEqual(['massachusetts institute of technology']);
  });
  it('adds nothing when no group matches or the names already cover the group', () => {
    expect(expandNamesWith(['kappa'], 'Organization', groups)).toEqual([]);
    expect(expandNamesWith(['oac', 'org alpha consulting'], 'Organization', groups)).toEqual([]);
    expect(groupAppliesToType(null, 'X')).toBe(true);
  });
});
