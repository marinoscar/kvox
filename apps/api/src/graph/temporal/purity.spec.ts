import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// =============================================================================
// Purity guard for the temporal engine (issue #353)
// =============================================================================
//
// The engine's whole value is that the proposal builder, the commit, retrieval
// and the brief all apply the SAME rules. A clock read makes `as_of` and every
// test time-dependent; a database or framework import makes a rule something
// that can read a row. Either would turn one implementation back into several.
// Same discipline as `src/transcripts/editing/`.
// =============================================================================

const FORBIDDEN: [string, RegExp][] = [
  ['@prisma/client', /@prisma\/client/],
  ['PrismaService', /\bPrismaService\b/],
  ['@nestjs', /@nestjs\//],
  ['Date.now(', /\bDate\s*\.\s*now\s*\(/],
  ['new Date() without arguments', /\bnew\s+Date\s*\(\s*\)/],
  ['new Date without parentheses', /\bnew\s+Date\s*(?![\s(])/],
];

const sources = readdirSync(__dirname)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
  .sort();

describe('temporal engine purity', () => {
  it('scans every source file of the module', () => {
    expect(sources).toEqual(
      expect.arrayContaining([
        'as-of.ts',
        'commitments-to-review.ts',
        'index.ts',
        'plan-temporal-insert.ts',
        'types.ts',
        'valid-range.ts',
      ])
    );
  });

  describe.each(sources)('%s', (file) => {
    const text = readFileSync(join(__dirname, file), 'utf8');
    it.each(FORBIDDEN)('does not contain %s', (_label, pattern) => {
      expect(text).not.toMatch(pattern);
    });
  });

  it('the patterns catch what they are meant to catch', () => {
    const hits = (s: string) => FORBIDDEN.filter(([, p]) => p.test(s)).map(([l]) => l);
    expect(hits("import { PrismaClient } from '@prisma/client';")).toEqual(['@prisma/client']);
    expect(hits("import { Injectable } from '@nestjs/common';")).toEqual(['@nestjs']);
    expect(hits('const t = Date.now();')).toEqual(['Date.now(']);
    expect(hits('const t = new Date();')).toEqual(['new Date() without arguments']);
    expect(hits('const t = new Date;')).toEqual(['new Date without parentheses']);
    expect(hits('const t = new Date(0);')).toEqual([]);
    expect(hits('const t = new Date(start.getTime());')).toEqual([]);
  });
});
