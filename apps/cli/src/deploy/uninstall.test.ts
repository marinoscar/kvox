import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { CLI_NAME } from '../branding.js';
import { UsageError } from '../errors.js';
import { composeEnvPath, envFilePath } from './env-file.js';
import type { CommandResult, RunCommandOptions } from './executor.js';
import { composeArgv, runInstall, type InstallOptions } from './install.js';
import { renderVhost, renewalCronPath, vhostPath } from './proxy.js';
import { DEPLOY_STATE_VERSION, deployStatePath, writeState, type DeployState } from './state.js';
import { fakeVps, healthyFetch, populateClone, silentPrompt, type FakeVps } from './testing/fake-vps.js';
import { dropDatabaseCommand, requireConfirmation, runUninstall } from './uninstall.js';

// =============================================================================
// `kvox deploy uninstall`  (issue #261, epic #168)
// =============================================================================
//
// Built the way install.test.ts is: a real temp directory standing in for the
// server, and `runCommand` replaced by a recorder, so the assertions are about
// WHAT WAS WRITTEN and WHICH ARGV WAS RUN rather than about a mock of the
// pipeline itself.
//
// The four NEGATIVE assertions in "the four deliberate refusals" below are the
// point of this issue. Every one of them is a thing this command could
// plausibly be "improved" to do, and every one of them would be wrong.
// =============================================================================

const APP = 'demo';
const DOMAIN = 'app.example.test';

interface Deployment {
  appsRoot: string;
  deployRoot: string;
  proxyRoot: string;
  cronDir: string;
  /** Every argv the run issued, in order. */
  seen: string[][];
  runCommand: typeof import('./executor.js').runCommand;
}

/** A complete, published deployment on disk: everything install would leave. */
function deployment(options: { domain?: string | undefined; clone?: boolean } = {}): Deployment {
  const appsRoot = mkdtempSync(join(tmpdir(), 'appctl-uninstall-'));
  const deployRoot = join(appsRoot, APP);
  const proxyRoot = join(appsRoot, 'proxy');
  const cronDir = join(appsRoot, 'cron.d');
  const domain = options.domain === undefined ? DOMAIN : options.domain;

  mkdirSync(deployRoot, { recursive: true });
  mkdirSync(join(deployRoot, 'logs'), { recursive: true });
  mkdirSync(join(deployRoot, 'data'), { recursive: true });
  mkdirSync(join(deployRoot, 'deploy-info'), { recursive: true });
  writeFileSync(join(deployRoot, 'deploy-info', 'info.json'), '{}\n');
  writeFileSync(join(deployRoot, 'logs', 'appctl-install-x.log'), 'log\n');

  if (options.clone !== false) populateClone(join(deployRoot, 'repo'));

  writeFileSync(
    envFilePath(deployRoot),
    [
      'POSTGRES_HOST=db.internal',
      'POSTGRES_PORT=5432',
      'POSTGRES_USER=app',
      'POSTGRES_PASSWORD=s3cret-value',
      'POSTGRES_DB=appdb',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );

  const state: DeployState = {
    version: DEPLOY_STATE_VERSION,
    repoUrl: 'https://example.test/o/demo.git',
    ref: 'main',
    commitSha: 'a'.repeat(40),
    bindPort: 3535,
    deployRoot,
    name: APP,
    appsRoot,
    proxyRoot,
    proxyContainer: 'proxy-nginx',
    installedAt: '2026-01-01T00:00:00.000Z',
    lastDeployedAt: '2026-01-01T00:00:00.000Z',
    lastCommand: 'install',
    appctlVersion: '1.3.1',
    ...(domain === '' ? {} : { domain }),
  };
  writeState(state);

  if (domain !== '') {
    mkdirSync(join(proxyRoot, 'nginx', 'conf.d'), { recursive: true });
    writeFileSync(
      vhostPath({ domain, bindPort: 3535, proxyRoot }),
      renderVhost({ domain, bindPort: 3535, proxyRoot }),
      { mode: 0o644 },
    );
    // A certificate on disk, where `certbot delete` would find it.
    mkdirSync(join(proxyRoot, 'letsencrypt', 'live', domain), { recursive: true });
    writeFileSync(join(proxyRoot, 'letsencrypt', 'live', domain, 'fullchain.pem'), 'PEM\n');
  }

  mkdirSync(cronDir, { recursive: true });
  writeFileSync(renewalCronPath(APP, cronDir), '# cron\n', { mode: 0o644 });

  const seen: string[][] = [];
  const runCommand = (async (
    argv: readonly string[],
    runOptions: RunCommandOptions,
  ): Promise<CommandResult> => {
    seen.push([...argv]);
    return {
      argv: [...argv],
      cwd: runOptions.cwd,
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 1,
      timedOut: false,
    };
  }) as typeof import('./executor.js').runCommand;

  return { appsRoot, deployRoot, proxyRoot, cronDir, seen, runCommand };
}

function uninstall(fixture: Deployment, extra: Record<string, unknown> = {}) {
  return runUninstall({
    appsRoot: fixture.appsRoot,
    name: APP,
    proxyRoot: fixture.proxyRoot,
    cronDir: fixture.cronDir,
    confirmation: APP,
    runCommand: fixture.runCommand,
    ...extra,
  });
}

/** Every backup file sitting in the apps root. */
function backups(appsRoot: string): string[] {
  return readdirSync(appsRoot).filter((entry) => entry.endsWith('.bak'));
}

describe('what uninstall removes', () => {
  it('removes the deploy root, the compose project and the vhost', async () => {
    const fixture = deployment();

    const result = await uninstall(fixture);

    // The compose project, through the SAME invocation install.ts builds -
    // `-p <name>` plus base, prod and vps in that order. Asserted as the exact
    // argv because the project name is what keeps two apps on one box apart,
    // and `-v` is what makes this a removal rather than a stop.
    expect(fixture.seen).toContainEqual(
      composeArgv(APP, ['down', '-v', '--remove-orphans']),
    );

    // The deploy root, with everything in it.
    expect(existsSync(fixture.deployRoot)).toBe(false);
    for (const gone of ['repo', '.env', 'logs', 'data', 'deploy-info']) {
      expect(existsSync(join(fixture.deployRoot, gone))).toBe(false);
    }
    expect(existsSync(deployStatePath(fixture.deployRoot))).toBe(false);

    // The vhost, and the proxy reloaded so the removal takes effect.
    expect(existsSync(vhostPath({ domain: DOMAIN, bindPort: 3535, proxyRoot: fixture.proxyRoot }))).toBe(
      false,
    );
    expect(fixture.seen).toContainEqual(['docker', 'exec', 'proxy-nginx', 'nginx', '-t']);
    expect(fixture.seen).toContainEqual(['docker', 'exec', 'proxy-nginx', 'nginx', '-s', 'reload']);

    // And the certificate renewal cron this app wrote.
    expect(existsSync(renewalCronPath(APP, fixture.cronDir))).toBe(false);

    expect(result.dryRun).toBe(false);
    expect(result.name).toBe(APP);
  });

  it('removes the vhost by its exact path, never by a glob over conf.d', async () => {
    const fixture = deployment();
    // A neighbouring app's vhost in the same shared directory.
    const neighbour = join(fixture.proxyRoot, 'nginx', 'conf.d', 'other.example.test.conf');
    writeFileSync(neighbour, renderVhost({ domain: 'other.example.test', bindPort: 3600, proxyRoot: fixture.proxyRoot }));

    await uninstall(fixture);

    expect(existsSync(neighbour)).toBe(true);
  });
});

// =============================================================================
// The four deliberate refusals - the point of issue #261
// =============================================================================

describe('the four deliberate refusals', () => {
  it('never runs dropdb: the database is validated by deploy and managed by the operator', async () => {
    const fixture = deployment();

    const result = await uninstall(fixture);

    // Not run, under any argv shape, ever. The database usually lives on
    // another host and holds the data this deployment exists to serve;
    // docs/specs/vps-deploy.md decision 4 is that deploy validates it and
    // never manages it, and #238's `CREATE DATABASE` has no symmetric drop.
    expect(fixture.seen.flat()).not.toContain('dropdb');
    expect(fixture.seen.flat().join(' ')).not.toMatch(/DROP DATABASE/i);

    // It is PRINTED instead, built from the .env read before anything was
    // deleted - after which nothing is left that knows the database's name.
    expect(result.databaseCommand).toBe('dropdb -h db.internal -p 5432 -U app appdb');
    // And with no password in it: a connection string on a command line is a
    // credential in the shell history of whoever pastes it.
    expect(result.databaseCommand).not.toContain('s3cret-value');
  });

  it('never removes the devnet network, which is shared with every other app', async () => {
    const fixture = deployment();

    const result = await uninstall(fixture);

    expect(fixture.seen.map((argv) => argv.join(' '))).not.toContainEqual(
      expect.stringContaining('network rm'),
    );
    expect(fixture.seen.flat()).not.toContain('devnet');
    expect(result.kept.map((item) => item.target)).toContain('devnet (docker network)');
  });

  it('never stops, restarts or removes the shared proxy container - it only reloads it', async () => {
    const fixture = deployment();

    await uninstall(fixture);

    const proxyCommands = fixture.seen.filter((argv) => argv.includes('proxy-nginx'));
    expect(proxyCommands.length).toBeGreaterThan(0);
    // `nginx -s reload` keeps every OTHER site on this box serving; a stop, a
    // restart or an `rm` takes them all down with this one.
    for (const argv of proxyCommands) {
      expect(argv.slice(0, 2)).toEqual(['docker', 'exec']);
    }
    expect(fixture.seen.map((argv) => argv.join(' '))).not.toContainEqual(
      expect.stringMatching(/docker (stop|restart|rm|kill)/),
    );
  });

  it("never removes a certificate without --certs: Let's Encrypt allows 5 duplicates a week", async () => {
    const fixture = deployment();
    const live = join(fixture.proxyRoot, 'letsencrypt', 'live', DOMAIN, 'fullchain.pem');

    const result = await uninstall(fixture);

    // An operator iterating on a broken install who destroys and re-requests
    // a certificate each time locks themselves out of their own domain for a
    // week - and re-issuing is exactly what the next install does.
    expect(existsSync(live)).toBe(true);
    expect(fixture.seen.flat()).not.toContain('certbot/certbot');
    expect(fixture.seen.flat()).not.toContain('delete');
    expect(
      result.kept.find((item) => item.target.includes('certificate'))?.reason,
    ).toMatch(/5 duplicate certificates per week/);
  });
});

// =============================================================================
// The renewal cron: shared infrastructure wearing a per-app filename (#261)
// =============================================================================
//
// `renderRenewalCron` emits `deploy certs renew --all` on purpose, so the LAST
// surviving entry is renewing every other app's certificates too. These three
// tests are the difference between removing one of several and removing the
// only one.
// =============================================================================

describe('the certificate renewal cron', () => {
  it('removes this app\'s entry with no warning while another entry still renews the proxy', async () => {
    const fixture = deployment();
    // A neighbouring app's entry. Its line carries `--all`, so it is already
    // renewing this proxy's whole set - nothing stops when ours goes.
    writeFileSync(renewalCronPath('other-app', fixture.cronDir), '# cron\n', { mode: 0o644 });

    const result = await uninstall(fixture);

    expect(existsSync(renewalCronPath(APP, fixture.cronDir))).toBe(false);
    expect(existsSync(renewalCronPath('other-app', fixture.cronDir))).toBe(true);
    expect(result.removed.some((item) => item.kind === 'cron' && item.existed)).toBe(true);
    expect(result.warnings.join('\n')).not.toMatch(/renewal/i);
  });

  it('warns loudly when it removes the LAST entry, because renewal then stops for EVERY app on the box', async () => {
    // The failure this prevents: an operator running 8-10 apps on one server
    // uninstalls one, and 60-90 days later every certificate behind the shared
    // proxy expires at once with nothing connecting it to that uninstall.
    const fixture = deployment();
    // A second installed app, so there is a real deployment to suggest - but
    // NO second cron entry, which is exactly the dangerous shape: coverage for
    // that app depends on the entry being removed here.
    const survivor = join(fixture.appsRoot, 'keeper');
    mkdirSync(survivor, { recursive: true });
    writeState({
      version: DEPLOY_STATE_VERSION,
      repoUrl: 'https://example.test/o/keeper.git',
      ref: 'main',
      commitSha: 'b'.repeat(40),
      bindPort: 3600,
      deployRoot: survivor,
      name: 'keeper',
      appsRoot: fixture.appsRoot,
      installedAt: '2026-01-01T00:00:00.000Z',
      lastDeployedAt: '2026-01-01T00:00:00.000Z',
      lastCommand: 'install',
      appctlVersion: '1.3.1',
    });

    const result = await uninstall(fixture);

    // Removed, not left: the line names a deploy root this run just deleted,
    // so leaving it would mean a cron that fails on every run from now on.
    expect(existsSync(renewalCronPath(APP, fixture.cronDir))).toBe(false);

    const warning = result.warnings.join('\n');
    // Reflowed before matching: the message is hard-wrapped for a terminal, and
    // a test that pins the wrap POINTS would break every time a word changes
    // length while saying nothing about whether the meaning survived.
    const prose = warning.replace(/\s+/g, ' ');
    // It says renewal STOPPED...
    expect(prose).toMatch(/automatic certificate renewal has STOPPED/);
    // ...that it is not limited to the app just removed...
    expect(prose).toContain('EVERY certificate behind the shared proxy');
    // ...and hands over a command naming a REAL surviving deployment, so it
    // can be pasted rather than filled in.
    expect(prose).toContain(
      `${CLI_NAME} deploy certs renew --install-cron --apps-root ${fixture.appsRoot} --name keeper`,
    );
    // Never the app being removed - that deploy root is gone.
    expect(prose).not.toContain(`--name ${APP}`);
  });

  it('says there is nothing to reinstate from when this was the only app', async () => {
    const fixture = deployment();

    const result = await uninstall(fixture);

    const prose = result.warnings.join('\n').replace(/\s+/g, ' ');
    expect(prose).toMatch(/automatic certificate renewal has STOPPED/);
    // No placeholder command that cannot work: there is no surviving
    // deployment to point `--name` at.
    expect(prose).not.toContain('certs renew --install-cron');
    expect(prose).toContain('--install-cron');
    expect(prose).toContain('There is no other deployment under');
  });

  it('never suggests a survivor that has no state file, because the command would fail (#285)', async () => {
    // `listInstalledApps` now also reports deployments recognised by evidence
    // alone, which is right for discovery and wrong here: the pasteable
    // command resolves its certificate lineage from the survivor's RECORDED
    // domain, and an unrecorded deployment has none. This caller is narrowed
    // to a recorded survivor on purpose.
    const fixture = deployment();
    const survivor = join(fixture.appsRoot, 'keeper');
    mkdirSync(join(survivor, 'repo', '.git'), { recursive: true });
    writeFileSync(join(survivor, '.env'), 'APP_BIND_PORT=3600\n', { mode: 0o600 });

    const result = await uninstall(fixture);

    const prose = result.warnings.join('\n').replace(/\s+/g, ' ');
    expect(prose).toMatch(/automatic certificate renewal has STOPPED/);
    expect(prose).not.toContain('--name keeper');
    // It falls through to the honest "nothing to point at" branch instead of
    // printing a command that answers "is not published under a domain".
    expect(prose).toContain('There is no other deployment under');
  });

  it('warns under --dry-run too, before the operator has committed to anything', async () => {
    const fixture = deployment();
    const before = snapshot(fixture);

    const result = await uninstall(fixture, { dryRun: true });

    // Still untouched, still no subprocess - the warning costs nothing.
    expect(fixture.seen).toEqual([]);
    expect(snapshot(fixture)).toEqual(before);
    expect(existsSync(renewalCronPath(APP, fixture.cronDir))).toBe(true);
    // Deciding WHETHER to uninstall is exactly when this needs to be known.
    expect(result.warnings.join('\n')).toMatch(/automatic certificate renewal has STOPPED/);
  });

  it('says nothing when this app never had an entry, because nothing stopped', async () => {
    const fixture = deployment();
    rmSync(renewalCronPath(APP, fixture.cronDir));

    const result = await uninstall(fixture);

    // An app installed with --no-install-cron, or one that never issued a
    // certificate. There was no coverage to lose.
    expect(result.warnings.join('\n')).not.toMatch(/renewal/i);
  });
});

describe('--certs', () => {
  it('deletes the certificate through certbot, which knows all three of its trees', async () => {
    const fixture = deployment();

    await uninstall(fixture, { certs: true });

    const certbot = fixture.seen.find((argv) => argv.includes('certbot/certbot'));
    expect(certbot).toBeDefined();
    // `delete --cert-name` rather than rm -rf into letsencrypt/live: that
    // directory is three linked trees, and a partial removal leaves certbot
    // unable to renew OR reissue for the name.
    expect(certbot).toContain('delete');
    expect(certbot).toContain('--cert-name');
    expect(certbot).toContain(DOMAIN);
  });

  it('does not fail the whole removal when there is no certificate to delete', async () => {
    const fixture = deployment();
    const failing = (async (argv: readonly string[], runOptions: RunCommandOptions) => {
      if (argv.includes('certbot/certbot')) throw new Error('No certificate found with name');
      return await fixture.runCommand(argv, runOptions);
    }) as typeof import('./executor.js').runCommand;

    const result = await uninstall(fixture, { certs: true, runCommand: failing });

    expect(existsSync(fixture.deployRoot)).toBe(false);
    expect(result.warnings.join('\n')).toContain('No certificate found');
  });
});

describe('--dry-run', () => {
  it('writes nothing, changes no docker state, and lists the paths', async () => {
    const fixture = deployment();
    const before = snapshot(fixture);

    const result = await uninstall(fixture, { dryRun: true });

    // Zero docker state changes: not one subprocess was started at all.
    expect(fixture.seen).toEqual([]);
    // Zero writes - including the journal, which `openJournal` would have
    // created two files for before the first line was written.
    expect(snapshot(fixture)).toEqual(before);

    expect(result.dryRun).toBe(true);
    const targets = result.removed.map((item) => item.target);
    expect(targets).toContain(join(fixture.deployRoot, 'repo'));
    expect(targets).toContain(envFilePath(fixture.deployRoot));
    expect(targets).toContain(join(fixture.deployRoot, 'logs'));
    expect(targets).toContain(deployStatePath(fixture.deployRoot));
    expect(targets).toContain(vhostPath({ domain: DOMAIN, bindPort: 3535, proxyRoot: fixture.proxyRoot }));
    expect(targets).toContain(renewalCronPath(APP, fixture.cronDir));
    expect(targets.join('\n')).toContain('down -v --remove-orphans');
    // No journal was opened, so there is no path to report.
    expect(result.journalPath).toBeUndefined();
  });

  it('needs no confirmation, because it destroys nothing', async () => {
    const fixture = deployment();

    await expect(
      runUninstall({
        appsRoot: fixture.appsRoot,
        name: APP,
        proxyRoot: fixture.proxyRoot,
        cronDir: fixture.cronDir,
        dryRun: true,
        nonInteractive: true,
        runCommand: fixture.runCommand,
      }),
    ).resolves.toMatchObject({ dryRun: true });
  });
});

/** Every path under the apps root, with its size - the whole world this test owns. */
function snapshot(fixture: Deployment): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(`${path}/`);
        walk(path);
      } else {
        out.push(`${path} ${statSync(path).size}`);
      }
    }
  };
  walk(fixture.appsRoot);
  return out;
}

describe('the .env backup', () => {
  it('is written outside the deploy root, 0600, before the deletion', async () => {
    const fixture = deployment();
    const original = readFileSync(envFilePath(fixture.deployRoot), 'utf8');

    const result = await uninstall(fixture);

    expect(result.envBackupPath).toBeDefined();
    const path = result.envBackupPath as string;
    // OUTSIDE the directory being removed, or it is not a backup. A sibling
    // of the app folder, in the apps root.
    expect(path.startsWith(`${fixture.deployRoot}/`)).toBe(false);
    expect(path.startsWith(`${fixture.appsRoot}/`)).toBe(true);
    expect(path).toMatch(/demo\.env\..+\.bak$/);

    expect(existsSync(path)).toBe(true);
    // Byte-for-byte, including the secret nothing else on this server holds.
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('is still taken with --keep-env, and the .env stays where it is', async () => {
    const fixture = deployment();

    const result = await uninstall(fixture, { keepEnv: true });

    expect(existsSync(envFilePath(fixture.deployRoot))).toBe(true);
    expect(readFileSync(envFilePath(fixture.deployRoot), 'utf8')).toContain('POSTGRES_DB=appdb');
    // The directory survives precisely because something was kept in it.
    expect(existsSync(fixture.deployRoot)).toBe(true);
    // Everything else went.
    expect(existsSync(join(fixture.deployRoot, 'repo'))).toBe(false);
    expect(existsSync(deployStatePath(fixture.deployRoot))).toBe(false);
    // Keeping and copying are not alternatives.
    expect(backups(fixture.appsRoot).length).toBe(1);
    expect(result.kept.map((item) => item.target)).toContain(envFilePath(fixture.deployRoot));
  });

  it('reports no backup when there is no .env, rather than failing', async () => {
    const fixture = deployment();
    await uninstall(fixture, { keepEnv: false });
    // Second pass over what is now nothing at all.
    const result = await runUninstall({
      appsRoot: fixture.appsRoot,
      deployRoot: fixture.deployRoot,
      name: APP,
      proxyRoot: fixture.proxyRoot,
      cronDir: fixture.cronDir,
      confirmation: APP,
      runCommand: fixture.runCommand,
    });
    expect(result.envBackupPath).toBeUndefined();
  });
});

describe('a half-removed deployment', () => {
  it('uninstalls cleanly when the clone (and so the compose files) is gone', async () => {
    const fixture = deployment({ clone: false });

    const result = await uninstall(fixture);

    // No compose invocation was even attempted - it could not have worked.
    expect(fixture.seen.map((argv) => argv.join(' '))).not.toContainEqual(
      expect.stringContaining('docker compose'),
    );
    // But the run completed, and said what the operator now has to finish.
    expect(existsSync(fixture.deployRoot)).toBe(false);
    expect(result.warnings.join('\n')).toContain('com.docker.compose.project=demo');
  });

  it('uninstalls cleanly when the deploy root is gone entirely', async () => {
    const fixture = deployment();
    // Everything this CLI wrote, removed by hand - the improvised `rm -rf`
    // this command exists to replace.
    await uninstall(fixture);

    const result = await runUninstall({
      appsRoot: fixture.appsRoot,
      deployRoot: fixture.deployRoot,
      name: APP,
      proxyRoot: fixture.proxyRoot,
      cronDir: fixture.cronDir,
      confirmation: APP,
      runCommand: fixture.runCommand,
    });

    expect(result.removed.some((item) => item.target === fixture.deployRoot && !item.existed)).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('removes a deployment whose state file this build cannot read', async () => {
    const fixture = deployment();
    writeFileSync(deployStatePath(fixture.deployRoot), '{ not json');

    // A deployment with a broken state file is precisely the one somebody
    // most wants to be rid of; refusing would leave no way out but `rm -rf`.
    await uninstall(fixture);

    expect(existsSync(fixture.deployRoot)).toBe(false);
  });

  it('skips the vhost step for a deployment that was never published', async () => {
    const fixture = deployment({ domain: '' });

    const result = await uninstall(fixture);

    expect(existsSync(fixture.deployRoot)).toBe(false);
    expect(result.removed.some((item) => item.kind === 'vhost')).toBe(false);
  });
});

describe('the typed confirmation', () => {
  it('refuses under --non-interactive when --confirm is missing', async () => {
    const fixture = deployment();

    const error = await runUninstall({
      appsRoot: fixture.appsRoot,
      name: APP,
      proxyRoot: fixture.proxyRoot,
      cronDir: fixture.cronDir,
      nonInteractive: true,
      runCommand: fixture.runCommand,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain(`--confirm ${APP}`);
    // Nothing ran, and nothing was removed: the refusal is before the pipeline.
    expect(fixture.seen).toEqual([]);
    expect(existsSync(fixture.deployRoot)).toBe(true);
    expect(backups(fixture.appsRoot)).toEqual([]);
  });

  it('refuses a --confirm that names a different app', async () => {
    const fixture = deployment();

    const error = await runUninstall({
      appsRoot: fixture.appsRoot,
      name: APP,
      proxyRoot: fixture.proxyRoot,
      cronDir: fixture.cronDir,
      confirmation: 'something-else',
      nonInteractive: true,
      runCommand: fixture.runCommand,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UsageError);
    expect(existsSync(fixture.deployRoot)).toBe(true);
  });

  it('is the app name and not y/N, and not satisfied by a missing terminal', async () => {
    // The API's own convention for a destructive action: `confirmation:
    // "RESTORE"`, `"ROLLBACK"`, `"REMOVE"`, the Danger Zone's uppercased
    // scope. A `y` is not an authorisation here.
    for (const typed of ['y', 'yes', 'Y', 'DEMO', '']) {
      await expect(
        requireConfirmation({ name: APP, deployRoot: '/x', confirmation: typed, nonInteractive: true }),
      ).rejects.toBeInstanceOf(UsageError);
    }
    await expect(
      requireConfirmation({ name: APP, deployRoot: '/x', confirmation: APP }),
    ).resolves.toBeUndefined();

    // No flag and no TTY: refused, never defaulted.
    await expect(
      requireConfirmation({
        name: APP,
        deployRoot: '/x',
        promptContext: { input: { isTTY: false } as NodeJS.ReadStream },
      }),
    ).rejects.toBeInstanceOf(UsageError);
  });
});

describe('dropDatabaseCommand', () => {
  it('omits the parts the .env does not carry, and answers nothing with no database', () => {
    expect(dropDatabaseCommand(new Map([['POSTGRES_DB', 'appdb']]))).toBe('dropdb appdb');
    expect(dropDatabaseCommand(new Map([['POSTGRES_HOST', 'db']]))).toBeUndefined();
    expect(dropDatabaseCommand(new Map())).toBeUndefined();
  });
});

// =============================================================================
// `install --fresh`  (part 2 of issue #261)
// =============================================================================

describe('install --fresh', () => {
  it('discards the prior .env, state file and deploy-info, and backs the .env up', async () => {
    const vps: FakeVps = await fakeVps({ remoteSha: 'c'.repeat(40) });
    vi.stubGlobal('fetch', healthyFetch());
    try {
      const fixture = deployment();
      // The #259 shape exactly: a `.env` that survived and must not be reused.
      writeFileSync(envFilePath(fixture.deployRoot), 'POSTGRES_PASSWORD=corrupt-and-kept\n', {
        mode: 0o600,
      });
      const progress: string[] = [];

      const options: InstallOptions = {
        appsRoot: fixture.appsRoot,
        deployRoot: fixture.deployRoot,
        name: APP,
        bindPort: 3535,
        proxyRoot: fixture.proxyRoot,
        domain: DOMAIN,
        repo: 'https://example.test/o/demo.git',
        ref: 'main',
        runCommand: vps.runCommand,
        cwd: fixture.deployRoot,
        nonInteractive: true,
        answers: vps.answers(),
        promptContext: silentPrompt(),
        skipDoctor: true,
        skipProxy: true,
        skipSeed: true,
        fresh: true,
        hooks: { onProgress: (message: string) => void progress.push(message) },
      };

      // --fresh implies --reinstall: the state file it just discarded must
      // not then be the reason the install refuses.
      await runInstall(options);

      // The old value is gone; the wizard's answer is what landed.
      const written = readFileSync(envFilePath(fixture.deployRoot), 'utf8');
      expect(written).not.toContain('corrupt-and-kept');
      expect(written).toContain('POSTGRES_PASSWORD=not-the-default-password');

      // And the discarded one was copied out first, outside the deploy root.
      const copies = backups(fixture.appsRoot);
      expect(copies.length).toBe(1);
      const copy = join(fixture.appsRoot, copies[0] as string);
      expect(readFileSync(copy, 'utf8')).toBe('POSTGRES_PASSWORD=corrupt-and-kept\n');
      expect(statSync(copy).mode & 0o777).toBe(0o600);
      expect(progress.some((message) => message.includes('Backed up the previous .env'))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      await vps.close();
    }
  });

  it('leaves the proxy vhost and the certificate alone - that is what uninstall is for', async () => {
    const vps: FakeVps = await fakeVps({ remoteSha: 'c'.repeat(40) });
    vi.stubGlobal('fetch', healthyFetch());
    try {
      const fixture = deployment();
      const vhost = vhostPath({ domain: DOMAIN, bindPort: 3535, proxyRoot: fixture.proxyRoot });
      const live = join(fixture.proxyRoot, 'letsencrypt', 'live', DOMAIN, 'fullchain.pem');

      await runInstall({
        appsRoot: fixture.appsRoot,
        deployRoot: fixture.deployRoot,
        name: APP,
        bindPort: 3535,
        proxyRoot: fixture.proxyRoot,
        domain: DOMAIN,
        repo: 'https://example.test/o/demo.git',
        ref: 'main',
        runCommand: vps.runCommand,
        cwd: fixture.deployRoot,
        nonInteractive: true,
        answers: vps.answers(),
        promptContext: silentPrompt(),
        skipDoctor: true,
        skipProxy: true,
        skipSeed: true,
        fresh: true,
      });

      expect(existsSync(vhost)).toBe(true);
      expect(existsSync(live)).toBe(true);
      // The clone is not discarded either: `--fresh` is about this app's own
      // local STATE, and a checkout is re-fetched in the ordinary way.
      expect(existsSync(composeEnvPath(fixture.deployRoot))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      await vps.close();
    }
  });
});

describe(`\`${CLI_NAME} deploy uninstall\` resilience contract`, () => {
  it('reports every refusal on every run, including the ones with nothing to say', async () => {
    const fixture = deployment({ domain: '' });

    const result = await uninstall(fixture);

    // An operator who has just removed a deployment is exactly the person
    // about to assume the database went with it.
    const targets = result.kept.map((item) => item.target).join('\n');
    expect(targets).toContain('appdb');
    expect(targets).toContain('devnet');
    expect(targets).toContain('proxy-nginx');
  });
});
