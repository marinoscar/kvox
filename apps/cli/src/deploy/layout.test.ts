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

/**
 * A deployment with NO state file: a clone and an `.env`, which is what the
 * disk of a server whose bookkeeping was lost actually looks like (#285).
 */
function unrecorded(
  root: string,
  dir: string,
  env: Record<string, string> = { APP_BIND_PORT: '3535' },
): string {
  const deployRoot = join(root, dir);
  mkdirSync(join(deployRoot, 'repo', '.git'), { recursive: true });
  writeFileSync(
    join(deployRoot, '.env'),
    `${Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}\n`,
    { mode: 0o600 },
  );
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

  it('lists the subdirectories that are deployments, and no other', () => {
    const root = appsRoot();
    install(root, 'alpha');
    install(root, 'beta');
    mkdirSync(join(root, 'not-an-app'));
    writeFileSync(join(root, 'stray-file'), '');

    expect(listInstalledApps(root).map((app) => app.name)).toEqual(['alpha', 'beta']);
  });

  // ---------------------------------------------------------------------------
  // A deployment is a clone plus an .env, not a state file (issue #285)
  // ---------------------------------------------------------------------------

  it('lists a deployment that has no state file, by the same evidence `update` adopts on', () => {
    // The gap: discovery keyed on the state file for the same reason
    // `requireState` did, so a bare `kvox deploy update` never even reached
    // the adoption path.
    const root = appsRoot();
    unrecorded(root, 'orphan', { APP_BIND_PORT: '3535', COMPOSE_PROJECT_NAME: 'orphan' });

    expect(listInstalledApps(root)).toEqual([
      { name: 'orphan', deployRoot: join(root, 'orphan'), bindPort: 3535 },
    ]);
  });

  it('still refuses a directory that is only half a deployment', () => {
    // Positive evidence: a clone with no .env, and an .env with no clone, are
    // each still not a deployment.
    const root = appsRoot();
    mkdirSync(join(root, 'clone-only', 'repo', '.git'), { recursive: true });
    mkdirSync(join(root, 'env-only'), { recursive: true });
    writeFileSync(join(root, 'env-only', '.env'), 'APP_BIND_PORT=3535\n');

    expect(listInstalledApps(root)).toEqual([]);
  });

  it('names an unrecorded deployment from COMPOSE_PROJECT_NAME, else the directory', () => {
    const root = appsRoot();
    unrecorded(root, 'dirname', { APP_BIND_PORT: '3535', COMPOSE_PROJECT_NAME: 'recorded' });
    unrecorded(root, 'plain');

    expect(listInstalledApps(root).map((app) => app.name)).toEqual(['recorded', 'plain']);
  });

  it('carries the state on a recorded app and leaves it undefined on an unrecorded one', () => {
    const root = appsRoot();
    install(root, 'alpha');
    unrecorded(root, 'beta');

    const [alpha, beta] = listInstalledApps(root);
    expect(alpha?.state?.commitSha).toBe('a'.repeat(40));
    expect(beta?.state).toBeUndefined();
    // Both carry a port, which is the field every caller of this listing that
    // is not about the state itself actually wants.
    expect([alpha?.bindPort, beta?.bindPort]).toEqual([3535, 3535]);
  });

  it('leaves bindPort undefined when an unrecorded deployment names no port', () => {
    // `envFacts` reads and never decides: a default here would tell the
    // install wizard 3535 is taken when nothing on that disk says so.
    const root = appsRoot();
    unrecorded(root, 'portless', { POSTGRES_HOST: 'db' });

    expect(listInstalledApps(root)[0]?.bindPort).toBeUndefined();
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

  it('counts a deployment with no state file - that port really is taken (#285)', () => {
    // #257's whole point: a port a sibling holds is held whether or not this
    // CLI has a record of the sibling.
    const root = appsRoot();
    install(root, 'alpha', { bindPort: 3535 });
    unrecorded(root, 'beta', { APP_BIND_PORT: '3536', COMPOSE_PROJECT_NAME: 'beta' });

    expect(siblingBindPorts(root)).toEqual([
      { name: 'alpha', port: 3535 },
      { name: 'beta', port: 3536 },
    ]);
  });

  it('claims no port for a deployment whose port it cannot read', () => {
    // Saying nothing beats inventing 3535 and telling the wizard a free port
    // is taken.
    const root = appsRoot();
    unrecorded(root, 'portless', { POSTGRES_HOST: 'db' });

    expect(siblingBindPorts(root)).toEqual([]);
  });
});

describe('locateApp', () => {
  // ---------------------------------------------------------------------------
  // Ambiguity stays solved the way it already was (issue #285)
  // ---------------------------------------------------------------------------

  it('finds the one deployment that has no state file, with nothing named', () => {
    const root = appsRoot();
    const deployRoot = unrecorded(root, 'orphan', {
      APP_BIND_PORT: '3535',
      COMPOSE_PROJECT_NAME: 'orphan',
    });

    expect(locateApp({ appsRoot: root })).toEqual({
      name: 'orphan',
      appsRoot: root,
      deployRoot,
    });
  });

  it('refuses two unrecorded deployments exactly as it refuses two recorded ones, naming both', () => {
    const root = appsRoot();
    unrecorded(root, 'alpha', { APP_BIND_PORT: '3535', COMPOSE_PROJECT_NAME: 'alpha' });
    unrecorded(root, 'beta', { APP_BIND_PORT: '3536', COMPOSE_PROJECT_NAME: 'beta' });

    expect(() => locateApp({ appsRoot: root })).toThrow(UsageError);
    expect(() => locateApp({ appsRoot: root })).toThrow(/alpha, beta/);
    expect(() => locateApp({ appsRoot: root })).toThrow(/--name/);
  });

  it('refuses a recorded app beside an unrecorded one, with no silent preference for either', () => {
    // Preferring the state-bearing one would be a tiebreak this command has
    // never had, invented at the moment an operator most needs to be asked.
    const root = appsRoot();
    install(root, 'recorded');
    unrecorded(root, 'unrecorded', { APP_BIND_PORT: '3536', COMPOSE_PROJECT_NAME: 'unrecorded' });

    expect(() => locateApp({ appsRoot: root })).toThrow(/recorded, unrecorded/);
  });

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
