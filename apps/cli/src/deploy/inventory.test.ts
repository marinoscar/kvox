import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { collectInventory, renderInventory } from './inventory.js';
import { DEPLOY_STATE_VERSION, writeState, type DeployState } from './state.js';

// =============================================================================
// `deploy list`: the inventory the apps root already is  (issue #290)
// =============================================================================

function appsRoot(): string {
  return mkdtempSync(join(tmpdir(), 'appctl-inventory-'));
}

function install(root: string, dir: string, overrides: Partial<DeployState> = {}): string {
  const deployRoot = join(root, dir);
  writeState({
    version: DEPLOY_STATE_VERSION,
    repoUrl: 'https://example.test/o/r',
    ref: 'main',
    commitSha: 'abcdef0123456789abcdef0123456789abcdef01',
    bindPort: 3535,
    deployRoot,
    installedAt: '2026-01-01T00:00:00.000Z',
    lastDeployedAt: '2026-01-02T03:04:05.000Z',
    lastCommand: 'install',
    appctlVersion: '1.0.0',
    name: dir,
    appsRoot: root,
    ...overrides,
  });
  return deployRoot;
}

/** A deployment with no state file, as a server whose bookkeeping was lost has. */
function unrecorded(root: string, dir: string, env: Record<string, string> = {}): string {
  const deployRoot = join(root, dir);
  mkdirSync(join(deployRoot, 'repo', '.git'), { recursive: true });
  writeFileSync(
    join(deployRoot, '.env'),
    `${Object.entries({ DEPLOY_ROOT: deployRoot, APP_BIND_PORT: '3536', ...env })
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}\n`,
    { mode: 0o600 },
  );
  return deployRoot;
}

describe('collectInventory', () => {
  it('is empty for an apps root that holds nothing, and says which root', () => {
    const missing = join(appsRoot(), 'missing');

    expect(collectInventory(missing)).toEqual({ appsRoot: missing, apps: [] });
  });

  it('reports a recorded deployment from its own state file', () => {
    const root = appsRoot();
    const deployRoot = install(root, 'alpha', { domain: 'alpha.example.test' });

    expect(collectInventory(root).apps).toEqual([
      {
        name: 'alpha',
        deployRoot,
        record: 'state',
        commitSha: 'abcdef0123456789abcdef0123456789abcdef01',
        ref: 'main',
        bindPort: 3535,
        domain: 'alpha.example.test',
        lastDeployedAt: '2026-01-02T03:04:05.000Z',
      },
    ]);
  });

  it('reports an unrecorded deployment from its .env, with no revision and no git', () => {
    // The commit is in repo/'s history and reading it would mean a git
    // process per directory; `deploy update` adopts and records it instead.
    const root = appsRoot();
    const deployRoot = unrecorded(root, 'orphan', {
      COMPOSE_PROJECT_NAME: 'orphan',
      APP_URL: 'https://orphan.example.test',
    });

    expect(collectInventory(root).apps).toEqual([
      {
        name: 'orphan',
        deployRoot,
        record: 'evidence',
        commitSha: null,
        ref: null,
        bindPort: 3536,
        domain: 'orphan.example.test',
        lastDeployedAt: null,
      },
    ]);
  });

  it('does not report a loopback APP_URL as a published domain', () => {
    const root = appsRoot();
    unrecorded(root, 'local', { APP_URL: 'http://localhost:3535' });

    expect(collectInventory(root).apps[0]?.domain).toBeNull();
  });

  it('leaves out an application this CLI did not deploy', () => {
    const root = appsRoot();
    install(root, 'alpha');
    const stranger = join(root, 'vault');
    mkdirSync(join(stranger, 'repo', '.git'), { recursive: true });
    writeFileSync(join(stranger, '.env'), 'APP_BIND_PORT=8080\n');

    expect(collectInventory(root).apps.map((app) => app.name)).toEqual(['alpha']);
  });
});

describe('renderInventory', () => {
  const now = Date.parse('2026-01-03T03:04:05.000Z');

  it('renders one block per app, naming what each row was read from', () => {
    const root = appsRoot();
    install(root, 'alpha', { domain: 'alpha.example.test' });
    unrecorded(root, 'orphan');

    const text = renderInventory(collectInventory(root), { now });

    expect(text).toContain(`Apps under ${root}`);
    expect(text).toContain('abcdef012345 (main)');
    expect(text).toContain('alpha.example.test');
    expect(text).toContain('2026-01-02 03:04:05 UTC (1 day ago)');
    expect(text).toContain('.appctl-deploy.json');
    expect(text).toContain('inferred from repo/ and .env (no state file)');
    expect(text).toContain('not published');
    expect(text).toContain('2 app(s).');
  });

  it('names the folder when the app name does not spell it', () => {
    // `--name <app>-staging` installs into a directory the project name does
    // not spell, and a listing whose rows cannot be found on disk is worse
    // than one extra column.
    const root = appsRoot();
    install(root, 'staging', { name: 'demo-staging' });

    expect(renderInventory(collectInventory(root), { now })).toContain('demo-staging  (in staging/)');
  });

  it('says a record is missing rather than inventing a revision', () => {
    const root = appsRoot();
    unrecorded(root, 'orphan');

    const text = renderInventory(collectInventory(root), { now });

    expect(text).toContain('unknown (no record here; `deploy update` rebuilds one)');
    expect(text).toContain('Last deploy   unknown');
  });
});
