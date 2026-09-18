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
  deploymentAtCwd,
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
 *
 * `DEPLOY_ROOT` is always in the `.env`, because it always is on a real one:
 * install writes it and update re-pins it (#142). It is what tells this CLI's
 * own deployment apart from a stranger's - see `foreign` below.
 */
function unrecorded(
  root: string,
  dir: string,
  env: Record<string, string> = { APP_BIND_PORT: '3535' },
): string {
  const deployRoot = join(root, dir);
  return writeDeploymentFiles(deployRoot, { DEPLOY_ROOT: deployRoot, ...env });
}

/**
 * Somebody else's application, deployed under the same apps root by the same
 * one-app-one-folder convention (#290): a clone and a readable `.env`, so it
 * passes the shared evidence gate, and none of the keys this CLI writes.
 */
function foreign(root: string, dir: string, env: Record<string, string> = {}): string {
  return writeDeploymentFiles(join(root, dir), { APP_BIND_PORT: '8080', ...env });
}

function writeDeploymentFiles(deployRoot: string, env: Record<string, string>): string {
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

/** The pre-#142 layout: the `.env` inside the clone, and no markers in it. */
function legacyUnrecorded(root: string, dir: string): string {
  const deployRoot = join(root, dir);
  mkdirSync(join(deployRoot, 'repo', '.git'), { recursive: true });
  mkdirSync(join(deployRoot, 'repo', 'infra', 'compose'), { recursive: true });
  writeFileSync(join(deployRoot, 'repo', 'infra', 'compose', '.env'), 'APP_BIND_PORT=3535\n', {
    mode: 0o600,
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

  // ---------------------------------------------------------------------------
  // Enumeration is narrower than adoption (issue #290)
  // ---------------------------------------------------------------------------

  it('leaves out somebody else\'s app under the same apps root', () => {
    // The reported host: seven directories under /opt/infra/apps, six of them
    // unrelated applications following the same one-app-one-folder
    // convention. They pass the shared evidence gate - that gate answers "is
    // there a deployment here?", not "is it mine?" - and were named in an
    // ambiguity refusal about THIS CLI's deployments.
    const root = appsRoot();
    install(root, 'kvox');
    foreign(root, 'vault');
    foreign(root, 'knecta', { COMPOSE_PROJECT_NAME: 'knecta' });

    expect(listInstalledApps(root).map((app) => app.name)).toEqual(['kvox']);
  });

  it('still lists a genuine deployment that has no state file', () => {
    // The narrowing must not undo #285: an unrecorded deployment of ours
    // carries DEPLOY_ROOT, which install writes and update re-pins.
    const root = appsRoot();
    unrecorded(root, 'orphan');

    expect(listInstalledApps(root).map((app) => app.name)).toEqual(['orphan']);
  });

  it('still lists an unrecorded deployment that predates DEPLOY_ROOT', () => {
    // Its .env is inside the clone, where ours lived before #142, and carries
    // neither marker. Hiding it would regress #285 in the other direction,
    // and listing one extra name is the cheaper mistake of the two.
    const root = appsRoot();
    const deployRoot = legacyUnrecorded(root, 'ancient');

    expect(listInstalledApps(root)).toEqual([
      { name: 'ancient', deployRoot, bindPort: 3535 },
    ]);
  });

  it('lists a recorded app whatever its .env says, markers or not', () => {
    // The state file is this CLI's own record; the marker question is only
    // ever asked of a directory with no record at all.
    const root = appsRoot();
    const deployRoot = install(root, 'recorded');
    mkdirSync(join(deployRoot, 'repo', '.git'), { recursive: true });
    writeFileSync(join(deployRoot, '.env'), 'APP_BIND_PORT=3535\n');

    expect(listInstalledApps(root).map((app) => app.name)).toEqual(['recorded']);
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

  // ---------------------------------------------------------------------------
  // cwd is a rank (issue #290)
  // ---------------------------------------------------------------------------

  it('resolves the deployment cwd is standing in, with several installed', () => {
    // The reported failure: standing in /opt/infra/apps/kvox on a host with
    // seven apps and being asked which app was meant.
    const root = appsRoot();
    install(root, 'alpha');
    const kvox = install(root, 'kvox');
    install(root, 'zeta');

    expect(locateApp({ appsRoot: root, cwd: kvox })).toEqual({
      name: 'kvox',
      appsRoot: root,
      deployRoot: kvox,
    });
  });

  it('resolves it from a subdirectory of the deploy root too', () => {
    const root = appsRoot();
    install(root, 'alpha');
    const kvox = install(root, 'kvox');
    const inside = join(kvox, 'repo', 'infra', 'compose');
    mkdirSync(inside, { recursive: true });

    expect(locateApp({ appsRoot: root, cwd: inside })?.deployRoot).toBe(kvox);
  });

  it('finds a deployment with NO state file by cwd - the case that sent the operator here', () => {
    // #285 made a recordless deployment discoverable; before #290 the cwd
    // walk still keyed on the state file, so it would have missed exactly the
    // deployment it exists to find.
    const root = appsRoot();
    install(root, 'alpha');
    const orphan = unrecorded(root, 'orphan');

    expect(locateApp({ appsRoot: root, cwd: orphan })).toEqual({
      name: 'orphan',
      appsRoot: root,
      deployRoot: orphan,
    });
  });

  it('lets --name outrank cwd, so --name vault from inside kvox means vault', () => {
    const root = appsRoot();
    const kvox = install(root, 'kvox');
    install(root, 'vault');

    expect(locateApp({ appsRoot: root, name: 'vault', cwd: kvox })).toEqual({
      name: 'vault',
      appsRoot: root,
      deployRoot: join(root, 'vault'),
    });
  });

  it('lets --root outrank cwd', () => {
    const root = appsRoot();
    const kvox = install(root, 'kvox');
    const other = install(root, 'vault');

    expect(locateApp({ appsRoot: root, root: other, cwd: kvox })?.deployRoot).toBe(other);
  });

  it('does not resolve from a directory outside the apps root', () => {
    // The bound #266 set stays: a deploy root installed elsewhere with --root
    // is deliberately not found by a walk, and --root is how it was named.
    const root = appsRoot();
    install(root, 'alpha');
    install(root, 'beta');
    const elsewhere = mkdtempSync(join(tmpdir(), 'appctl-elsewhere-'));

    expect(() => locateApp({ appsRoot: root, cwd: elsewhere })).toThrow(/alpha, beta/);
  });

  it('refuses from the apps root itself, exactly as before', () => {
    const root = appsRoot();
    install(root, 'alpha');
    install(root, 'beta');

    expect(() => locateApp({ appsRoot: root, cwd: root })).toThrow(UsageError);
  });

  it('falls through unchanged from a directory under the apps root that is not a deployment', () => {
    const root = appsRoot();
    install(root, 'alpha');
    install(root, 'beta');
    const bare = join(root, 'not-an-app', 'deeper');
    mkdirSync(bare, { recursive: true });

    expect(() => locateApp({ appsRoot: root, cwd: bare })).toThrow(/alpha, beta/);
  });

  it('does not resolve a foreign app by cwd either, so cwd and the listing agree', () => {
    const root = appsRoot();
    install(root, 'alpha');
    install(root, 'beta');
    const vault = foreign(root, 'vault');

    expect(() => locateApp({ appsRoot: root, cwd: vault })).toThrow(/alpha, beta/);
  });

  it('still answers undefined from inside a deployment-less apps root', () => {
    // The pre-install case `doctor` depends on: nothing named, nothing
    // installed, and a cwd that resolves nothing.
    const root = appsRoot();
    const bare = join(root, 'scratch');
    mkdirSync(bare, { recursive: true });

    expect(locateApp({ appsRoot: root, cwd: bare })).toBeUndefined();
  });

  it('still prefers the one installed app when cwd resolves nothing', () => {
    const root = appsRoot();
    const only = install(root, 'only');

    expect(locateApp({ appsRoot: root, cwd: root })?.deployRoot).toBe(only);
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

  it('still ignores a deployment with no state file - install needs the record', () => {
    // #290 widened the rank `locateApp` uses, NOT this one: install reads the
    // repository, the ref and the name off the state file it finds here, and
    // a recordless deployment has none of that to give. It falls through to
    // the git-checkout rank exactly as it did before.
    const root = appsRoot();
    const orphan = unrecorded(root, 'orphan');

    expect(locateAppFromCwd({ appsRoot: root, cwd: orphan })).toBeUndefined();
    // ... while the rank every other command uses does answer about it.
    expect(deploymentAtCwd({ appsRoot: root, cwd: orphan })?.deployRoot).toBe(orphan);
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
