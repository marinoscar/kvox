// =============================================================================
// Regenerate apps/cli/README.md's worker environment variable table
// (issue #289, epic #254 — the documentation rollup)
// =============================================================================
//
// The table itself is built by `src/node/worker-env-table.ts`, from
// `WORKER_ENV` and the JSDoc already written above each of its entries — see
// that file's header for why. This script is only the writer: it finds the
// `<!-- GENERATED:WORKER_ENV_TABLE:START/END -->` markers in
// `apps/cli/README.md` and replaces whatever sits between them.
//
// Usage (from `apps/cli`, matching this package's other npm scripts):
//
//   npm run docs:worker-env            # regenerate and write the README
//   npm run docs:worker-env:check      # exit 1 if the committed table is stale
//
// `worker-env-table.test.ts` runs the equivalent of `--check` on every test
// run, so a stale table is a red test in CI — this script is the fix, not the
// only place drift is caught.
// =============================================================================

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildWorkerEnvTable,
  WORKER_ENV_TABLE_END,
  WORKER_ENV_TABLE_START,
} from '../src/node/worker-env-table.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const README_PATH = join(HERE, '..', 'README.md');

function spliceTable(readme: string, table: string): string {
  const startIdx = readme.indexOf(WORKER_ENV_TABLE_START);
  const endIdx = readme.indexOf(WORKER_ENV_TABLE_END);

  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(
      `Could not find both ${WORKER_ENV_TABLE_START} and ${WORKER_ENV_TABLE_END} markers in ` +
        `${README_PATH}. They must not be removed — the generator has nowhere to write.`,
    );
  }

  const before = readme.slice(0, startIdx + WORKER_ENV_TABLE_START.length);
  const after = readme.slice(endIdx);

  return `${before}\n${table}\n${after}`;
}

function main(): void {
  const checkOnly = process.argv.includes('--check');
  const readme = readFileSync(README_PATH, 'utf8');
  const next = spliceTable(readme, buildWorkerEnvTable());

  if (next === readme) {
    console.log("apps/cli/README.md's worker environment variable table is already up to date.");
    return;
  }

  if (checkOnly) {
    console.error(
      "apps/cli/README.md's worker environment variable table is out of date. Run " +
        '`npm run docs:worker-env --workspace=cli` to regenerate it.',
    );
    process.exitCode = 1;
    return;
  }

  writeFileSync(README_PATH, next);
  console.log('Regenerated the worker environment variable table in apps/cli/README.md.');
}

main();
