import { GraphValidationError } from './graph-write.errors';
import { normalizeAlias, normalizeStatement, statementHash } from './normalize';

describe('normalizeAlias', () => {
  it('applies NFKC, so full-width letters fold to ASCII', () => {
    expect(normalizeAlias('ＡＣＭＥ　Ｃｏｒｐ')).toBe('acme corp');
  });

  it('lowercases locale-independently', () => {
    expect(normalizeAlias('SARAH CHEN')).toBe('sarah chen');
    expect(normalizeAlias('İstanbul')).toBe('i̇stanbul');
  });

  it('trims and collapses every run of whitespace to one space', () => {
    expect(normalizeAlias('  Sarah \t\n  Chen  ')).toBe('sarah chen');
  });

  it('strips leading and trailing punctuation and symbols, but keeps internal ones', () => {
    expect(normalizeAlias('"Dr. Sarah Chen!"')).toBe('dr. sarah chen');
    expect(normalizeAlias('-- AT&T --')).toBe('at&t');
    expect(normalizeAlias('★ Acme ★')).toBe('acme');
  });

  it('rejects an input that is empty once normalized', () => {
    for (const input of ['', '   ', '!!!', ' -- ', '★']) {
      expect(() => normalizeAlias(input)).toThrow(GraphValidationError);
    }
  });
});

describe('normalizeStatement', () => {
  it('collapses internal punctuation runs to their first character', () => {
    expect(normalizeStatement('Ship it... by Friday!!')).toBe('ship it. by friday');
  });

  it('rejects an empty statement', () => {
    expect(() => normalizeStatement(' ?! ')).toThrow(GraphValidationError);
  });
});

describe('statementHash', () => {
  it('is a sha256 hex digest', () => {
    expect(statementHash('claim', 'Revenue grew 20%')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across whitespace, case and punctuation-run variants of one statement', () => {
    const base = statementHash('claim', 'Revenue grew 20%');
    expect(statementHash('claim', '  revenue   GREW 20%  ')).toBe(base);
    expect(statementHash('claim', 'Revenue grew 20%!!!')).toBe(base);
    expect(statementHash('claim', 'Ｒｅｖｅｎｕｅ grew 20%')).toBe(base);
  });

  it('differs by kind and by wording', () => {
    const base = statementHash('claim', 'Revenue grew 20%');
    expect(statementHash('decision', 'Revenue grew 20%')).not.toBe(base);
    expect(statementHash('claim', 'Revenue grew 21%')).not.toBe(base);
  });
});
