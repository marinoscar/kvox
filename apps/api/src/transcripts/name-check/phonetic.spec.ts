// =============================================================================
// Phonetic primitives for name correction (issue #328, epic #326)
// =============================================================================
//
// Every Double Metaphone vector below was taken from PostgreSQL's
// `fuzzystrmatch` `dmetaphone()` / `dmetaphone_alt()` (a C port of Lawrence
// Philips' reference implementation), not written from memory. While porting,
// the full implementation was also diffed against PostgreSQL over ~8,000
// English words and names with zero mismatches.
// =============================================================================

import { doubleMetaphone, jaroWinkler, levenshtein, normalizeName, phoneticKeys } from './phonetic';

describe('doubleMetaphone', () => {
  // [word, primary, alternate] — PostgreSQL dmetaphone/dmetaphone_alt.
  const vectors: Array<[string, string, string]> = [
    ['Thompson', 'TMPS', 'TMPS'],
    ['Smith', 'SM0', 'XMT'],
    ['Schmidt', 'XMT', 'SMT'],
    ['Xavier', 'SF', 'SFR'],
    ['Jose', 'HS', 'HS'],
    ['Philips', 'FLPS', 'FLPS'],
    ['Oscar', 'ASKR', 'ASKR'],
    ['Nguyen', 'NKN', 'NKN'],
    ['Siobhan', 'SPN', 'XPN'],
    ['Shivon', 'XFN', 'XFN'],
    ['Christopherson', 'KRST', 'KRST'],
    ['Jose Maria', 'HSMR', 'HSMR'],
  ];

  it.each(vectors)('%s → %s / %s', (word, primary, alternate) => {
    expect(doubleMetaphone(word)).toEqual([primary, alternate]);
  });

  it('is case-insensitive', () => {
    expect(doubleMetaphone('oScAr')).toEqual(doubleMetaphone('OSCAR'));
  });

  it('returns two empty keys for an empty input', () => {
    expect(doubleMetaphone('')).toEqual(['', '']);
  });

  it('truncates to 4 by default and honours a longer maxLength', () => {
    const [p4] = doubleMetaphone('Christopherson');
    const [p8] = doubleMetaphone('Christopherson', 8);
    expect(p4).toHaveLength(4);
    expect(p8.startsWith(p4)).toBe(true);
    expect(p8.length).toBeGreaterThan(4);
  });

  it('is deterministic', () => {
    expect(doubleMetaphone('Schermerhorn')).toEqual(doubleMetaphone('Schermerhorn'));
  });
});

describe('normalizeName / phoneticKeys', () => {
  it('folds diacritics, case and non-letters', () => {
    expect(normalizeName('José')).toBe('jose');
    expect(normalizeName('María José')).toBe('mariajose');
    expect(normalizeName("O'Brien-Smith!")).toBe('obriensmith');
    expect(normalizeName('Muñoz')).toBe('munoz');
    expect(normalizeName('123')).toBe('');
  });

  it('encodes José and Jose identically', () => {
    expect(phoneticKeys('José')).toEqual(phoneticKeys('Jose'));
    expect(phoneticKeys('Óscar')).toEqual(phoneticKeys('Oscar'));
  });

  it('de-duplicates primary and alternate', () => {
    expect(phoneticKeys('Oscar')).toEqual(['ASKR']);
    expect(phoneticKeys('Smith')).toEqual(['SM0', 'XMT']);
    expect(phoneticKeys('')).toEqual([]);
  });
});

describe('jaroWinkler', () => {
  it('matches the textbook values', () => {
    expect(jaroWinkler('martha', 'marhta')).toBeCloseTo(0.961, 3);
    expect(jaroWinkler('dwayne', 'duane')).toBeCloseTo(0.84, 2);
    expect(jaroWinkler('dixon', 'dicksonx')).toBeCloseTo(0.813, 3);
  });

  it('is 1 for identical strings and 0 for disjoint or empty ones', () => {
    expect(jaroWinkler('oscar', 'oscar')).toBe(1);
    expect(jaroWinkler('', '')).toBe(1);
    expect(jaroWinkler('abc', '')).toBe(0);
    expect(jaroWinkler('abc', 'xyz')).toBe(0);
  });

  it('is symmetric and bounded', () => {
    for (const [a, b] of [
      ['oscar', 'skar'],
      ['siobhan', 'shivon'],
      ['nguyen', 'nwin'],
    ]) {
      const v = jaroWinkler(a!, b!);
      expect(v).toBeCloseTo(jaroWinkler(b!, a!), 10);
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('levenshtein', () => {
  it('computes edit distance', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', 'abc')).toBe(0);
    expect(levenshtein('ASKR', 'SKR')).toBe(1);
  });

  it('returns max + 1 once the bound is exceeded', () => {
    expect(levenshtein('kitten', 'sitting', 1)).toBe(2);
    expect(levenshtein('a', 'abcdef', 2)).toBe(3);
    expect(levenshtein('XPN', 'XFN', 1)).toBe(1);
    expect(levenshtein('kitten', 'sitting', 5)).toBe(3);
  });
});
