import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ENV_PREFIX } from '../branding.js';
import { SERVER_URL_ENV_VAR, TOKEN_ENV_VAR } from '../config.js';
import { WORKER_ENV, workerEnvNames } from './worker-env.js';
import { APP_NAME } from '@app/shared';

// =============================================================================
// WORKER_ENV — the map every worker variable is declared in  (issue #272)
// =============================================================================
//
// #278 adds the bidirectional Dockerfile/compose guard to this same area. What
// is asserted here is the map's own invariants: it derives from the branding
// prefix, and its first two entries are the EXISTING variables rather than new
// names for the same values.
// =============================================================================

describe('WORKER_ENV', () => {
  it('reuses the existing server-URL and token variables rather than minting new ones', () => {
    // If these ever drift apart, a machine gets `appctl api` working and
    // `appctl node start` not working, with no way for a user to tell why.
    expect(WORKER_ENV.serverUrl).toBe(SERVER_URL_ENV_VAR);
    expect(WORKER_ENV.token).toBe(TOKEN_ENV_VAR);
  });

  it('derives every variable from the branding prefix', () => {
    for (const [key, value] of Object.entries(WORKER_ENV)) {
      expect(value.startsWith(ENV_PREFIX), `${key} (${value})`).toBe(true);
    }
  });

  it('has no duplicate variable names', () => {
    const values = Object.values(WORKER_ENV);
    expect(new Set(values).size).toBe(values.length);
  });

  it('declares every variable the worker reads, sorted and deduplicated', () => {
    const names = workerEnvNames();
    expect(names).toEqual([...names].sort());
    expect(names).toHaveLength(new Set(names).size);
    expect(names).toContain(WORKER_ENV.stateDir);
  });
});

// =============================================================================
// The branding guard  (issue #278, epic #254)
// =============================================================================
//
// A Dockerfile and a compose file cannot call TypeScript, so the worker's
// environment-variable names are written out a second time in both. That is
// unavoidable — and it is the single place in this epic most likely to break
// the template constraint, because nothing about a stale literal fails at
// build time or at run time. It just quietly stops working.
//
// So the duplication is guarded in BOTH DIRECTIONS, because each direction
// catches a different mistake:
//
//   (a) every value in WORKER_ENV appears literally in both files
//       → catches a RENAME that updated the map but not the files. The
//         container would then set variables nothing reads and the worker
//         would start with defaults nobody asked for.
//
//   (b) every prefixed token in those files is a member of WORKER_ENV
//       → catches a variable HAND-ADDED to compose that no code reads. An
//         operator sets it, nothing happens, and there is no error to find.
//
// THE PATTERN IS BUILT FROM `ENV_PREFIX`, never written out — otherwise this
// guard would contain the very literal it exists to police, and a rename would
// have to include the guard.
//
// Written in the style of `apps/api/test/production-image.spec.ts`, which
// already reads a Dockerfile as text and asserts a RULE rather than a line.
// =============================================================================

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');

const GUARDED_FILES = [
  join(REPO_ROOT, 'apps', 'cli', 'Dockerfile'),
  join(REPO_ROOT, 'infra', 'compose', 'worker.compose.yml'),
] as const;

/** Names that appear in prose but are not variables. There are none today. */
const PROSE_ONLY = new Set<string>([]);

describe('the worker container branding guard (issue #278)', () => {
  const contents = GUARDED_FILES.map((path) => [path, readFileSync(path, 'utf8')] as const);

  it('reads both guarded files (the guard is not vacuously green)', () => {
    for (const [path, body] of contents) {
      expect(body.length, path).toBeGreaterThan(200);
    }
  });

  it.each(contents.map(([path]) => path))(
    'direction (a): %s declares every variable WORKER_ENV names',
    (path) => {
      const body = readFileSync(path, 'utf8');
      // A trailing boundary, not a bare `includes`: `APPCTL_CONCURRENCY` is a
      // PREFIX of `APPCTL_CONCURRENCY_RENAMED`, so a substring check would
      // pass over exactly the rename this direction exists to catch.
      const missing = workerEnvNames().filter((name) => !new RegExp(`${name}(?![A-Z0-9_])`).test(body));

      expect(
        missing,
        `${path} is missing ${missing.join(', ')}. A variable renamed in worker-env.ts must be ` +
          'renamed here too — nothing else would fail if it were not.',
      ).toEqual([]);
    },
  );

  it.each(contents.map(([path]) => path))(
    'direction (b): every prefixed token in %s is a member of WORKER_ENV',
    (path) => {
      const body = readFileSync(path, 'utf8');
      // Built from ENV_PREFIX, never written out.
      const pattern = new RegExp(`${ENV_PREFIX}[A-Z0-9_]+`, 'g');
      const declared = new Set(workerEnvNames());

      const strays = [...new Set(body.match(pattern) ?? [])].filter(
        (name) => !declared.has(name) && !PROSE_ONLY.has(name),
      );

      expect(
        strays,
        `${path} names ${strays.join(', ')}, which no code reads. Either declare it in ` +
          'worker-env.ts or remove it — an operator setting it would see nothing happen.',
      ).toEqual([]);
    },
  );

  it('neither file contains a product, app or repository name', () => {
    // The service key is `worker` and the image is a build-time variable, so
    // there is nothing here for a fork to rename by hand.
    for (const [path, body] of contents) {
      const lower = body.toLowerCase();
      expect(lower, path).not.toContain(APP_NAME.toLowerCase());
      expect(lower, path).not.toContain('enterpriseappbase');
    }
  });
});
