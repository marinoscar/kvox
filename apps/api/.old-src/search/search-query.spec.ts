// =============================================================================
// `search-query.ts` — the pure half of the request (issue #175, epic #164)
// =============================================================================

import {
  isStopwordOnly,
  normalizeQueryText,
  parseTypesParam,
  titleLikePattern,
  SEARCH_TYPES,
} from './search-query';

describe('parseTypesParam', () => {
  it('defaults to both types when the parameter is absent', () => {
    expect(parseTypesParam(undefined)).toEqual([...SEARCH_TYPES]);
    expect(parseTypesParam(null)).toEqual([...SEARCH_TYPES]);
  });

  it('accepts either type on its own', () => {
    expect(parseTypesParam('transcript')).toEqual(['transcript']);
    expect(parseTypesParam('note')).toEqual(['note']);
  });

  it('normalises order and duplicates so the cursor fingerprint is stable', () => {
    // `note,transcript,note` and `transcript,note` are the same search, and a
    // cursor minted under one must be accepted under the other — otherwise a
    // client that reorders its filter chips gets a 400 it cannot explain.
    expect(parseTypesParam('note,transcript,note')).toEqual([...SEARCH_TYPES]);
    expect(parseTypesParam('transcript,note')).toEqual([...SEARCH_TYPES]);
  });

  it('tolerates whitespace and case around the tokens', () => {
    expect(parseTypesParam(' Transcript , NOTE ')).toEqual([...SEARCH_TYPES]);
  });

  it('rejects an unknown type rather than ignoring it', () => {
    // Ignoring it would silently widen a filter the client deliberately
    // narrowed — `types=trancsript` (typo) would search everything.
    expect(parseTypesParam('transcript,speaker')).toBeNull();
    expect(parseTypesParam('everything')).toBeNull();
  });

  it('rejects an empty parameter rather than treating it as "both"', () => {
    expect(parseTypesParam('')).toBeNull();
    expect(parseTypesParam('   ')).toBeNull();
    expect(parseTypesParam(',,')).toBeNull();
  });
});

describe('isStopwordOnly', () => {
  it('is true for a query Postgres parsed into nothing', () => {
    // `numnode(plainto_tsquery('english', 'the and of'))` is 0 — the empty
    // tsquery, which matches no row anywhere.
    expect(isStopwordOnly(0)).toBe(true);
  });

  it('is false for a query with lexemes in it', () => {
    // `numnode(plainto_tsquery('english', 'pricing model'))` is 3: two
    // lexemes and the AND node joining them.
    expect(isStopwordOnly(3)).toBe(false);
    expect(isStopwordOnly(1)).toBe(false);
  });

  it('degrades rather than guessing when the count is missing or unusable', () => {
    // The safe direction: the degraded path still returns rows a user
    // recognises, the full-text path would return nothing.
    expect(isStopwordOnly(null)).toBe(true);
    expect(isStopwordOnly(undefined)).toBe(true);
    expect(isStopwordOnly(Number.NaN)).toBe(true);
  });
});

describe('normalizeQueryText', () => {
  it('collapses surrounding and internal whitespace', () => {
    expect(normalizeQueryText('  pricing   model ')).toBe('pricing model');
    expect(normalizeQueryText('pricing\t\nmodel')).toBe('pricing model');
  });

  it('preserves case', () => {
    // It makes no difference to `plainto_tsquery`, but it does to the degraded
    // path's `<mark>` placement — two different renderings must not share one
    // cursor.
    expect(normalizeQueryText('Pricing')).toBe('Pricing');
  });
});

describe('titleLikePattern', () => {
  it('wraps the term in wildcards', () => {
    expect(titleLikePattern('pricing')).toBe('%pricing%');
  });

  it('defuses `%`, so a lone percent sign does not match the whole corpus', () => {
    expect(titleLikePattern('%')).toBe('%\\%%');
    expect(titleLikePattern('50% off')).toBe('%50\\% off%');
  });

  it('defuses `_`, so a lone underscore does not match every one-character title', () => {
    expect(titleLikePattern('_')).toBe('%\\_%');
  });

  it('escapes the escape character first, so the escapes it adds are not doubled', () => {
    expect(titleLikePattern('a\\b')).toBe('%a\\\\b%');
    expect(titleLikePattern('\\%')).toBe('%\\\\\\%%');
  });
});
