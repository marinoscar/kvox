import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXIT, UsageError, exitCodeFor } from '../errors.js';
import {
  DEFAULT_APPS_ROOT,
  appNameFor,
  appRootFor,
  listInstalledApps,
  locateApp,
  locateInstalledApp,
  projectNameFor,
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
