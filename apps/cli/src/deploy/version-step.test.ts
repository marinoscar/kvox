import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { envFilePath, writeEnvFile } from './env-file.js';
import { parseEnvFile } from './env-spec.js';
import { readDeployInfo } from './deploy-info.js';
import { runUpdate } from './update.js';
import {
  DEPLOY_STATE_VERSION,
  readState,
  writeState,
  type DeployState,
} from './state.js';
import {
  FAKE_APP_VERSION,
  FAKE_BUMP_SHA,
  fakeVps,
  healthyFetch,
  populateClone,
  silentPrompt,
  type FakeVps,
} from './testing/fake-vps.js';

// =============================================================================
// Deploy-time versioning, end to end through the update pipeline  (issue #295)
// =============================================================================
//
// `app-version.test.ts` covers the arithmetic. THIS file covers the four
// things issue #295 calls hazards, because each of them is a property of the
// PIPELINE rather than of a function:
//
//   1. The health gate: a run that fails at `build` publishes nothing.
//   2. The rollback: a failed push leaves a healthy deployment, a warning, and
//      a clone that is not left ahead of origin.
//   3. A ref that is not a branch: nothing to publish to, said rather than
//      guessed.
//   4. The `.env` write: through the real serializer, so the template's key
//      order and section banners survive (#291's trap).
// =============================================================================

const INSTALLED_SHA = 'a'.repeat(40);
const NEW_SHA = 'b'.repeat(40);

/** An installed deployment whose clone carries FAKE_APP_VERSION. */
function installedApp(vps: FakeVps): string {
  const root = mkdtempSync(join(tmpdir(), 'appctl-version-'));
  populateClone(join(root, 'repo'));

  const state: DeployState = {
    version: DEPLOY_STATE_VERSION,
    repoUrl: 'https://example.test/o/demo',
    ref: 'main',
    commitSha: INSTALLED_SHA,
    bindPort: 3535,
    deployRoot: root,
    name: 'demo',
    installedAt: '2026-01-01T00:00:00.000Z',
    lastDeployedAt: '2026-01-02T00:00:00.000Z',
    lastCommand: 'install',
    appctlVersion: '1.0.0',
  };
  writeState(state);

  writeEnvFile(
    root,
    [
      `# ${'-'.repeat(77)}`,
      '# Database',
      `# ${'-'.repeat(77)}`,
      'POSTGRES_HOST=127.0.0.1',
      `POSTGRES_PORT=${vps.dbPort}`,
      'POSTGRES_USER=app',
      'POSTGRES_PASSWORD=not-the-default-password',
      'POSTGRES_DB=appdb',
      'POSTGRES_SSL=false',
      '',
      `# ${'-'.repeat(77)}`,
      '# Application',
      `# ${'-'.repeat(77)}`,
      'APP_BIND_PORT=3535',
      'INITIAL_ADMIN_EMAIL=admin@ops.test',
      'NODE_ENV=production',
      '',
      `# ${'-'.repeat(77)}`,
      '# Not in .env.example',
      `# ${'-'.repeat(77)}`,
      'COMPOSE_PROJECT_NAME=demo',
      `DEPLOY_ROOT=${root}`,
      '',
    ].join('\n'),
  );

  return root;
}

const clonePath = (root: string): string => join(root, 'repo');

const manifestVersion = (root: string, app: 'api' | 'web'): unknown =>
  (
    JSON.parse(
      readFileSync(join(clonePath(root), 'apps', app, 'package.json'), 'utf8'),
    ) as { version?: unknown }
  ).version;

const lockVersion = (root: string, workspace: string): unknown =>
  (
    JSON.parse(readFileSync(join(clonePath(root), 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version?: unknown }>;
    }
  ).packages[workspace]?.version;

const envOf = (root: string): Map<string, string> =>
  parseEnvFile(readFileSync(envFilePath(root), 'utf8'));

/** Every git argv this run issued, joined. */
const gitCalls = (vps: FakeVps): string[] =>
  vps.seen.filter((argv) => argv[0] === 'git').map((argv) => argv.join(' '));

describe('deploy-time versioning (#295)', () => {
  let vps: FakeVps;

  beforeEach(async () => {
    vps = await fakeVps({ head: INSTALLED_SHA, remoteSha: NEW_SHA });
    vi.stubGlobal('fetch', healthyFetch());
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await vps.close();
  });

  function update(root: string, extra: Record<string, unknown> = {}) {
    return runUpdate({
      deployRoot: root,
      runCommand: vps.runCommand,
      nonInteractive: true,
      promptContext: silentPrompt(),
      skipProxy: true,
      skipSeed: true,
      cwd: root,
      ...extra,
    });
  }

  // ---------------------------------------------------------------------------
  // The suggestion, the override, and the refusals
  // ---------------------------------------------------------------------------

  it('takes the suggested patch bump under --non-interactive, and says so', async () => {
    // DELIBERATE (#295 §3): refusing here would break every unattended deploy,
    // including `.github/workflows/deploy-e2e.yml`, which runs `deploy update
    // --non-interactive` twice. The suggestion is also the correct default —
    // it cannot move the number backwards by construction.
    const root = installedApp(vps);

    const result = await update(root);

    expect(result.appVersion).toEqual({ version: '1.2.4', published: true });
    expect(manifestVersion(root, 'api')).toBe('1.2.4');
    expect(result.warnings).toEqual([]);
  });

  it('writes ONE shared version to both manifests and both lockfile entries', async () => {
    // `apps/api` and `apps/web` ship as one deployment from one commit, so two
    // numbers could only ever diverge by accident.
    const root = installedApp(vps);

    await update(root);

    expect(manifestVersion(root, 'api')).toBe('1.2.4');
    expect(manifestVersion(root, 'web')).toBe('1.2.4');
    expect(lockVersion(root, 'apps/api')).toBe('1.2.4');
    expect(lockVersion(root, 'apps/web')).toBe('1.2.4');
  });

  it('lets --app-version override the suggestion', async () => {
    const root = installedApp(vps);

    const result = await update(root, { appVersion: '2.0.0' });

    expect(result.appVersion?.version).toBe('2.0.0');
    expect(manifestVersion(root, 'web')).toBe('2.0.0');
    expect(envOf(root).get('APP_VERSION')).toBe('2.0.0');
  });

  it('REFUSES an --app-version that is not SemVer, rather than falling back', async () => {
    // A bad flag is a bad invocation. Silently deploying a different number
    // from the one that was typed is the worst available outcome.
    const root = installedApp(vps);

    await expect(update(root, { appVersion: 'v2.0.0' })).rejects.toThrow(
      /not a valid SemVer/,
    );
    expect(manifestVersion(root, 'api')).toBe(FAKE_APP_VERSION);
  });

  it('REFUSES an --app-version that moves the number backwards', async () => {
    const root = installedApp(vps);

    await expect(update(root, { appVersion: '1.0.0' })).rejects.toThrow(/sorts BELOW/);
    expect(manifestVersion(root, 'api')).toBe(FAKE_APP_VERSION);
    expect(envOf(root).has('APP_VERSION')).toBe(false);
  });

  it('leaves everything alone with --no-version-bump', async () => {
    const root = installedApp(vps);

    const result = await update(root, { versionBump: false });

    expect(result.appVersion).toBeUndefined();
    expect(result.changed).toBe(true);
    expect(manifestVersion(root, 'api')).toBe(FAKE_APP_VERSION);
    expect(envOf(root).has('APP_VERSION')).toBe(false);
    expect(gitCalls(vps).some((line) => line.includes('push'))).toBe(false);
  });

  it('measures the next bump from the DEPLOYED version, not only from the clone', async () => {
    // The monotonicity guarantee that survives a failed publish: the `.env`
    // is in `currentAppVersion`'s maximum, so a clone left holding the old
    // number cannot make the running version go backwards.
    const root = installedApp(vps);
    writeEnvFile(
      root,
      `${readFileSync(envFilePath(root), 'utf8')}APP_VERSION=1.9.0\n`,
    );

    const result = await update(root);

    expect(result.appVersion?.version).toBe('1.9.1');
  });

  // ---------------------------------------------------------------------------
  // The `.env` write  (#291's serialization trap)
  // ---------------------------------------------------------------------------

  it('sets APP_VERSION without disturbing the key order or the section banners', async () => {
    const root = installedApp(vps);
    const before = readFileSync(envFilePath(root), 'utf8');

    await update(root);

    const after = readFileSync(envFilePath(root), 'utf8');

    // Every banner the file had, still there and still in order.
    expect(after.split('\n').filter((line) => line.startsWith('# ') && !line.startsWith('# --')))
      .toEqual(before.split('\n').filter((line) => line.startsWith('# ') && !line.startsWith('# --')));

    // Every key the file had, in the same order, with APP_VERSION appended
    // under the CLI-managed banner rather than inserted into the template's
    // own sections.
    const keysOf = (text: string): string[] =>
      text
        .split('\n')
        .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
        .filter((key): key is string => key !== undefined);

    expect(keysOf(after)).toEqual([...keysOf(before), 'APP_VERSION']);
    expect(after).toContain('# Not in .env.example');
    expect(envOf(root).get('APP_VERSION')).toBe('1.2.4');
  });

  // ---------------------------------------------------------------------------
  // What a SUCCESSFUL publish leaves behind
  // ---------------------------------------------------------------------------

  it('records the BUMP COMMIT as deployed once the push succeeds', async () => {
    // ⚠ NOT COSMETIC. The images were built with HEAD at the bump commit — the
    // `version` step commits before `build` — so its tree is exactly what is
    // deployed. Recording the PRE-bump commit while origin now points at the
    // bump commit would make the server permanently report itself `1 commit
    // behind`, and the next `update` would rebuild byte-identical code and
    // bump again, for ever.
    const root = installedApp(vps);

    const result = await update(root);

    expect(result.appVersion?.published).toBe(true);
    expect(result.commitSha).toBe(FAKE_BUMP_SHA);
    expect(readState(root)?.commitSha).toBe(FAKE_BUMP_SHA);
    expect(readDeployInfo(root)?.app.commitSha).toBe(FAKE_BUMP_SHA);
  });

  it('keeps the PRE-bump commit as deployed when the push is refused', async () => {
    // The mirror image, and the reason the branch exists: a bump commit that
    // was rolled back exists nowhere, so naming it would be a record of a
    // commit nobody can fetch.
    const root = installedApp(vps);
    vps.failWhen((argv) => argv[1] === 'push', 'permission denied');

    const result = await update(root);

    expect(result.appVersion?.published).toBe(false);
    expect(result.commitSha).toBe(NEW_SHA);
    expect(readDeployInfo(root)?.app.commitSha).toBe(NEW_SHA);
  });

  it('pushes to the deployed BRANCH by explicit refspec, from a detached HEAD', async () => {
    // `ensureCheckout` always leaves the clone detached, on every deployment.
    // So the push names the branch outright rather than relying on HEAD being
    // attached to one — which it never is.
    const root = installedApp(vps);

    await update(root);

    const push = gitCalls(vps).find((line) => line.includes(' push '));
    expect(push).toBe('git push origin HEAD:refs/heads/main');
  });

  // ---------------------------------------------------------------------------
  // Hazard 1 — the health gate
  // ---------------------------------------------------------------------------

  it('publishes NOTHING when the run fails at build', async () => {
    // #295's gate, which is #283's gate for deploy-info and for the same
    // reason: a version published for a release that never ran is a number
    // nobody can interpret afterwards.
    const root = installedApp(vps);
    vps.failWhen((argv) => argv.includes('build'), 'image build failed');

    await expect(update(root)).rejects.toThrow(/Build images failed/);

    expect(gitCalls(vps).some((line) => line.includes('push'))).toBe(false);
  });

  it('leaves the clone COMMITTED rather than dirty when a later step fails', async () => {
    // The hazard `ensureCheckout` creates: it REFUSES a dirty tree, so a run
    // that wrote package.json and then died at `build` would wedge the next
    // update behind a refusal about files the operator never touched. The
    // write and the commit are one step for exactly this reason.
    const root = installedApp(vps);
    vps.failWhen((argv) => argv.includes('build'), 'image build failed');

    await expect(update(root)).rejects.toThrow();

    const calls = gitCalls(vps);
    expect(calls.some((line) => line.startsWith('git add'))).toBe(true);
    expect(calls.some((line) => line.includes('commit'))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Hazard 2 / 5 — a push that is rejected
  // ---------------------------------------------------------------------------

  it('a rejected push leaves a HEALTHY deployment, a warning and no failure', async () => {
    // By the time the publish runs the application is built, migrated,
    // restarted, answering and verified. #265's `/etc/cron.d` precedent: warn,
    // carry it in the warnings, surface it — never fail a finished deployment
    // over bookkeeping.
    const root = installedApp(vps);
    vps.failWhen(
      (argv) => argv[1] === 'push',
      '! [rejected] HEAD -> main (non-fast-forward)',
    );

    const result = await update(root);

    expect(result.changed).toBe(true);
    expect(result.appVersion).toEqual({ version: '1.2.4', published: false });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('running v1.2.4');
    expect(result.warnings[0]).toContain('non-fast-forward');
    expect(result.warnings[0]).toContain('Nothing is broken');
  });

  it('never force-pushes, and never retries a rejected push', async () => {
    // Retrying means re-committing the bump on top of whatever origin moved
    // to — but the deployment was BUILT from the old tip, so the published
    // commit's tree would contain code this server never built.
    const root = installedApp(vps);
    vps.failWhen((argv) => argv[1] === 'push', 'non-fast-forward');

    await update(root);

    const pushes = gitCalls(vps).filter((line) => line.includes(' push '));
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).not.toContain('--force');
    expect(pushes[0]).not.toContain('-f ');
  });

  it('restores the clone after a rejected push, so the next update is unaffected', async () => {
    // Without this the clone stays permanently one commit ahead of origin, and
    // every later update sees `changed: true` and rebuilds identical images
    // for ever — which is also what would break the E2E's "already up to date".
    const root = installedApp(vps);
    vps.failWhen((argv) => argv[1] === 'push', 'permission denied');

    await update(root);

    const calls = gitCalls(vps);
    const lastCheckout = calls.filter((line) => line.includes('checkout')).at(-1);
    expect(lastCheckout).toContain('--force --detach');
    expect(vps.head).toBe(NEW_SHA);
  });

  it('still reports the DEPLOYED version in deploy-info after a rejected push', async () => {
    // The record must say what is running. `readDeployedAppVersion`'s default
    // reads the clone, which the rollback just restored to the old number.
    const root = installedApp(vps);
    vps.failWhen((argv) => argv[1] === 'push', 'permission denied');

    await update(root);

    // What is DEPLOYED: the image and the `.env` carry 1.2.4, so the record
    // must too — even though the clone was restored to the pre-bump commit.
    // (The restore itself is a `git checkout`, asserted in the test above; the
    // fake VPS does not re-materialise files, so the manifest on disk here is
    // not the thing under test.)
    expect(readDeployInfo(root)?.app.version).toBe('1.2.4');
    expect(envOf(root).get('APP_VERSION')).toBe('1.2.4');
  });

  // ---------------------------------------------------------------------------
  // Hazard 4 — a ref that is not a branch
  // ---------------------------------------------------------------------------

  it('declines to publish when the deployed ref is a tag or a commit', async () => {
    // ⚠ NOT "when HEAD is detached". `ensureCheckout` always leaves the clone
    // detached, on every deployment — testing for that would skip the publish
    // every single time. The real question is whether the TARGET REF names a
    // branch on origin.
    const root = installedApp(vps);
    // The fake answers `rev-parse --verify` only for `refs/remotes/origin/*`,
    // so a ref resolved as a tag has no origin branch behind it.
    vps.failWhen(
      (argv) => argv[1] === 'rev-parse' && String(argv[4]).includes('refs/remotes/origin/v1.4.0'),
      'unknown revision',
    );

    const result = await update(root, { ref: 'v1.4.0' });

    expect(result.appVersion).toEqual({ version: '1.2.4', published: false });
    expect(result.warnings[0]).toContain('is not a branch on origin');
    expect(gitCalls(vps).some((line) => line.includes(' push '))).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Nothing to deploy is nothing to version
  // ---------------------------------------------------------------------------

  it('does not version an update with nothing to apply', async () => {
    // ⚠ LOAD-BEARING FOR THE E2E AND FOR CRON. An update with nothing to apply
    // deploys no new release, so there is no release to version — otherwise
    // `deploy update` from cron becomes a version generator that moves `main`
    // every few minutes.
    const root = installedApp(vps);
    vps.remoteSha = INSTALLED_SHA;

    const result = await update(root);

    expect(result.changed).toBe(false);
    expect(result.appVersion).toBeUndefined();
    expect(manifestVersion(root, 'api')).toBe(FAKE_APP_VERSION);
    expect(envOf(root).has('APP_VERSION')).toBe(false);
    expect(gitCalls(vps).some((line) => line.includes(' push '))).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // A manifest this CLI cannot edit
  // ---------------------------------------------------------------------------

  it('fails before writing anything when one manifest cannot be edited', async () => {
    // Both manifests or neither: a run that wrote one and threw on the other
    // would leave a repository claiming the API and the web app are different
    // releases.
    const root = installedApp(vps);
    writeFileSync(
      join(clonePath(root), 'apps', 'web', 'package.json'),
      JSON.stringify({ name: 'web' }),
    );

    // `pipelineFailure` re-wraps a step's error (only a PreconditionError
    // keeps its class), so this asserts the message the operator sees.
    await expect(update(root)).rejects.toThrow(/Could not find the top-level "version" field/);
    expect(manifestVersion(root, 'api')).toBe(FAKE_APP_VERSION);
  });
});
