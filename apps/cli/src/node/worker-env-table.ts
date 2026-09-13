import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WORKER_ENV, type WorkerEnvKey } from './worker-env.js';

// =============================================================================
// The "Worker environment variables" table, generated from WORKER_ENV
// (issue #289, epic #254 — the documentation rollup)
// =============================================================================
//
// `apps/cli/README.md`'s worker environment variable table used to be typed
// out by hand, one row per `WORKER_ENV` entry. That is exactly the shape of
// drift `worker-env.ts`'s own header warns about: a variable renamed or added
// there is a variable the README silently stops describing correctly, and
// nothing fails — the same failure mode `worker-env.test.ts`'s branding guard
// exists to catch for the Dockerfile and compose file, one layer up.
//
// So the table is DERIVED, not retyped:
//
//   - the VARIABLE NAME comes from `WORKER_ENV` itself (imported, never
//     hand-copied), so a rename in `branding.ts` is reflected with zero edits
//     here — exactly the property the map's own header promises;
//   - the DESCRIPTION comes from the JSDoc comment already sitting above each
//     property in `worker-env.ts`. That is the ONLY place a human writes this
//     text; there is no second copy for a doc writer to keep in sync.
//
// `worker-env-table.test.ts` asserts the committed table in
// `apps/cli/README.md` (the block between the two marker comments below)
// equals what this module generates, so a drifted table is a failing test in
// CI rather than a stale doc nobody notices. `scripts/generate-worker-env
// -table.ts` is the writer that regenerates it.
// =============================================================================

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Extracts the JSDoc comment immediately preceding each `WORKER_ENV` property,
 * keyed by the property's own name (`serverUrl`, `nodeId`, ...).
 *
 * Reads `worker-env.ts` as TEXT rather than reflecting on the imported object,
 * because the description is not a runtime value — it lives only in the
 * comment. This mirrors `apps/cli/src/deploy/env-spec.ts`'s own approach to
 * `.env.example`: the file's comments ARE the specification, parsed rather
 * than restated.
 */
function parseWorkerEnvDescriptions(): Partial<Record<WorkerEnvKey, string>> {
  const source = readFileSync(join(HERE, 'worker-env.ts'), 'utf8');
  const descriptions: Partial<Record<WorkerEnvKey, string>> = {};

  // A `/** ... */` block immediately followed by `  <key>:` — the exact shape
  // every entry in the `WORKER_ENV` object literal takes. The leading
  // `[ \t]+` before `/**` is load-bearing: it is what excludes the doc
  // comment above `export const WORKER_ENV = {` itself, which starts at
  // column 0 rather than indented inside the object literal. Without it, a
  // `/** ... */` whose own trailing-key check fails (the file-level comment
  // is followed by `export const`, not a bare identifier and colon) makes the
  // non-greedy `[\s\S]*?` backtrack PAST that comment's own closing `*/` and
  // swallow everything up to the NEXT one — merging two unrelated comments
  // into one description.
  const pattern = /^[ \t]+\/\*\*([\s\S]*?)\*\/\s*\n[ \t]+(\w+):/gm;

  for (const match of source.matchAll(pattern)) {
    const raw = match[1] ?? '';
    const key = match[2] as WorkerEnvKey;

    // Strip each line's leading `*`, collapse paragraph breaks to a single
    // space. A multi-paragraph comment (heapTuned's) becomes one flowing
    // description rather than only its first sentence — nothing in the
    // comment is discarded on the way into the table.
    const text = raw
      .split('\n')
      .map((line) => line.replace(/^\s*\*\s?/, '').trim())
      .filter((line) => line.length > 0)
      .join(' ')
      .trim();

    if (text.length > 0) descriptions[key] = text;
  }

  return descriptions;
}

/** The HTML comment markers `apps/cli/README.md` wraps the generated table in. */
export const WORKER_ENV_TABLE_START = '<!-- GENERATED:WORKER_ENV_TABLE:START -->';
export const WORKER_ENV_TABLE_END = '<!-- GENERATED:WORKER_ENV_TABLE:END -->';

/**
 * Builds the markdown table, one row per `WORKER_ENV` entry, in the object's
 * own declaration order (identity pair first, then work, then runtime, then
 * memory — the same order `worker-env.ts` already reads in).
 *
 * Every key is included, `heapTuned` (the re-exec latch) among them — there
 * is no hand-picked "operator-facing" subset to keep in sync with the map;
 * its own JSDoc says plainly that it is not a knob to set by hand, and that
 * warning reaches the table for the same reason everything else here does.
 */
export function buildWorkerEnvTable(): string {
  const descriptions = parseWorkerEnvDescriptions();

  const rows = (Object.keys(WORKER_ENV) as WorkerEnvKey[]).map((key) => {
    const name = WORKER_ENV[key];
    const description = descriptions[key] ?? '';
    return `| \`${name}\` | ${description} |`;
  });

  return ['| Variable | Description |', '| --- | --- |', ...rows].join('\n');
}
