import {
  acronymOf,
  containment,
  duplicateScore,
  findNamePairs,
  initialsMatch,
  initialsOf,
  nameReasons,
  nameTokens,
  pairKey,
} from './duplicate-names.js';

describe('nameTokens', () => {
  it('splits on punctuation and drops empties', () => {
    expect(nameTokens('ernst & young')).toEqual(['ernst', 'young']);
    expect(nameTokens("o'brien-smith")).toEqual(['o', 'brien', 'smith']);
  });
});

describe('containment', () => {
  it('finds a whole-word prefix', () => {
    expect(containment('oscar', 'oscar marin')).toBe('prefix');
    expect(containment('oscar marin', 'oscar')).toBe('prefix');
  });
  it('finds a whole-word run that is not the prefix', () => {
    expect(containment('marin', 'oscar marin')).toBe('inner');
    expect(containment('knowledge graph', 'the knowledge graph team')).toBe('inner');
  });
  it('never matches inside a word: Al / Alan', () => {
    expect(containment('al', 'alan')).toBeNull();
    expect(containment('al', 'alan smith')).toBeNull();
    expect(containment('osc', 'oscar marin')).toBeNull();
  });
  it('needs at least 3 letters in the shorter name: Al / Al Pacino is noise', () => {
    expect(containment('al', 'al pacino')).toBeNull();
    expect(containment('bob', 'bob jones')).toBe('prefix');
  });
  it('ignores stopword-only names and equal names', () => {
    expect(containment('the', 'the beatles')).toBeNull();
    expect(containment('oscar marin', 'oscar marin')).toBeNull();
  });
});

describe('acronyms and initials', () => {
  it('reads an acronym only from 2 to 6 letters', () => {
    expect(acronymOf('ey')).toBe('ey');
    expect(acronymOf('i.b.m')).toBe('ibm');
    expect(acronymOf('e')).toBeNull();
    expect(acronymOf('abcdefg')).toBeNull();
    expect(acronymOf('ab1')).toBeNull();
    expect(acronymOf('ernst young')).toBeNull();
  });
  it('builds initials with and without stopwords', () => {
    expect(initialsOf('ernst & young')).toEqual(['ey']);
    expect(initialsOf('bank of america')).toEqual(['ba', 'boa']);
    expect(initialsOf('oscar')).toEqual([]);
    expect(initialsOf('the office')).toEqual([]);
  });
  it('matches EY, IBM and KG', () => {
    expect(initialsMatch('ey', 'ernst & young')).toBe(true);
    expect(initialsMatch('ernst & young', 'ey')).toBe(true);
    expect(initialsMatch('ibm', 'international business machines')).toBe(true);
    expect(initialsMatch('kg', 'knowledge graph')).toBe(true);
    expect(initialsMatch('boa', 'bank of america')).toBe(true);
    expect(initialsMatch('ba', 'bank of america')).toBe(true);
  });
  it('does not match a wrong acronym or a one-word name', () => {
    expect(initialsMatch('ey', 'ernst young consulting')).toBe(false);
    expect(initialsMatch('ab', 'alan')).toBe(false);
    expect(initialsMatch('oscar', 'oscar marin')).toBe(false);
  });
});

describe('nameReasons', () => {
  it('Oscar / Oscar Marin', () => {
    expect(nameReasons(['oscar'], ['oscar marin'])).toEqual(['name_contained']);
  });
  it('EY / Ernst & Young', () => {
    expect(nameReasons(['ey'], ['ernst & young'])).toEqual(['initials']);
  });
  it('IBM and KG', () => {
    expect(nameReasons(['ibm'], ['international business machines'])).toEqual(['initials']);
    expect(nameReasons(['kg'], ['knowledge graph'])).toEqual(['initials']);
  });
  it('no false positive: Al / Alan', () => {
    expect(nameReasons(['al'], ['alan'])).toEqual([]);
  });
  it('a shared alias is alias_match, and every name pairing is tried', () => {
    expect(nameReasons(['oscar marin', 'zed'], ['oscar m', 'zed'])).toEqual(['alias_match']);
    expect(nameReasons(['ey consulting', 'ey'], ['ernst & young'])).toEqual(['initials']);
  });
  it('reports several signals in a stable order', () => {
    expect(nameReasons(['oscar', 'zed'], ['oscar marin', 'zed'])).toEqual(['alias_match', 'name_contained']);
  });
});

describe('duplicateScore', () => {
  it('is the best signal, plus 0.05 per extra, capped at 1', () => {
    expect(duplicateScore(['name_contained'])).toBe(0.8);
    expect(duplicateScore(['initials'])).toBe(0.75);
    expect(duplicateScore(['alias_match'])).toBe(0.95);
    expect(duplicateScore(['alias_match', 'name_contained'])).toBe(1);
    expect(duplicateScore(['name_contained', 'initials'])).toBe(0.85);
    expect(duplicateScore([])).toBe(0);
  });
  it('lets a trigram similarity or a proposal score raise the base', () => {
    expect(duplicateScore(['similar_name'], 0.88)).toBe(0.88);
    expect(duplicateScore(['similar_name'], 0.5)).toBe(0.6);
    expect(duplicateScore(['resolution_proposal'], 0.9)).toBe(0.9);
  });
  it('de-duplicates repeated reasons', () => {
    expect(duplicateScore(['initials', 'initials'])).toBe(0.75);
  });
});

describe('pairKey', () => {
  it('is order independent and lowercase', () => {
    expect(pairKey('B', 'a')).toBe('a:b');
    expect(pairKey('a', 'B')).toBe('a:b');
  });
});

describe('findNamePairs', () => {
  const e = (id: string, type: string, ...names: string[]) => ({ id, type, names });

  it('finds containment, initials and shared aliases in one type, once per pair', () => {
    const pairs = findNamePairs([
      e('1', 'Person', 'oscar'),
      e('2', 'Person', 'oscar marin'),
      e('3', 'Organization', 'ey'),
      e('4', 'Organization', 'ernst & young'),
      e('5', 'Organization', 'acme', 'roadrunner'),
      e('6', 'Organization', 'roadrunner inc', 'roadrunner'),
    ]);
    const byKey = new Map(pairs.map((p) => [pairKey(p.aId, p.bId), p.reasons]));
    expect(byKey.get('1:2')).toEqual(['name_contained']);
    expect(byKey.get('3:4')).toEqual(['initials']);
    expect(byKey.get('5:6')).toEqual(['alias_match', 'name_contained']);
    expect(pairs).toHaveLength(3);
  });

  it('never pairs across types', () => {
    expect(findNamePairs([e('1', 'Person', 'oscar'), e('2', 'Organization', 'oscar marin')])).toEqual([]);
  });

  it('skips a word shared by too many entities', () => {
    const many = Array.from({ length: 60 }, (_, i) => e(`p${i}`, 'Person', `smith${i} jones`));
    expect(findNamePairs([...many, e('x', 'Person', 'jones')])).toEqual([]);
  });
});

import { findSynonymPairs } from './duplicate-names.js';

describe('findSynonymPairs (#767)', () => {
  const ents = [
    { id: 'a', type: 'Organization', names: ['ey'] },
    { id: 'b', type: 'Organization', names: ['ernst & young', 'e&y'] },
    { id: 'c', type: 'Person', names: ['ey'] },
    { id: 'd', type: 'Organization', names: ['acme'] },
  ];
  it('pairs same-type entities that fall in one group', () => {
    expect(findSynonymPairs(ents, [{ normalized: ['ey', 'ernst & young'], entityType: null }])).toEqual([
      { aId: 'a', bId: 'b', reasons: ['synonym'] },
    ]);
  });
  it('respects the group entity type and finds nothing without a match', () => {
    expect(findSynonymPairs(ents, [{ normalized: ['ey', 'ernst & young'], entityType: 'Person' }])).toEqual([]);
    expect(findSynonymPairs(ents, [{ normalized: ['x', 'y'], entityType: null }])).toEqual([]);
  });
});
