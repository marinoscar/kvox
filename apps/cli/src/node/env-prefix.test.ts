import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ENV_PREFIX } from '../branding.js';

// =============================================================================
// The template guard: no env-variable literals outside branding.ts  (issue #272)
// =============================================================================
//
// The deliverable of #272 that matters most. Every other acceptance criterion
// describes behaviour somebody could restore by hand after a rename; this one
// makes the rename itself impossible to get half-right.
//
// The rule: NO STRING LITERAL under `apps/cli/src` starts with `ENV_PREFIX`,
// except in `branding.ts` (which defines the prefix) and in test files (which
// legitimately assert the concrete name a user types).
//
// THE PATTERN IS BUILT FROM `ENV_PREFIX`, never written out — otherwise this
// guard would itself contain the literal it exists to forbid, and the rename
// it protects would have to include the guard. That is the same reasoning
// `branding.test.ts` uses for the `bin` key.
//
// COMMENTS ARE STRIPPED FIRST. `config.ts` explains `APPCTL_TOKEN` in prose in
// half a dozen places, and prose is exactly where the concrete name belongs:
// it is what the reader will type. What must not exist is a `process.env`
// lookup or a help string carrying the name, because those are the ones a
// rename silently breaks.
// =============================================================================

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..');

/** Files allowed to contain the literal, relative to `src/`. */
const ALLOWED = new Set(['branding.ts']);

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc);
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    // Tests may name variables outright: asserting `NO_TUI_ENV_VAR ===
    // 'APPCTL_NO_TUI'` is the whole point of such a test, and a rename is
    // MEANT to break it.
    if (/\.test\.tsx?$/.test(entry)) continue;
    acc.push(full);
  }
  return acc;
}

/**
 * Remove `//` and block comments, then look at what is left.
 *
 * Crude on purpose — a comment marker inside a string literal would over-strip
 * — but it only ever makes the guard MORE permissive on a line it misreads,
 * and the corpus it runs against is this package's own source, where the shape
 * is known.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('the env-prefix guard (issue #272, epic #254)', () => {
  const files = sourceFiles(SRC);

  it('finds source files to scan (the guard is not vacuously green)', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files.map((file) => [relative(SRC, file), file] as const))(
    'src/%s contains no environment-variable literal',
    (rel, file) => {
      if (ALLOWED.has(rel)) return;

      // Built, never written. `[A-Z0-9_]*` rather than `+` so a bare prefix on
      // its own is caught too.
      const pattern = new RegExp(`${ENV_PREFIX}[A-Z0-9_]*`, 'g');
      const found = stripComments(readFileSync(file, 'utf8')).match(pattern);

      expect(
        found ?? [],
        `${rel} names an environment variable directly. Build it with envVar() from branding.ts ` +
          'and, for a worker variable, declare it in node/worker-env.ts.',
      ).toEqual([]);
    },
  );
});
