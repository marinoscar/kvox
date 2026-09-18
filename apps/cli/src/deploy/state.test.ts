import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { EXIT, exitCodeFor } from '../errors.js';
import {
  DEPLOY_STATE_FILENAME,
  DEPLOY_STATE_VERSION,
  DeployStateError,
  NotInstalledError,
  deployStatePath,
  readState,
  requireState,
  writeState,
  type DeployState,
} from './state.js';

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'appctl-state-'));
}

function sample(deployRoot: string): DeployState {
  return {
    version: DEPLOY_STATE_VERSION,
    repoUrl: 'https://github.com/example/app',
    ref: 'main',
    commitSha: 'a'.repeat(40),
    domain: 'app.example.test',
    bindPort: 3535,
    deployRoot,
    installedAt: '2026-01-01T00:00:00.000Z',
    lastDeployedAt: '2026-01-02T00:00:00.000Z',
    lastCommand: 'install',
    appctlVersion: '1.0.0',
  };
}

describe('writeState / readState', () => {
  it('round-trips every field', () => {
    const root = makeRoot();
    const state = sample(root);

    writeState(state);

    expect(readState(root)).toEqual(state);
  });

  it('round-trips the optional layout fields, at the same state version', () => {
    // #119 adds name/appsRoot/proxyRoot/proxyContainer without bumping the
    // version: a file written before them still means what it meant, and a
    // file written with them reads back whole.
    const root = makeRoot();
    const state: DeployState = {
      ...sample(root),
      name: 'demo',
      appsRoot: '/opt/infra/apps',
      proxyRoot: '/opt/infra/proxy',
      proxyContainer: 'proxy-nginx',
    };

    writeState(state);

    expect(readState(root)).toEqual(state);
    expect(readState(root)?.version).toBe(DEPLOY_STATE_VERSION);
  });

  it('round-trips envPath and lastAttemptAt, also at the same state version', () => {
    // #120 adds the canonical .env path and the failed-attempt timestamp
    // the same way: optional, and a file without them still means what it
    // meant.
    const root = makeRoot();
    const state: DeployState = {
      ...sample(root),
      envPath: join(root, '.env'),
      lastAttemptAt: '2026-01-03T00:00:00.000Z',
    };

    writeState(state);

    expect(readState(root)).toEqual(state);
    expect(readState(root)?.version).toBe(DEPLOY_STATE_VERSION);
  });

  it('round-trips an ADOPTED record: adoptedAt present, installedAt absent (#285)', () => {
    // The record `update` reconstructs when it finds a live deployment and no
    // state file. `installedAt` is optional and `adoptedAt` is new, both at
    // state version 1 - a file written before either still means what it
    // meant, exactly as #119, #120 and #267 added fields before them.
    const root = makeRoot();
    const { installedAt: _dropped, lastDeployedAt: _also, ...rest } = sample(root);
    const state: DeployState = {
      ...rest,
      lastCommand: 'update',
      adoptedAt: '2026-09-17T12:00:00.000Z',
    };

    writeState(state);

    expect(readState(root)).toEqual(state);
    expect(readState(root)?.version).toBe(DEPLOY_STATE_VERSION);
    // Nothing invented on the way through: the two instants nobody can read
    // off a disk stay absent rather than coming back as `now`.
    expect(readState(root)).not.toHaveProperty('installedAt');
    expect(readState(root)).not.toHaveProperty('lastDeployedAt');
  });

  it('leaves adoptedAt absent for a record a run of this CLI wrote', () => {
    // Absent is the ordinary case and means "this CLI installed here", which
    // is every state file already on every live server.
    const root = makeRoot();
    writeState(sample(root));

    expect(readState(root)?.adoptedAt).toBeUndefined();
  });

  it('writes the file 0600', () => {
    const root = makeRoot();
    writeState(sample(root));

    // Not a secret, but it describes the infrastructure and the repository.
    expect(statSync(deployStatePath(root)).mode & 0o777).toBe(0o600);
  });

  it('overwrites an existing state file and keeps the mode', () => {
    const root = makeRoot();
    writeState(sample(root));
    writeState({ ...sample(root), commitSha: 'b'.repeat(40), lastCommand: 'update' });

    expect(readState(root)?.commitSha).toBe('b'.repeat(40));
    expect(statSync(deployStatePath(root)).mode & 0o777).toBe(0o600);
  });

  it('leaves no temporary file behind', () => {
    const root = makeRoot();
    writeState(sample(root));

    const path = deployStatePath(root);
    expect(() => statSync(`${path}.${process.pid}.tmp`)).toThrow();
  });

  it('returns undefined when nothing is installed', () => {
    expect(readState(makeRoot())).toBeUndefined();
  });

  it('rejects a state file this build does not understand', () => {
    const root = makeRoot();
    writeFileSync(deployStatePath(root), JSON.stringify({ version: 99 }));

    // Misreading it would mean updating the wrong checkout or reporting the
    // wrong commit as deployed, so it refuses rather than guessing.
    expect(() => readState(root)).toThrow(DeployStateError);
    expect(() => readState(root)).toThrow(/state version 99/);
  });

  it('rejects an unparseable state file with a message that explains it', () => {
    const root = makeRoot();
    writeFileSync(deployStatePath(root), '{ not json');

    expect(() => readState(root)).toThrow(/not valid JSON/);
  });

  it('rejects a state file that is valid JSON but not an object', () => {
    const root = makeRoot();
    writeFileSync(deployStatePath(root), '"a string"');

    expect(() => readState(root)).toThrow(DeployStateError);
  });
});

describe('requireState', () => {
  it('returns the state when a deployment exists', () => {
    const root = makeRoot();
    writeState(sample(root));

    expect(requireState(root).ref).toBe('main');
  });

  it('names the install command and the path when nothing is there', () => {
    const root = makeRoot();
    const error = (() => {
      try {
        requireState(root);
        return undefined;
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(NotInstalledError);
    expect((error as Error).message).toContain('deploy install');
    expect((error as Error).message).toContain(root);
    expect((error as Error).message).toContain('--root');
    // A usage problem, not a broken CLI: the remedy is a different command.
    expect(exitCodeFor(error)).toBe(EXIT.USAGE);
  });
});

// =============================================================================
// The filename stays; the PROSE stops saying it  (issue #292)
// =============================================================================
//
// `DEPLOY_STATE_FILENAME` is `.appctl-deploy.json` and is NEVER going to be
// anything else - the declaration above it in `state.ts` carries the argument:
// the file is read back off live servers, so renaming it makes every existing
// deployment invisible, `deploy status` report nothing and `deploy update`
// behave as a first install.
//
// What DID need fixing is that the adoption headline showed the name to a
// person: "no .appctl-deploy.json was here", printed by a binary that has not
// been called `appctl` for some time, reads as a bug or as this CLI talking
// about a different tool. The distinction is not "is the name allowed" but
// WHERE:
//
//   - IN A PATH, YES. `deployStatePath()` builds one, `teardown.ts` prints the
//     deploy root's real entries for `--dry-run`, and `adopt.ts` now names the
//     file it wrote as a full path beside the other sources it cites. A path
//     is a thing an operator can go and `ls`; it is data.
//   - IN A SENTENCE, NO. Interpolating the bare constant into a message is the
//     shape that produced #292, and it is mechanically recognisable - which is
//     what this guard checks.
//
// It reads the sources rather than the compiled output on purpose: the thing
// being guarded is how the code is WRITTEN, and by the time it is a string at
// runtime the two uses are indistinguishable.
// =============================================================================

describe('the state filename in operator-facing prose (#292)', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const SRC = join(HERE, '..');

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sources(path);
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
      return [path];
    });
  }

  it('is interpolated into no message anywhere in the CLI', () => {
    const files = sources(SRC);
    // Non-vacuity: a guard that scanned nothing would pass forever.
    expect(files.length).toBeGreaterThan(50);

    const offenders = files.filter((path) =>
      readFileSync(path, 'utf8').includes('${DEPLOY_STATE_FILENAME}'),
    );

    expect(offenders.map((path) => path.slice(SRC.length + 1))).toEqual([]);
  });

  it('is still reachable as a path, which is the use that stays', () => {
    const root = makeRoot();
    expect(deployStatePath(root)).toBe(join(root, DEPLOY_STATE_FILENAME));
    expect(DEPLOY_STATE_FILENAME).toBe('.appctl-deploy.json');
  });
});
