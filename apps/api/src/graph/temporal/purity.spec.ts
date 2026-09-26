// =============================================================================
// ⚠ THE TEMPORAL ENGINE IS PURE (issue #353, epic #344)
// =============================================================================
//
// The executable form of the rule in `index.ts`'s header, in the same spirit
// as the transcript editing reducers and `src/search/chunking/index.spec.ts`.
// A clock inside the engine makes `as_of` and every test time-dependent; a
// database or framework import makes the planner something #365 cannot call
// on in-memory candidates before anything is written. Neither regression
// breaks an existing test in the file that introduces it — hence this guard.
// =============================================================================

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const sourceFiles = readdirSync(__dirname)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'))
  .sort();

/** Code with comments stripped: the headers argue ABOUT the forbidden things. */
const code = (name: string): string =>
  readFileSync(join(__dirname, name), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');

const FORBIDDEN = [
  { pattern: /@prisma\/client/, why: 'a Prisma import' },
  { pattern: /PrismaService/, why: 'PrismaService' },
  { pattern: /@nestjs\//, why: 'a NestJS import' },
  { pattern: /Date\.now\s*\(/, why: 'a clock read (Date.now)' },
  { pattern: /new Date\(\s*\)/, why: 'a clock read (argument-less Date)' },
  { pattern: /performance\.now/, why: 'a clock read (performance.now)' },
  { pattern: /Math\.random|randomUUID/, why: 'a random source' },
  { pattern: /process\.env/, why: 'an environment read' },
  { pattern: /\brequire\s*\(|\bimport\s*\(/, why: 'a dynamic import' },
];

describe('the temporal engine directory is pure', () => {
  it('has the files this module is documented to have', () => {
    expect(sourceFiles).toEqual([
      'as-of.ts',
      'commitments-to-review.ts',
      'index.ts',
      'plan-temporal-insert.ts',
      'types.ts',
      'valid-range.ts',
    ]);
  });

  describe.each(sourceFiles)('%s', (file) => {
    it.each(FORBIDDEN)('contains no $why', ({ pattern }) => {
      expect(code(file)).not.toMatch(pattern);
    });

    it('imports only its own siblings', () => {
      const specifiers = [
        ...code(file).matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/gm),
      ].map((m) => m[1]);
      for (const s of specifiers) expect(s).toMatch(/^\.\/[a-z-]+$/);
    });
  });

  it('the guard itself catches what it claims to', () => {
    const sample = "import { x } from '@nestjs/common';\nconst t = new Date();\nDate.now();";
    expect(sample).toMatch(FORBIDDEN[2].pattern);
    expect(sample).toMatch(FORBIDDEN[3].pattern);
    expect(sample).toMatch(FORBIDDEN[4].pattern);
    expect('new Date(0)').not.toMatch(FORBIDDEN[4].pattern);
  });
});
