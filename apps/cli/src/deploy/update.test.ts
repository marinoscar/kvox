import { lstatSync, mkdtempSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readDeployInfo } from './deploy-info.js';
import { composeEnvPath, envFilePath, writeEnvFile } from './env-file.js';
import { DEPLOY_STATE_VERSION, NotInstalledError, readState, writeState, type DeployState } from './state.js';
import { FAKE_APP_VERSION, fakeVps, healthyFetch, populateClone, type FakeVps } from './testing/fake-vps.js';
import { buildUpdateSteps, runUpdate } from './update.js';

describe('the update pipeline', () => {
  const steps = buildUpdateSteps();
  const ids = steps.map((step) => step.id);

  it('looks for a new revision before it changes anything', () => {
    expect(ids).toEqual([
      'preflight',
      'fetch',
      'environment-drift',
      'build',
      'migrate',
      'seed',
      'restart',
      'health',
      'publish',
      'verify',
    ]);
  });

  function skipReason(id: string, context: Record<string, unknown>): string | undefined {
    return steps.find((step) => step.id === id)?.skip?.(context as never);
  }

  it('stands every later step down when the revision has not moved', () => {
    // Several minutes of build and a restart for a no-op is exactly the
    // friction that stops people updating often.
    for (const id of ['build', 'migrate', 'seed', 'restart', 'health', 'publish', 'verify']) {
      expect(skipReason(id, { unchanged: true, options: {}, state: {} })).toBe(
        'already up to date',
      );
    }
  });

  it('still runs the fetch step when unchanged, since that is what decides', () => {
    expect(skipReason('fetch', { unchanged: true, options: {}, state: {} })).toBeUndefined();
  });

  it('re-seeds by default', () => {
    // The only way permissions added by a new release reach an existing
    // deployment; without it the feature ships and the permission does not.
    expect(skipReason('seed', { options: {}, state: {} })).toBeUndefined();
  });

  it('honours --skip-seed', () => {
    expect(skipReason('seed', { options: { skipSeed: true }, state: {} })).toContain(
      '--skip-seed',
    );
  });

  it('skips publishing for a deployment that was never published', () => {
    expect(skipReason('publish', { options: {}, state: {} })).toContain('not published');
  });

  it('honours --skip-proxy', () => {
    expect(
      skipReason('publish', { options: { skipProxy: true }, state: { domain: 'x' } }),
    ).toContain('--skip-proxy');
  });
});

describe('runUpdate preconditions', () => {
  it('refuses to run when nothing is installed, naming install', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'appctl-noinstall-'));

    const error = await runUpdate({ deployRoot: empty }).catch((caught: unknown) => caught);

    // The precondition install does not have, and the reason this is its own
    // command rather than a flag: the guards are opposite.
    expect(error).toBeInstanceOf(NotInstalledError);
    expect((error as Error).message).toContain('deploy install');
  });
});

// =============================================================================
// The pipeline end to end, against a fake VPS  (issue #120)
// =============================================================================

const INSTALLED_SHA = 'a'.repeat(40);
const NEW_SHA = 'b'.repeat(40);
const INSTALLED_AT = '2026-01-01T00:00:00.000Z';
const DEPLOYED_AT = '2026-01-02T00:00:00.000Z';

/** The .env an install would have written for FAKE_ENV_EXAMPLE. */
function installedEnv(vps: FakeVps, name: string): string {
  return [
    ...[...vps.answers().entries()].map(([key, value]) => `${key}=${value}`),
    'POSTGRES_SSL=false',
    'APP_BIND_PORT=3535',
    `COMPOSE_PROJECT_NAME=${name}`,
    '',
  ].join('\n');
}

/** An installed app: state, clone at the installed SHA, and its .env. */
function installedApp(vps: FakeVps, layout: 'current' | 'pre-120' = 'current'): string {
  const root = mkdtempSync(join(tmpdir(), 'appctl-update-'));
  populateClone(join(root, 'repo'));

  const state: DeployState = {
    version: DEPLOY_STATE_VERSION,
    repoUrl: 'https://example.test/o/demo',
    ref: 'main',
    commitSha: INSTALLED_SHA,
    bindPort: 3535,
    deployRoot: root,
    name: 'demo',
    installedAt: INSTALLED_AT,
    lastDeployedAt: DEPLOYED_AT,
    lastCommand: 'install',
    appctlVersion: '1.0.0',
  };
  writeState(state);

  if (layout === 'current') {
    writeEnvFile(root, installedEnv(vps, 'demo'));
  } else {
    // An install from before #120: a regular file inside the clone, no link.
    writeFileSync(composeEnvPath(root), installedEnv(vps, 'demo'), { mode: 0o600 });
  }
  return root;
}

describe('runUpdate against a fake VPS', () => {
  let vps: FakeVps;

  beforeEach(async () => {
    vps = await fakeVps({ head: INSTALLED_SHA, remoteSha: NEW_SHA });
    vi.stubGlobal('fetch', healthyFetch());
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await vps.close();
  });

  function update(root: string, hooks?: { onProgress?: (message: string) => void }) {
    return runUpdate({
      deployRoot: root,
      runCommand: vps.runCommand,
      nonInteractive: true,
      skipProxy: true,
      skipSeed: true,
      cwd: root,
      ...(hooks === undefined ? {} : { hooks }),
    });
  }

  it('leaves lastDeployedAt alone when the pipeline fails, and records the attempt', async () => {
    const root = installedApp(vps);
    vps.failWhen((argv) => argv[1] === 'compose' && argv.includes('build'), 'build exploded');

    const error = await update(root).catch((caught: unknown) => caught);

    expect((error as Error).message).toContain('build exploded');
    const state = readState(root) as DeployState;
    // The bug this fixes: a deploy time was stamped at fetch, before anything
    // had been applied, so a failed update claimed a deploy that never was.
    expect(state.lastDeployedAt).toBe(DEPLOYED_AT);
    expect(state.installedAt).toBe(INSTALLED_AT);
    expect(state.commitSha).toBe(INSTALLED_SHA);
    expect(state.previousSha).toBe(INSTALLED_SHA);
    expect(state.lastAttemptAt).toBeDefined();
    expect(state.lastAttemptAt as string > DEPLOYED_AT).toBe(true);
    // And nothing claims otherwise to the application either.
    expect(readDeployInfo(root)).toBeUndefined();
  });

  it('stamps lastDeployedAt only on success, never touching installedAt', async () => {
    const root = installedApp(vps);
    const before = Date.now();

    const result = await update(root);

    expect(result.changed).toBe(true);
    expect(result.previousSha).toBe(INSTALLED_SHA);
    expect(result.commitSha).toBe(NEW_SHA);

    const state = readState(root) as DeployState;
    expect(state.installedAt).toBe(INSTALLED_AT);
    expect(Date.parse(state.lastDeployedAt)).toBeGreaterThanOrEqual(before);
    expect(state.lastAttemptAt).toBe(state.lastDeployedAt);
    expect(state.commitSha).toBe(NEW_SHA);
    expect(state.previousSha).toBe(INSTALLED_SHA);
    expect(state.lastCommand).toBe('update');
    expect(state.envPath).toBe(envFilePath(root));
  });

  it('writes deploy-info after a successful update, keeping installedAt', async () => {
    const root = installedApp(vps);

    await update(root);

    const state = readState(root) as DeployState;
    const info = readDeployInfo(root);
    expect(info).toMatchObject({
      schema: 1,
      app: { name: 'demo', version: FAKE_APP_VERSION, commitSha: NEW_SHA, ref: 'main' },
      installedAt: INSTALLED_AT,
      updatedAt: state.lastDeployedAt,
      lastCommand: 'update',
      domain: null,
      bindPort: 3535,
      host: { dockerVersion: '27.3.1', composeVersion: '2.29.7', diskBytes: 78125000 * 1024 },
      remote: null,
    });
    expect(info?.updatedAt.endsWith('Z')).toBe(true);
  });

  it('refreshes deploy-info from the unchanged state when there is nothing to deploy', async () => {
    vps.remoteSha = INSTALLED_SHA;
    const root = installedApp(vps);

    const result = await update(root);

    expect(result.changed).toBe(false);
    expect(readState(root)).toMatchObject({
      commitSha: INSTALLED_SHA,
      lastDeployedAt: DEPLOYED_AT,
      lastCommand: 'install',
    });
    expect(readState(root)?.lastAttemptAt).toBeUndefined();
    expect(readDeployInfo(root)).toMatchObject({
      installedAt: INSTALLED_AT,
      updatedAt: DEPLOYED_AT,
      lastCommand: 'install',
    });
  });

  it('migrates a pre-#120 .env to the app root and pins DEPLOY_ROOT', async () => {
    const root = installedApp(vps, 'pre-120');
    const progress: string[] = [];

    await update(root, { onProgress: (message) => void progress.push(message) });

    expect(statSync(envFilePath(root)).mode & 0o777).toBe(0o600);
    expect(lstatSync(composeEnvPath(root)).isSymbolicLink()).toBe(true);
    expect(readlinkSync(composeEnvPath(root))).toBe('../../../.env');
    expect(readFileSync(envFilePath(root), 'utf8')).toContain(`DEPLOY_ROOT=${root}`);
    expect(readFileSync(envFilePath(root), 'utf8')).toContain('COMPOSE_PROJECT_NAME=demo');
    expect(progress.some((message) => message.includes('Moved .env'))).toBe(true);
  });
});
