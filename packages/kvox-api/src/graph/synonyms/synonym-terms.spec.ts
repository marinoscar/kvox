import { expandNamesWith, groupAppliesToType, normalizeSynonymTerms } from './synonym-terms.js';

describe('normalizeSynonymTerms', () => {
  it('normalizes with normalizeAlias and keeps the first spelling of each distinct form', () => {
    expect(normalizeSynonymTerms([' EY ', 'Ernst  &  Young', 'ey.', 'E&Y'])).toEqual({
      terms: ['EY', 'Ernst  &  Young', 'E&Y'],
      normalized: ['ey', 'ernst & young', 'e&y'],
    });
  });

  it('collapses case-only differences to fewer than two distinct terms', () => {
    expect(normalizeSynonymTerms(['EY', 'ey', 'Ey']).normalized).toEqual(['ey']);
  });

  it('refuses a term with no letter or digit', () => {
    expect(() => normalizeSynonymTerms(['EY', '---'])).toThrow();
  });
});

describe('expandNamesWith', () => {
  const groups = [
    { normalized: ['ey', 'ernst & young'], entityType: null },
    { normalized: ['mit', 'massachusetts institute of technology'], entityType: 'Organization' },
  ];
  it('adds the other terms of a group containing a name', () => {
    expect(expandNamesWith(['ey'], 'Organization', groups)).toEqual(['ernst & young']);
  });
  it('honours the group entity type', () => {
    expect(expandNamesWith(['mit'], 'Person', groups)).toEqual([]);
    expect(expandNamesWith(['mit'], 'Organization', groups)).toEqual(['massachusetts institute of technology']);
  });
  it('adds nothing when no group matches or the names already cover the group', () => {
    expect(expandNamesWith(['acme'], 'Organization', groups)).toEqual([]);
    expect(expandNamesWith(['ey', 'ernst & young'], 'Organization', groups)).toEqual([]);
    expect(groupAppliesToType(null, 'X')).toBe(true);
  });
});
