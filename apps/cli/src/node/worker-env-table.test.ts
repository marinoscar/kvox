import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { WORKER_ENV } from './worker-env.js';
import {
  buildWorkerEnvTable,
  WORKER_ENV_TABLE_END,
  WORKER_ENV_TABLE_START,
} from './worker-env-table.js';

// =============================================================================
// The committed worker environment variable table must equal the generated
// one (issue #289, epic #254 — the documentation rollup)
// =============================================================================
//
// `apps/cli/README.md` used to hand-type this table, and a variable renamed
// or added to `WORKER_ENV` cost nothing to build or run — the doc simply went
// stale, silently, exactly like `worker-env.test.ts`'s branding guard exists
// to catch for the Dockerfile and compose file. This is that same guard for
// the README: a drifted table is THIS test failing, not a stale page nobody
// notices.
//
// Regenerate with `npm run docs:worker-env --workspace=cli`.
// =============================================================================

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const README_PATH = join(REPO_ROOT, 'apps', 'cli', 'README.md');

describe('the worker environment variable table in apps/cli/README.md', () => {
  it('reads the README (the guard is not vacuously green)', () => {
    const readme = readFileSync(README_PATH, 'utf8');
    expect(readme.length).toBeGreaterThan(1000);
  });

  it('equals buildWorkerEnvTable() — the ONE way this table may change', () => {
    const readme = readFileSync(README_PATH, 'utf8');

    const startIdx = readme.indexOf(WORKER_ENV_TABLE_START);
    const endIdx = readme.indexOf(WORKER_ENV_TABLE_END);

    expect(startIdx, `${WORKER_ENV_TABLE_START} marker not found in apps/cli/README.md`).toBeGreaterThan(-1);
    expect(endIdx, `${WORKER_ENV_TABLE_END} marker not found in apps/cli/README.md`).toBeGreaterThan(startIdx);

    const committed = readme.slice(startIdx + WORKER_ENV_TABLE_START.length, endIdx).trim();
    const generated = buildWorkerEnvTable().trim();

    expect(
      committed,
      'The committed table has drifted from WORKER_ENV. Run `npm run docs:worker-env --workspace=cli` ' +
        'to regenerate it, then commit the result.',
    ).toBe(generated);
  });

  it('documents every WORKER_ENV variable, including the internal ones — no hand-picked subset', () => {
    const table = buildWorkerEnvTable();

    for (const name of Object.values(WORKER_ENV)) {
      expect(table, `${name} is missing from the generated table`).toContain(`\`${name}\``);
    }
  });

  it('generates a stable, non-empty description for every variable', () => {
    const rows = buildWorkerEnvTable()
      .split('\n')
      .slice(2); // drop the header row and the separator row

    expect(rows.length).toBe(Object.keys(WORKER_ENV).length);

    for (const row of rows) {
      // `| \`APPCTL_X\` | description |` — the description cell must not be empty.
      const cells = row.split('|').map((cell) => cell.trim());
      expect(cells[2], row).not.toBe('');
    }
  });
});
