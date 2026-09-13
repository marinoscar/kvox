import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXIT, exitCodeFor } from '../errors.js';
import {
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
