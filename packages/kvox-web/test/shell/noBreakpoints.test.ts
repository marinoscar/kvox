/**
 * The shell reads no breakpoint (issue #629). The five coupled gates are the
 * platform's; a sixth read here would let the chrome disagree with the gate that
 * decides which treatment mounts. `apps/web/src/__tests__/config/breakpointGates.test.ts`
 * scans this package too; this is the local twin, scoped to the shell slice.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SHELL_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'shell');

describe('the shell slice', () => {
  it('reads no breakpoint or media query', () => {
    const files = readdirSync(SHELL_SRC).filter((name) => /\.tsx?$/.test(name));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const code = readFileSync(join(SHELL_SRC, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/useMediaQuery|breakpoints\.(up|down|between|only)|matchMedia|@media/);
    }
  });
});
