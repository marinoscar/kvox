import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CLI_NAME } from '../branding.js';
import { CLI_VERSION } from '../package-info.js';
import {
  DeployInfoError,
  buildDeployInfo,
  deployInfoDir,
  deployInfoPath,
  isUtcTimestamp,
  readDeployInfo,
  readDeployedAppVersion,
  validateDeployInfo,
  writeDeployInfo,
  type DeployInfo,
} from './deploy-info.js';
import type { ServerFacts } from './server-facts.js';
import { DEPLOY_STATE_VERSION, type DeployState } from './state.js';

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

  it('rejects a file that is not JSON, or not this schema', () => {
    const root = makeRoot();
    mkdirSync(deployInfoDir(root));

    writeFileSync(deployInfoPath(root), '{ not json');
    expect(() => readDeployInfo(root)).toThrow(/not valid JSON/);

    writeFileSync(deployInfoPath(root), JSON.stringify({ schema: 2 }));
    expect(() => readDeployInfo(root)).toThrow(/schema 2, expected 1/);
  });
});

describe('validateDeployInfo', () => {
  const valid = (): DeployInfo => buildDeployInfo('/x', sampleState('/x'), FACTS, { appVersion: null });

  it('accepts what buildDeployInfo produces and returns it unchanged', () => {
    const info = valid();
    expect(validateDeployInfo(JSON.parse(JSON.stringify(info)))).toEqual(info);
  });

  it('accepts a remote once update --check has filled it', () => {
    const info = {
      ...valid(),
      remote: { sha: 'b'.repeat(40), commitsBehind: 0, checkedAt: '2026-09-16T00:00:00Z' },
    };
    expect(validateDeployInfo(info)).toEqual(info);
  });

  it.each([
    ['not an object', 'a string'],
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
