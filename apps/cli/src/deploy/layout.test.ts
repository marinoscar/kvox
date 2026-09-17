import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXIT, UsageError, exitCodeFor } from '../errors.js';
import {
  DEFAULT_APPS_ROOT,
  FALLBACK_APP_NAME,
  appNameFor,
  appRootFor,
  listInstalledApps,
  locateApp,
  locateAppFromCwd,
  locateInstalledApp,
  projectNameFor,
  siblingBindPorts,
} from './layout.js';
import {
  DEPLOY_STATE_VERSION,
  NotInstalledError,
  deployStatePath,
  writeState,
  type DeployState,
} from './state.js';

function appsRoot(): string {
  return mkdtempSync(join(tmpdir(), 'appctl-apps-'));
}

function install(root: string, name: string, overrides: Partial<DeployState> = {}): string {
  const deployRoot = join(root, name);
  writeState({
    version: DEPLOY_STATE_VERSION,
    repoUrl: 'https://example.test/o/r',
    ref: 'main',
    commitSha: 'a'.repeat(40),
    bindPort: 3535,
    deployRoot,
    installedAt: '2026-01-01T00:00:00.000Z',
    lastDeployedAt: '2026-01-01T00:00:00.000Z',
    lastCommand: 'install',
    appctlVersion: '1.0.0',
    name,
    appsRoot: root,
    ...overrides,
  });
  return deployRoot;
}

describe('appNameFor', () => {
  it.each([
    ['https://example.test/o/MyApp.git', 'myapp'],
    ['https://example.test/o/MyApp', 'myapp'],
    ['git@example.test:o/my-app.git', 'my-app'],
    ['https://example.test/o/trailing/', 'trailing'],
  ])('slugs %s to %s', (url, expected) => {
    expect(appNameFor(url)).toBe(expected);
  });

  it('falls back to "app" rather than an empty directory name', () => {
    expect(appNameFor('')).toBe('app');
  });

  it('falls back to the exported FALLBACK_APP_NAME specifically (issue #232)', () => {
    // Pinned as its own case, against the export rather than the literal:
    // the TUI recognises this exact value to tell "an app called app" apart
    // from "the CLI does not yet know what it is deploying" (install.tsx's
    // `welcomeIntro`), so the constant and this fallback must never drift
    // apart from each other.
    expect(appNameFor('')).toBe(FALLBACK_APP_NAME);
    expect(appNameFor('   ')).toBe(FALLBACK_APP_NAME);
  });
});

describe('appRootFor', () => {
  it('is <apps-root>/<name>', () => {
    expect(appRootFor(DEFAULT_APPS_ROOT, 'kvox')).toBe('/opt/infra/apps/kvox');
  });
});

describe('projectNameFor', () => {
  it('prefers the recorded name', () => {
    expect(projectNameFor({ name: 'recorded' }, '/opt/infra/apps/dir')).toBe('recorded');
  });

  it('falls back to the directory name for a state written before #119', () => {
    expect(projectNameFor({}, '/opt/infra/apps/dir')).toBe('dir');
    expect(projectNameFor(undefined, '/opt/infra/apps/dir')).toBe('dir');
  });
});

describe('listInstalledApps', () => {
  it('is empty when the apps root does not exist yet', () => {
    expect(listInstalledApps(join(appsRoot(), 'missing'))).toEqual([]);
  });

  it('lists only the subdirectories that hold a state file', () => {
    const root = appsRoot();
    install(root, 'alpha');
    install(root, 'beta');
    mkdirSync(join(root, 'not-an-app'));
    writeFileSync(join(root, 'stray-file'), '');

    expect(listInstalledApps(root).map((app) => app.name)).toEqual(['alpha', 'beta']);
  });

  it('skips an unreadable neighbour rather than refusing to list at all', () => {
    const root = appsRoot();
    install(root, 'good');
    mkdirSync(join(root, 'broken'));
    writeFileSync(deployStatePath(join(root, 'broken')), '{ not json');

    expect(listInstalledApps(root).map((app) => app.name)).toEqual(['good']);
  });
});

describe('siblingBindPorts (issue #127)', () => {
  it('reports every other app\'s recorded port with its name, stopped or not', () => {
    // From the state files, never a bind probe: a stopped app holds its port
    // just as firmly once it is started again.
    const root = appsRoot();
    install(root, 'alpha', { bindPort: 3535 });
    install(root, 'beta', { bindPort: 3536 });

    expect(siblingBindPorts(root)).toEqual([
      { name: 'alpha', port: 3535 },
      { name: 'beta', port: 3536 },
    ]);
  });

  it('leaves out the app being installed, so a reinstall does not see its own port as taken', () => {
    const root = appsRoot();
    const own = install(root, 'alpha', { bindPort: 3535 });
    install(root, 'beta', { bindPort: 3536 });

    expect(siblingBindPorts(root, own)).toEqual([{ name: 'beta', port: 3536 }]);
  });

  it('is empty before anything is installed', () => {
    expect(siblingBindPorts(join(appsRoot(), 'missing'))).toEqual([]);
  });
});

describe('locateApp', () => {
  it('uses --root verbatim, naming the project from its state', () => {
    const root = appsRoot();
    const deployRoot = install(root, 'dirname', { name: 'recorded' });

    expect(locateApp({ appsRoot: '/elsewhere', root: deployRoot })).toEqual({
      name: 'recorded',
      appsRoot: '/elsewhere',
      deployRoot,
    });
  });

  it('uses --root with --name when both are given', () => {
    expect(locateApp({ appsRoot: '/a', root: '/x/y', name: 'n' })).toEqual({
      name: 'n',
      appsRoot: '/a',
      deployRoot: '/x/y',
    });
  });

  it('names the directory after --root when nothing is installed there', () => {
    expect(locateApp({ appsRoot: '/a', root: '/x/dir' })?.name).toBe('dir');
  });

  it('resolves --name under the apps root without needing an install', () => {
    expect(locateApp({ appsRoot: '/opt/infra/apps', name: 'kvox' })).toEqual({
      name: 'kvox',
      appsRoot: '/opt/infra/apps',
      deployRoot: '/opt/infra/apps/kvox',
    });
  });

  it('finds the one installed app when nothing is named', () => {
    const root = appsRoot();
    const deployRoot = install(root, 'only');

    expect(locateApp({ appsRoot: root })).toEqual({ name: 'only', appsRoot: root, deployRoot });
  });

  it('returns undefined when nothing is named and nothing is installed', () => {
    expect(locateApp({ appsRoot: appsRoot() })).toBeUndefined();
  });

  it('refuses to guess between several installed apps, naming them', () => {
    const root = appsRoot();
    install(root, 'alpha');
    install(root, 'beta');

    const error = (() => {
      try {
        locateApp({ appsRoot: root });
        return undefined;
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain('alpha');
    expect((error as Error).message).toContain('beta');
    expect((error as Error).message).toContain('--name');
  });
});

// =============================================================================
// Issue #266: the deployment the current directory is standing in.
//
// The reported failure is an operator in `/opt/infra/apps/kvox` - a deploy
// root with a state file - being told to name the repository with --repo.
// These cases pin the rank that answers instead, and the bound that keeps it
// from answering about directories it has no business interpreting.
// =============================================================================
describe('locateAppFromCwd (issue #266)', () => {
  it('answers the deployment when cwd IS the deploy root', () => {
    const root = appsRoot();
    const deployRoot = install(root, 'kvox');

    const found = locateAppFromCwd({ appsRoot: root, cwd: deployRoot });

    expect(found?.layout).toEqual({ name: 'kvox', appsRoot: root, deployRoot });
    // The caller reads the repository off this, rather than off a git remote.
    expect(found?.state.repoUrl).toBe('https://example.test/o/r');
  });

  it('answers the same deployment from a subdirectory of it', () => {
    const root = appsRoot();
    const deployRoot = install(root, 'kvox');
    const inside = join(deployRoot, 'repo', 'infra', 'compose');
    mkdirSync(inside, { recursive: true });

    expect(locateAppFromCwd({ appsRoot: root, cwd: inside })?.layout.deployRoot).toBe(deployRoot);
  });

  it('stops at the apps root: standing there resolves nothing', () => {
    const root = appsRoot();
    install(root, 'kvox');

    expect(locateAppFromCwd({ appsRoot: root, cwd: root })).toBeUndefined();
  });

  it('stops at the apps root: standing ABOVE it resolves nothing', () => {
    // The reported shape - /opt/infra containing /opt/infra/apps - where an
    // unbounded walk would keep climbing into the operator's own territory.
    const parent = mkdtempSync(join(tmpdir(), 'appctl-infra-'));
    const root = join(parent, 'apps');
    mkdirSync(root, { recursive: true });
    install(root, 'kvox');

    expect(locateAppFromCwd({ appsRoot: root, cwd: parent })).toBeUndefined();
  });

  it('resolves nothing from a directory outside the apps root entirely', () => {
    const root = appsRoot();
    install(root, 'kvox');
    const elsewhere = mkdtempSync(join(tmpdir(), 'appctl-elsewhere-'));

    expect(locateAppFromCwd({ appsRoot: root, cwd: elsewhere })).toBeUndefined();
  });

  it('resolves nothing under the apps root when no ancestor holds a state file', () => {
    const root = appsRoot();
    const bare = join(root, 'not-an-app', 'deeper');
    mkdirSync(bare, { recursive: true });

    expect(locateAppFromCwd({ appsRoot: root, cwd: bare })).toBeUndefined();
  });

  it('takes the NEAREST deployment when one is nested inside another', () => {
    const root = appsRoot();
    const outer = install(root, 'outer');
    const inner = join(outer, 'inner');
    mkdirSync(inner, { recursive: true });
    writeState({
      version: DEPLOY_STATE_VERSION,
      repoUrl: 'https://example.test/o/inner',
      ref: 'main',
      commitSha: 'b'.repeat(40),
      bindPort: 3600,
      deployRoot: inner,
      installedAt: '2026-01-01T00:00:00.000Z',
      lastDeployedAt: '2026-01-01T00:00:00.000Z',
      lastCommand: 'install',
      appctlVersion: '1.0.0',
      name: 'inner',
      appsRoot: root,
    });

    expect(locateAppFromCwd({ appsRoot: root, cwd: inner })?.layout.name).toBe('inner');
  });

  it('names the deployment after its directory when the state predates #119', () => {
    const root = appsRoot();
    const deployRoot = install(root, 'legacy', { name: undefined });

    expect(locateAppFromCwd({ appsRoot: root, cwd: deployRoot })?.layout.name).toBe('legacy');
  });

  it('walks past an unreadable state file rather than raising', () => {
    // Same posture as listInstalledApps: a file this build cannot interpret
    // is reported by whichever command then acts on the deployment, not by
    // the lookup that found the directory.
    const root = appsRoot();
    const deployRoot = install(root, 'kvox');
    const broken = join(deployRoot, 'broken');
    mkdirSync(broken, { recursive: true });
    writeFileSync(deployStatePath(broken), '{ not json');

    expect(locateAppFromCwd({ appsRoot: root, cwd: broken })?.layout.deployRoot).toBe(deployRoot);
  });
});

describe('locateInstalledApp', () => {
  it('says nothing is installed, as a usage error naming install', () => {
    const root = appsRoot();
    const error = (() => {
      try {
        locateInstalledApp({ appsRoot: root });
        return undefined;
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(NotInstalledError);
    expect((error as Error).message).toContain(root);
    expect((error as Error).message).toContain('deploy install');
    expect(exitCodeFor(error)).toBe(EXIT.USAGE);
  });
});
