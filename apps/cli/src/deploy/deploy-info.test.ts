import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CLI_NAME } from '../branding.js';
import { CLI_VERSION } from '../package-info.js';
import {
  DeployInfoError,
  buildDeployInfo,
  deployInfoDir,
  ensureDeployInfoDir,
  deployInfoPath,
  isUtcTimestamp,
  readDeployInfo,
  readDeployedAppVersion,
  updateDeployInfoRemote,
  validateDeployInfo,
  writeDeployInfo,
  type DeployInfo,
} from './deploy-info.js';
import type { ServerFacts } from './server-facts.js';
import { DEPLOY_STATE_VERSION, type DeployState } from './state.js';

// =============================================================================
// One mocked call, for one test (#159)
// =============================================================================
//
// `chmodSync` is what makes this module's 0755 claim true, so the interesting
// failure is `chmodSync` refusing: a `deploy-info` the Docker daemon created
// as root:root, which a non-root `update` can neither chmod nor write into.
// That cannot be staged for real - the suite runs as whatever user CI gives it
// (the `deploy-e2e` job runs as an unprivileged one, which is how this class
// became visible at all), and a test that needed two uids would be skipped
// everywhere it mattered. So the seam is mocked, and ONLY for the paths the
// test names: every other call in this file passes straight through to the
// real implementation via `importOriginal`.
// =============================================================================

let chmodShouldFailFor: string | undefined;

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    chmodSync: (...args: Parameters<typeof actual.chmodSync>) => {
      const target = String(args[0]);
      if (chmodShouldFailFor !== undefined && target.endsWith(chmodShouldFailFor)) {
        throw Object.assign(new Error(`EPERM: operation not permitted, chmod '${target}'`), {
          code: 'EPERM',
        });
      }
      return actual.chmodSync(...args);
    },
  };
});

afterEach(() => {
  chmodShouldFailFor = undefined;
});

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'appctl-info-'));
}

function sampleState(deployRoot: string): DeployState {
  return {
    version: DEPLOY_STATE_VERSION,
    repoUrl: 'https://example.test/o/demo',
    ref: 'main',
    commitSha: 'a'.repeat(40),
    domain: 'app.example.test',
    bindPort: 3535,
    deployRoot,
    name: 'demo',
    installedAt: '2026-09-15T18:02:11.000Z',
    lastDeployedAt: '2026-09-15T18:02:11.000Z',
    lastCommand: 'install',
    appctlVersion: '1.0.0',
  };
}

const FACTS: ServerFacts = {
  hostname: 'vps-1',
  os: 'Ubuntu 24.04.1 LTS',
  kernel: '6.8.0-45-generic',
  arch: 'x64',
  cpuModel: 'AMD EPYC 7B13',
  cpus: 2,
  memoryBytes: 4096000000,
  diskBytes: 80000000000,
  dockerVersion: '27.3.1',
  composeVersion: '2.29.7',
  nodeVersion: '22.11.0',
};

const NO_FACTS: ServerFacts = {
  hostname: null,
  os: null,
  kernel: null,
  arch: null,
  cpuModel: null,
  cpus: null,
  memoryBytes: null,
  diskBytes: null,
  dockerVersion: null,
  composeVersion: null,
  nodeVersion: null,
};

/** A clone with an API package.json, as the checkout step leaves it. */
function makeClone(root: string, version = '1.2.3'): void {
  mkdirSync(join(root, 'repo', 'apps', 'api'), { recursive: true });
  writeFileSync(join(root, 'repo', 'apps', 'api', 'package.json'), JSON.stringify({ version }));
}

describe('buildDeployInfo', () => {
  it('derives the document from the state and the facts', () => {
    const root = makeRoot();
    makeClone(root);

    const info = buildDeployInfo(root, sampleState(root), FACTS);

    expect(info).toEqual({
      schema: 1,
      app: {
        name: 'demo',
        version: '1.2.3',
        commitSha: 'a'.repeat(40),
        ref: 'main',
        repoUrl: 'https://example.test/o/demo',
      },
      installedAt: '2026-09-15T18:02:11.000Z',
      updatedAt: '2026-09-15T18:02:11.000Z',
      lastCommand: 'install',
      deployedBy: { cli: CLI_NAME, version: CLI_VERSION },
      domain: 'app.example.test',
      bindPort: 3535,
      host: FACTS,
      remote: null,
      // Explicit, not absent (#283): a caller that says nothing about how its
      // run ended is one whose run finished. Absent is reserved for documents
      // written by a CLI from before the field existed.
      run: { completed: true },
    } satisfies DeployInfo);
  });

  it('records null, not a missing key, for an unpublished deployment and an unreadable version', () => {
    const root = makeRoot();
    const { domain: _domain, ...unpublished } = sampleState(root);

    const info = buildDeployInfo(root, unpublished, NO_FACTS);

    expect(info.domain).toBeNull();
    expect(info.app.version).toBeNull();
    expect(Object.values(info.host).every((value) => value === null)).toBe(true);
  });

  it('names the app after the directory for a state written before #119', () => {
    const root = makeRoot();
    const { name: _name, ...unnamed } = sampleState(root);

    expect(buildDeployInfo(root, unnamed, NO_FACTS).app.name).toBe(join(root).split('/').pop());
  });

  it('lets a caller supply the version and the remote', () => {
    const root = makeRoot();
    const remote = { sha: 'b'.repeat(40), commitsBehind: 3, checkedAt: '2026-09-16T00:00:00.000Z' };

    const info = buildDeployInfo(root, sampleState(root), NO_FACTS, { appVersion: '9.9.9', remote });

    expect(info.app.version).toBe('9.9.9');
    expect(info.remote).toEqual(remote);
  });
});

describe('writeDeployInfo / readDeployInfo', () => {
  it('round-trips through the file, with null facts serialised as null', () => {
    const root = makeRoot();

    writeDeployInfo(root, sampleState(root), NO_FACTS);

    const raw = JSON.parse(readFileSync(deployInfoPath(root), 'utf8')) as Record<string, unknown>;
    expect(raw['host']).toEqual(NO_FACTS);
    expect(raw['remote']).toBeNull();
    expect(readDeployInfo(root)).toEqual(buildDeployInfo(root, sampleState(root), NO_FACTS));
  });

  it('writes <root>/deploy-info/info.json world-readable, in a traversable directory', () => {
    // Non-secret by construction, and the api container's unprivileged user
    // reads it through the bind mount - so never the state file's 0600.
    const root = makeRoot();

    const path = writeDeployInfo(root, sampleState(root), FACTS);

    expect(path).toBe(join(root, 'deploy-info', 'info.json'));
    expect(statSync(path).mode & 0o777).toBe(0o644);
    expect(statSync(deployInfoDir(root)).mode & 0o777).toBe(0o755);
  });

  it('forces an existing 0700 deploy-info back to 0755 (issue #159)', () => {
    // `mkdirSync(…, { recursive: true, mode })` IS A NO-OP on a directory
    // that already exists, so before #159 a deploy-info left at 0700 stayed
    // 0700 and the api container's unprivileged user could not traverse it to
    // read info.json - the exact failure the mode was claimed to prevent. The
    // test above cannot catch that: it always creates the directory fresh.
    const root = makeRoot();
    const dir = deployInfoDir(root);
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o700);
    expect(statSync(dir).mode & 0o777).toBe(0o700);

    const path = writeDeployInfo(root, sampleState(root), FACTS);

    expect(statSync(dir).mode & 0o777).toBe(0o755);
    expect(statSync(path).mode & 0o777).toBe(0o644);
    expect(readDeployInfo(root)?.lastCommand).toBe('install');
  });

  it('ignores the operator umask for the directory and the file alike', () => {
    // `mode:` on mkdirSync and writeFileSync is umask-masked, so an operator
    // running with `umask 077` got 0700/0600 out of a FRESH write too.
    // `chmodSync` is not masked, which is why it is what makes both claims
    // true. Hermetic: vitest runs each file in its own process, and the umask
    // is restored either way.
    const root = makeRoot();
    const previous = process.umask(0o077);
    try {
      const path = writeDeployInfo(root, sampleState(root), FACTS);

      expect(statSync(deployInfoDir(root)).mode & 0o777).toBe(0o755);
      expect(statSync(path).mode & 0o777).toBe(0o644);
    } finally {
      process.umask(previous);
    }
  });

  it('keeps the mode on rewrite and leaves no temporary file behind', () => {
    const root = makeRoot();
    writeDeployInfo(root, sampleState(root), FACTS);
    chmodSync(deployInfoPath(root), 0o600);

    writeDeployInfo(root, { ...sampleState(root), lastCommand: 'update' }, FACTS);

    expect(statSync(deployInfoPath(root)).mode & 0o777).toBe(0o644);
    expect(readdirSync(deployInfoDir(root))).toEqual(['info.json']);
    expect(readDeployInfo(root)?.lastCommand).toBe('update');
  });

  it('writes only UTC Z timestamps', () => {
    const root = makeRoot();
    writeDeployInfo(root, sampleState(root), FACTS);

    const info = readDeployInfo(root) as DeployInfo;
    expect(isUtcTimestamp(info.installedAt)).toBe(true);
    expect(isUtcTimestamp(info.updatedAt)).toBe(true);
  });

  it('refuses to write a state whose timestamps are not UTC', () => {
    // A local-time format would render differently in every reader; the
    // validator runs on the way out so it cannot reach the API.
    const root = makeRoot();

    expect(() =>
      writeDeployInfo(root, { ...sampleState(root), lastDeployedAt: '2026-09-15 18:02:11' }, FACTS),
    ).toThrow(DeployInfoError);
  });

  it('returns undefined when there is no file', () => {
    expect(readDeployInfo(makeRoot())).toBeUndefined();
  });

  it('patches only remote, keeping everything the last deploy wrote (update --check, status)', () => {
    const root = makeRoot();
    makeClone(root, '1.2.3');
    writeDeployInfo(root, sampleState(root), FACTS);
    // The clone moves on after the deploy; a check must not re-read it.
    makeClone(root, '9.9.9');
    const remote = { sha: 'b'.repeat(40), commitsBehind: 3, checkedAt: '2026-09-16T00:00:00.000Z' };

    const path = updateDeployInfoRemote(root, remote);

    expect(path).toBe(deployInfoPath(root));
    expect(readDeployInfo(root)).toEqual({
      ...buildDeployInfo(root, sampleState(root), FACTS, { appVersion: '1.2.3' }),
      remote,
    });
    expect(statSync(path as string).mode & 0o777).toBe(0o644);
    expect(readdirSync(deployInfoDir(root))).toEqual(['info.json']);
  });

  it('patches nothing, and invents nothing, when there is no file yet', () => {
    const root = makeRoot();

    const path = updateDeployInfoRemote(root, { sha: 'b'.repeat(40), commitsBehind: 0, checkedAt: '2026-09-16T00:00:00.000Z' });

    expect(path).toBeUndefined();
    expect(readDeployInfo(root)).toBeUndefined();
  });

  it('rejects a file that is not JSON, or not this schema', () => {
    const root = makeRoot();
    mkdirSync(deployInfoDir(root));

    writeFileSync(deployInfoPath(root), '{ not json');
    expect(() => readDeployInfo(root)).toThrow(/not valid JSON/);

    writeFileSync(deployInfoPath(root), JSON.stringify({ schema: 2 }));
    expect(() => readDeployInfo(root)).toThrow(/schema 2, expected 1/);
  });
});

describe('ensureDeployInfoDir', () => {
  it('creates the directory 0755 and returns it', () => {
    const root = makeRoot();

    const dir = ensureDeployInfoDir(root);

    expect(dir).toBe(deployInfoDir(root));
    expect(statSync(dir).mode & 0o777).toBe(0o755);
  });

  it('is idempotent, and repairs a directory somebody else left at 0700', () => {
    const root = makeRoot();
    ensureDeployInfoDir(root);
    chmodSync(deployInfoDir(root), 0o700);

    ensureDeployInfoDir(root);

    expect(statSync(deployInfoDir(root)).mode & 0o777).toBe(0o755);
  });

  it('refuses a directory it cannot fix, naming the chown to paste (issue #159)', () => {
    // The root:root deploy-info the Docker daemon leaves behind when it
    // creates a missing bind source. The CLI does not take ownership of it
    // silently; it says whose it has to be and stops.
    const root = makeRoot();
    mkdirSync(deployInfoDir(root), { recursive: true });
    chmodShouldFailFor = join('deploy-info');

    const error = (() => {
      try {
        ensureDeployInfoDir(root);
        return undefined;
      } catch (caught: unknown) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(DeployInfoError);
    const message = (error as Error).message;
    const { uid, gid } = userInfo();
    expect(message).toContain(`Cannot prepare ${deployInfoDir(root)}`);
    expect(message).toContain(`sudo chown -R ${uid}:${gid} ${deployInfoDir(root)}`);
    expect(message).toContain(`sudo chmod 755 ${deployInfoDir(root)}`);
    // Not the raw EACCES on the temp file that #159 is about, and nothing
    // half-written: the refusal happens before any document is produced.
    expect(message).not.toContain('.tmp');
    expect(readdirSync(deployInfoDir(root))).toEqual([]);
  });

  it('is the gate writeDeployInfo goes through, so a write refuses the same way', () => {
    const root = makeRoot();
    mkdirSync(deployInfoDir(root), { recursive: true });
    chmodShouldFailFor = join('deploy-info');

    expect(() => writeDeployInfo(root, sampleState(root), FACTS)).toThrow(
      /sudo chown -R \d+:\d+ .*deploy-info/,
    );
    expect(readdirSync(deployInfoDir(root))).toEqual([]);
  });
});

describe('validateDeployInfo', () => {
  const valid = (): DeployInfo => buildDeployInfo('/x', sampleState('/x'), FACTS, { appVersion: null });

  it('accepts what buildDeployInfo produces and returns it unchanged', () => {
    const info = valid();
    expect(validateDeployInfo(JSON.parse(JSON.stringify(info)))).toEqual(info);
  });

  // ---------------------------------------------------------------------------
  // An unknown install time is written as null, never guessed (issue #285)
  // ---------------------------------------------------------------------------

  it('writes null timestamps for an adopted deployment rather than inventing them', () => {
    const { installedAt: _one, lastDeployedAt: _two, ...adopted } = sampleState('/x');
    const info = buildDeployInfo(
      '/x',
      { ...adopted, adoptedAt: '2026-09-17T12:00:00.000Z' } as DeployState,
      FACTS,
      { appVersion: null },
    );

    // The clone, the .env and the proxy say what is deployed; none of them
    // says when it was installed. Null is the honest answer, and the API has
    // read both of these as optional-and-nullable since #124.
    expect(info.installedAt).toBeNull();
    expect(info.updatedAt).toBeNull();
    expect(info.adoptedAt).toBe('2026-09-17T12:00:00.000Z');
    expect(validateDeployInfo(JSON.parse(JSON.stringify(info)))).toEqual(info);
  });

  it('still falls back to installedAt for updatedAt when only that is known', () => {
    const { lastDeployedAt: _dropped, ...state } = sampleState('/x');
    const info = buildDeployInfo('/x', state as DeployState, FACTS, { appVersion: null });

    expect(info.updatedAt).toBe('2026-09-15T18:02:11.000Z');
  });

  it('leaves adoptedAt off a document a run of this CLI wrote', () => {
    // Absent means the record came from a real run - every document written
    // before #285, and every ordinary one after it.
    expect(valid()).not.toHaveProperty('adoptedAt');
    expect(validateDeployInfo({ ...valid(), adoptedAt: undefined })).toBeDefined();
  });

  it('still refuses a timestamp that is neither null nor a UTC instant', () => {
    expect(() => validateDeployInfo({ ...valid(), installedAt: '2026-09-15 18:02:11' })).toThrow(
      /installedAt is not a UTC timestamp or null/,
    );
    expect(() => validateDeployInfo({ ...valid(), adoptedAt: 'yesterday' })).toThrow(
      /adoptedAt is not a UTC timestamp/,
    );
  });

  it('accepts a remote once update --check has filled it', () => {
    const info = {
      ...valid(),
      remote: { sha: 'b'.repeat(40), commitsBehind: 0, checkedAt: '2026-09-16T00:00:00Z' },
    };
    expect(validateDeployInfo(info)).toEqual(info);
  });

  // ---------------------------------------------------------------------------
  // `run`, and both directions of compatibility (issue #283)
  // ---------------------------------------------------------------------------

  it('defaults to a completed run, so every writer says so explicitly', () => {
    expect(valid().run).toEqual({ completed: true });
  });

  it('accepts an incomplete run naming the step that stopped it', () => {
    const info = buildDeployInfo('/x', sampleState('/x'), FACTS, {
      appVersion: null,
      run: { completed: false, failedStep: 'publish', attemptedAt: '2026-09-17T09:00:00.000Z' },
    });
    expect(validateDeployInfo(JSON.parse(JSON.stringify(info)))).toEqual(info);
  });

  it('accepts a document with NO run at all: one written before #283', () => {
    // The compatibility that matters most. `schema` deliberately stayed at 1,
    // so this CLI must keep reading - and `update --check` must keep patching
    // - every info.json already sitting on every live server. A required
    // field here would make `updateDeployInfoRemote` throw on all of them.
    const { run: _run, ...older } = valid();
    expect(_run).toBeDefined();
    expect(() => validateDeployInfo(older)).not.toThrow();
    expect(validateDeployInfo(older).run).toBeUndefined();
  });

  it.each([
    ['not an object', 'a string'],
    ['run', { ...valid(), run: { completed: 'no' } }],
    ['run.failedStep', { ...valid(), run: { completed: false, failedStep: 7 } }],
    ['run.attemptedAt', { ...valid(), run: { completed: false, attemptedAt: 'yesterday' } }],
    ['schema', { ...valid(), schema: 0 }],
    ['app.commitSha', { ...valid(), app: { ...valid().app, commitSha: 42 } }],
    ['app.version', { ...valid(), app: { ...valid().app, version: 1 } }],
    ['installedAt', { ...valid(), installedAt: '2026-09-15T18:02:11+02:00' }],
    ['updatedAt', { ...valid(), updatedAt: 'yesterday' }],
    ['lastCommand', { ...valid(), lastCommand: 'rollback' }],
    ['deployedBy', { ...valid(), deployedBy: { cli: CLI_NAME } }],
    ['domain', { ...valid(), domain: 42 }],
    ['bindPort', { ...valid(), bindPort: '3535' }],
    ['host.cpus', { ...valid(), host: { ...FACTS, cpus: '2' } }],
    ['host.os', { ...valid(), host: { ...FACTS, os: 24 } }],
    ['remote', { ...valid(), remote: { sha: 'b' } }],
  ])('names %s when it is wrong', (field, document) => {
    expect(() => validateDeployInfo(document)).toThrow(DeployInfoError);
    expect(() => validateDeployInfo(document)).toThrow(new RegExp(field.replace('.', '\\.')));
  });
});

describe('isUtcTimestamp', () => {
  it('accepts only ISO-8601 instants with a Z suffix', () => {
    expect(isUtcTimestamp(new Date().toISOString())).toBe(true);
    expect(isUtcTimestamp('2026-09-15T18:02:11Z')).toBe(true);
    expect(isUtcTimestamp('2026-09-15T18:02:11+00:00')).toBe(false);
    expect(isUtcTimestamp('2026-09-15 18:02:11')).toBe(false);
    expect(isUtcTimestamp('2026-13-45T18:02:11Z')).toBe(false);
    expect(isUtcTimestamp(1758000000)).toBe(false);
  });
});

describe('readDeployedAppVersion', () => {
  it('reads apps/api/package.json in the clone', () => {
    const root = makeRoot();
    makeClone(root, '4.5.6');
    expect(readDeployedAppVersion(root)).toBe('4.5.6');
  });

  it('answers null rather than throwing for a missing or malformed file', () => {
    const root = makeRoot();
    expect(readDeployedAppVersion(root)).toBeNull();

    mkdirSync(join(root, 'repo', 'apps', 'api'), { recursive: true });
    writeFileSync(join(root, 'repo', 'apps', 'api', 'package.json'), '{ nope');
    expect(readDeployedAppVersion(root)).toBeNull();

    writeFileSync(join(root, 'repo', 'apps', 'api', 'package.json'), JSON.stringify({ name: 'api' }));
    expect(readDeployedAppVersion(root)).toBeNull();
  });
});
