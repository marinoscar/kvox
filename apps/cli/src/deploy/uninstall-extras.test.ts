import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { UsageError } from '../errors.js';
import { envFilePath } from './env-file.js';
import type { CommandResult, RunCommandOptions } from './executor.js';
import { renderVhost, renewalCronPath, vhostPath } from './proxy.js';
import { APP_KEY_PREFIXES } from './storage-purge.js';
import { DEPLOY_STATE_VERSION, writeState, type DeployState } from './state.js';
import { populateClone } from './testing/fake-vps.js';
import { runUninstall } from './uninstall.js';

// =============================================================================
// `uninstall --drop-database` and `--purge-storage`  (issue #268)
// =============================================================================
//
// A SEPARATE FILE FROM `uninstall.test.ts` ON PURPOSE. That file pins #261's
// four deliberate refusals, and every one of those assertions must keep
// passing UNMODIFIED once these two extras exist - a refusal that only holds
// while nobody asked for the opposite is not a refusal. Keeping the two suites
// apart makes "the old file was not touched" checkable at a glance.
//
// The fake here is a PROGRAMMABLE `runCommand` rather than the recorder
// `uninstall.test.ts` uses, because these paths READ: the purge decides what
// to delete from what `aws s3api` answered, and the drop branches on what
// `psql` put on stderr. A recorder that always answers empty would make every
// test below pass against a purge that deleted nothing.
// =============================================================================

const APP = 'demo';
const DOMAIN = 'app.example.test';
const BUCKET = 'demo-bucket';
const DATABASE = 'appdb';

/** One `aws`/`psql` answer, matched against the argv. */
interface Reply {
  /**
   * Every one of these must appear in the argv for the reply to be used, and
   * the FIRST matching reply wins.
   *
   * ⚠ Match on a substring that tells the two `pg_stat_activity` statements
   * APART. The inventory read is `count(*) from pg_stat_activity …`; the
   * terminate is `count(*) from (select pg_terminate_backend(pid) from
   * pg_stat_activity …)`. A reply matching the bare table name answers both,
   * which silently turns "the termination failed" into "it returned a count"
   * and tests the wrong branch.
   */
  match: string[];
  stdout?: string;
  stderr?: string;
  /** A non-zero exit, i.e. `runPsql`/`runAws` see `ok: false`. */
  fail?: boolean;
}

interface Fixture {
  appsRoot: string;
  deployRoot: string;
  proxyRoot: string;
  cronDir: string;
  seen: string[][];
  runCommand: typeof import('./executor.js').runCommand;
}

/** Every argv the run issued that reached `aws`, in order. */
function awsCalls(fixture: Fixture): string[][] {
  return fixture.seen.filter((argv) => argv.includes('s3api'));
}

/** Every `delete-objects` argv, i.e. every destructive storage call. */
function deleteCalls(fixture: Fixture): string[][] {
  return fixture.seen.filter((argv) => argv.includes('delete-objects'));
}

/** Every key any `delete-objects` call named, flattened. */
function deletedKeys(fixture: Fixture): string[] {
  const keys: string[] = [];
  for (const argv of deleteCalls(fixture)) {
    const at = argv.indexOf('--delete');
    const payload = JSON.parse(argv[at + 1] ?? '{}') as {
      Objects?: { Key: string; VersionId?: string }[];
    };
    for (const entry of payload.Objects ?? []) keys.push(entry.Key);
  }
  return keys;
}

/** Every version id any `delete-objects` call named. */
function deletedVersions(fixture: Fixture): string[] {
  const ids: string[] = [];
  for (const argv of deleteCalls(fixture)) {
    const at = argv.indexOf('--delete');
    const payload = JSON.parse(argv[at + 1] ?? '{}') as {
      Objects?: { Key: string; VersionId?: string }[];
    };
    for (const entry of payload.Objects ?? []) {
      if (entry.VersionId !== undefined) ids.push(entry.VersionId);
    }
  }
  return ids;
}

/** Every SQL statement `psql` was handed, in order. */
function sql(fixture: Fixture): string[] {
  return fixture.seen
    .filter((argv) => argv.includes('-tAc'))
    .map((argv) => argv[argv.indexOf('-tAc') + 1] ?? '');
}

function deployment(replies: Reply[] = [], options: { env?: string[] } = {}): Fixture {
  const appsRoot = mkdtempSync(join(tmpdir(), 'appctl-extras-'));
  const deployRoot = join(appsRoot, APP);
  const proxyRoot = join(appsRoot, 'proxy');
  const cronDir = join(appsRoot, 'cron.d');

  mkdirSync(join(deployRoot, 'logs'), { recursive: true });
  mkdirSync(join(deployRoot, 'deploy-info'), { recursive: true });
  writeFileSync(join(deployRoot, 'deploy-info', 'info.json'), '{}\n');
  populateClone(join(deployRoot, 'repo'));

  writeFileSync(
    envFilePath(deployRoot),
    (
      options.env ?? [
        'POSTGRES_HOST=db.internal',
        'POSTGRES_PORT=5432',
        'POSTGRES_USER=app',
        'POSTGRES_PASSWORD=s3cret-value',
        `POSTGRES_DB=${DATABASE}`,
        `S3_BUCKET=${BUCKET}`,
        'S3_REGION=eu-west-1',
        'AWS_ACCESS_KEY_ID=AKIAEXAMPLE',
        'AWS_SECRET_ACCESS_KEY=shhh',
      ]
    ).join('\n') + '\n',
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
    appctlVersion: '1.4.0',
    domain: DOMAIN,
  };
  writeState(state);

  mkdirSync(join(proxyRoot, 'nginx', 'conf.d'), { recursive: true });
  writeFileSync(
    vhostPath({ domain: DOMAIN, bindPort: 3535, proxyRoot }),
    renderVhost({ domain: DOMAIN, bindPort: 3535, proxyRoot }),
    { mode: 0o644 },
  );
  mkdirSync(join(proxyRoot, 'letsencrypt', 'live', DOMAIN), { recursive: true });
  writeFileSync(join(proxyRoot, 'letsencrypt', 'live', DOMAIN, 'fullchain.pem'), 'PEM\n');
  mkdirSync(cronDir, { recursive: true });
  writeFileSync(renewalCronPath(APP, cronDir), '# cron\n', { mode: 0o644 });

  const seen: string[][] = [];
  const runCommand = (async (
    argv: readonly string[],
    runOptions: RunCommandOptions,
  ): Promise<CommandResult> => {
    seen.push([...argv]);
    const reply = replies.find((candidate) =>
      candidate.match.every((needle) => argv.some((item) => item.includes(needle))),
    );
    const result: CommandResult = {
      argv: [...argv],
      cwd: runOptions.cwd,
      exitCode: reply?.fail === true ? 1 : 0,
      stdout: reply?.stdout ?? '',
      stderr: reply?.stderr ?? '',
      durationMs: 1,
      timedOut: false,
    };
    if (reply?.fail === true) {
      // `runPsql`/`runAws` read `error.result`; `executor.ts` throws this shape.
      throw Object.assign(new Error(`exited 1`), { result });
    }
    return result;
  }) as typeof import('./executor.js').runCommand;

  return { appsRoot, deployRoot, proxyRoot, cronDir, seen, runCommand };
}

function uninstall(fixture: Fixture, extra: Record<string, unknown> = {}) {
  return runUninstall({
    appsRoot: fixture.appsRoot,
    name: APP,
    proxyRoot: fixture.proxyRoot,
    cronDir: fixture.cronDir,
    confirmation: APP,
    nonInteractive: true,
    runCommand: fixture.runCommand,
    ...extra,
  });
}

// -----------------------------------------------------------------------------
// The canned S3 answers. `aws` aggregates its own pages, so one document each.
// -----------------------------------------------------------------------------

/** A bucket holding two of ours and one stranger's prefix, plus a loose key. */
const SHARED_BUCKET: Reply[] = [
  { match: ['get-bucket-versioning'], stdout: '{}' },
  {
    match: ['list-objects-v2', '--delimiter'],
    stdout: JSON.stringify({
      CommonPrefixes: [
        { Prefix: 'uploads/' },
        { Prefix: 'transcripts/' },
        { Prefix: 'someone-elses-app/' },
      ],
      Contents: [{ Key: 'README.txt', Size: 12 }],
    }),
  },
  {
    match: ['list-objects-v2', 'uploads/'],
    stdout: JSON.stringify({
      Contents: [
        { Key: 'uploads/2026/a.bin', Size: 1000 },
        { Key: 'uploads/2026/b.bin', Size: 2000 },
      ],
    }),
  },
  {
    match: ['list-objects-v2', 'transcripts/'],
    stdout: JSON.stringify({ Contents: [{ Key: 'transcripts/x/raw.json.gz', Size: 500 }] }),
  },
];

/** The same bucket with versioning on: two versions and one delete marker. */
const VERSIONED_BUCKET: Reply[] = [
  { match: ['get-bucket-versioning'], stdout: JSON.stringify({ Status: 'Enabled' }) },
  {
    match: ['list-objects-v2', '--delimiter'],
    stdout: JSON.stringify({ CommonPrefixes: [{ Prefix: 'uploads/' }] }),
  },
  {
    match: ['list-object-versions', 'uploads/'],
    stdout: JSON.stringify({
      Versions: [
        { Key: 'uploads/a.bin', VersionId: 'v2', Size: 10, IsLatest: true },
        { Key: 'uploads/a.bin', VersionId: 'v1', Size: 10, IsLatest: false },
      ],
      DeleteMarkers: [{ Key: 'uploads/gone.bin', VersionId: 'dm1' }],
    }),
  },
];

/** A database that reads cleanly and drops on the first try. */
const HEALTHY_DATABASE: Reply[] = [
  { match: ['pg_size_pretty'], stdout: '42 MB' },
  { match: ['count(*) from pg_stat_activity'], stdout: '0' },
];

// =============================================================================
// 2. The confirmation cannot cross between resources — the point of #268
// =============================================================================

describe('a confirmation naming one resource never authorises the other', () => {
  it('refuses to drop the database when the typed name is the BUCKET\'s', async () => {
    const fixture = deployment([...SHARED_BUCKET, ...HEALTHY_DATABASE]);

    await expect(
      uninstall(fixture, {
        dropDatabase: true,
        // The bucket's real name, typed at the database's confirmation.
        confirmDatabase: BUCKET,
      }),
    ).rejects.toBeInstanceOf(UsageError);

    // And absolutely nothing ran: the refusal happens before the pipeline.
    expect(sql(fixture).some((statement) => statement.startsWith('DROP DATABASE'))).toBe(false);
    expect(existsSync(fixture.deployRoot)).toBe(true);
  });

  it('refuses to purge the bucket when the typed name is the DATABASE\'s', async () => {
    const fixture = deployment([...SHARED_BUCKET, ...HEALTHY_DATABASE]);

    await expect(
      uninstall(fixture, { purgeStorage: true, confirmBucket: DATABASE }),
    ).rejects.toBeInstanceOf(UsageError);

    expect(deleteCalls(fixture)).toEqual([]);
    expect(existsSync(fixture.deployRoot)).toBe(true);
  });

  it('refuses when the APP name is typed at a resource confirmation', async () => {
    const fixture = deployment([...SHARED_BUCKET]);

    // The one an operator would actually reach for, having just typed it.
    await expect(
      uninstall(fixture, { purgeStorage: true, confirmBucket: APP }),
    ).rejects.toThrow(/does not name the bucket/);
  });

  it('drops only with the flag AND the database\'s own name', async () => {
    const withoutFlag = deployment([...HEALTHY_DATABASE]);
    await uninstall(withoutFlag, { confirmDatabase: DATABASE });
    expect(sql(withoutFlag).some((statement) => statement.startsWith('DROP DATABASE'))).toBe(false);

    const withBoth = deployment([...HEALTHY_DATABASE]);
    await uninstall(withBoth, { dropDatabase: true, confirmDatabase: DATABASE });
    expect(sql(withBoth)).toContain(`DROP DATABASE "${DATABASE}"`);
  });

  it('purges only with the flag AND the bucket\'s own name', async () => {
    const withoutFlag = deployment([...SHARED_BUCKET]);
    await uninstall(withoutFlag, { confirmBucket: BUCKET });
    expect(awsCalls(withoutFlag)).toEqual([]);

    const withBoth = deployment([...SHARED_BUCKET]);
    await uninstall(withBoth, { purgeStorage: true, confirmBucket: BUCKET });
    expect(deletedKeys(withBoth).length).toBeGreaterThan(0);
  });
});

// =============================================================================
// 3. THE SHARED-BUCKET GUARD
// =============================================================================

describe('the shared-bucket guard: an object outside the six prefixes is reported, never deleted', () => {
  it('deletes only this application\'s prefixes and leaves a stranger\'s alone', async () => {
    const fixture = deployment([...SHARED_BUCKET]);

    const result = await uninstall(fixture, { purgeStorage: true, confirmBucket: BUCKET });

    // Everything ours, and nothing else.
    expect(deletedKeys(fixture).sort()).toEqual([
      'transcripts/x/raw.json.gz',
      'uploads/2026/a.bin',
      'uploads/2026/b.bin',
    ]);

    // THE GUARD. Not one delete call names the stranger's prefix or the loose
    // root object - not as a key, not as a prefix, not anywhere in the argv.
    for (const argv of deleteCalls(fixture)) {
      expect(argv.join(' ')).not.toContain('someone-elses-app');
      expect(argv.join(' ')).not.toContain('README.txt');
    }

    // And they were never even LISTED: the root read uses `--delimiter /`, so
    // somebody else's data is named without being enumerated.
    for (const argv of awsCalls(fixture)) {
      if (!argv.includes('--prefix')) continue;
      const prefix = argv[argv.indexOf('--prefix') + 1] ?? '';
      expect(APP_KEY_PREFIXES).toContain(prefix);
    }

    // Reported, by name, so the operator learns the bucket is shared.
    const foreign = result.storage?.inventory?.foreign ?? [];
    expect(foreign.map((entry) => entry.key).sort()).toEqual(['README.txt', 'someone-elses-app/']);
    expect(JSON.stringify(result.kept)).toContain('someone-elses-app/');
  });

  it('never deletes the bucket itself, and says so', async () => {
    const fixture = deployment([...SHARED_BUCKET]);

    const result = await uninstall(fixture, { purgeStorage: true, confirmBucket: BUCKET });

    expect(fixture.seen.some((argv) => argv.includes('delete-bucket'))).toBe(false);
    expect(result.kept.some((item) => item.target.includes(`the bucket ${BUCKET} itself`))).toBe(
      true,
    );
  });

  it('asks for exactly the six prefixes this application writes', () => {
    // Pinned as a list, because the failure mode of a MISSING entry is silent:
    // objects survive a purge the operator was told succeeded, and the only
    // symptom is a bill. `database-backups/` and not `backups/` - the latter
    // appears only in the API's own db-backup test fixtures.
    expect([...APP_KEY_PREFIXES]).toEqual([
      'avatars/',
      'database-backups/',
      'node-outputs/',
      'notes/',
      'transcripts/',
      'uploads/',
    ]);
  });
});

// =============================================================================
// 4. Versioned buckets
// =============================================================================

describe('a versioned bucket', () => {
  it('deletes every version and delete marker BY ID, so the bytes really go', async () => {
    const fixture = deployment([...VERSIONED_BUCKET]);

    const result = await uninstall(fixture, { purgeStorage: true, confirmBucket: BUCKET });

    // Both versions of the live object AND the stale delete marker. A plain
    // delete would have written a THIRD marker and kept all of it.
    expect(deletedVersions(fixture).sort()).toEqual(['dm1', 'v1', 'v2']);
    expect(result.storage?.inventory?.versioning).toBe('Enabled');
    // One current object, two extra entries behind it.
    expect(result.storage?.inventory?.objects).toBe(1);
    expect(result.storage?.inventory?.versions).toBe(2);
    // Nothing remains, so nothing is claimed to.
    expect(result.storage?.purge?.versionsRemain).toBeUndefined();
  });

  it('never issues a version-less delete on a versioned bucket', async () => {
    const fixture = deployment([...VERSIONED_BUCKET]);

    await uninstall(fixture, { purgeStorage: true, confirmBucket: BUCKET });

    for (const argv of deleteCalls(fixture)) {
      const payload = JSON.parse(argv[argv.indexOf('--delete') + 1] ?? '{}') as {
        Objects: { VersionId?: string }[];
      };
      for (const entry of payload.Objects) expect(entry.VersionId).toBeDefined();
    }
  });

  it('treats an unreadable versioning answer as versioned, never as off', async () => {
    const fixture = deployment([
      { match: ['get-bucket-versioning'], fail: true, stderr: 'AccessDenied' },
      {
        match: ['list-objects-v2', '--delimiter'],
        stdout: JSON.stringify({ CommonPrefixes: [{ Prefix: 'uploads/' }] }),
      },
      {
        match: ['list-object-versions', 'uploads/'],
        stdout: JSON.stringify({
          Versions: [{ Key: 'uploads/a.bin', VersionId: 'v1', Size: 1, IsLatest: true }],
        }),
      },
    ]);

    const result = await uninstall(fixture, { purgeStorage: true, confirmBucket: BUCKET });

    // Assuming the cheaper answer is exactly what leaves data behind a marker
    // while reporting "emptied".
    expect(result.storage?.inventory?.versioning).toBe('Unknown');
    expect(deletedVersions(fixture)).toEqual(['v1']);
  });

  it('says plainly that versions remain when a versioned prefix could not be emptied', async () => {
    const fixture = deployment([
      ...VERSIONED_BUCKET,
      { match: ['delete-objects'], fail: true, stderr: 'AccessDenied' },
    ]);

    const result = await uninstall(fixture, { purgeStorage: true, confirmBucket: BUCKET });

    expect(result.storage?.purge?.failures).toHaveLength(1);
    expect(result.storage?.purge?.versionsRemain).toMatch(/versioning Enabled/);
    expect(result.storage?.purge?.versionsRemain).toMatch(/still exist and are still billed/);
    // And it is a WARNING, not a failed uninstall: the deployment still went.
    expect(existsSync(fixture.deployRoot)).toBe(false);
    expect(result.warnings.join('\n')).toMatch(/could NOT be emptied/);
  });
});

// =============================================================================
// 5. --dry-run covers the extras
// =============================================================================

describe('--dry-run with both extras', () => {
  it('issues zero deletes, zero SQL writes, and prints the full inventory', async () => {
    const fixture = deployment([...SHARED_BUCKET, ...HEALTHY_DATABASE]);
    const before = snapshot(fixture.appsRoot);

    const result = await uninstall(fixture, {
      dryRun: true,
      dropDatabase: true,
      purgeStorage: true,
      confirmation: undefined,
    });

    // NOT ONE destructive call, of either kind.
    expect(deleteCalls(fixture)).toEqual([]);
    expect(sql(fixture).some((statement) => /^(DROP|SELECT PG_TERMINATE|select pg_terminate)/i.test(statement))).toBe(
      false,
    );
    expect(sql(fixture).some((statement) => statement.includes('pg_terminate_backend'))).toBe(false);
    // The compose project was not brought down either.
    expect(fixture.seen.some((argv) => argv.includes('down'))).toBe(false);
    // And nothing on disk moved - the recursive snapshot #261 established.
    expect(snapshot(fixture.appsRoot)).toEqual(before);

    // But the inventory is complete: per-prefix counts and bytes, the foreign
    // entries, the database's size and its open sessions.
    const storage = result.storage?.inventory;
    expect(storage?.prefixes).toEqual([
      { prefix: 'transcripts/', objects: 1, bytes: 500, versions: 0 },
      { prefix: 'uploads/', objects: 2, bytes: 3000, versions: 0 },
    ]);
    expect(storage?.objects).toBe(3);
    expect(storage?.bytes).toBe(3500);
    expect(storage?.foreign.map((entry) => entry.key).sort()).toEqual([
      'README.txt',
      'someone-elses-app/',
    ]);
    expect(result.database?.facts).toMatchObject({
      database: DATABASE,
      host: 'db.internal',
      port: '5432',
      size: '42 MB',
      connections: 0,
    });

    // And it says what it WOULD do.
    const targets = result.removed.map((item) => item.target).join('\n');
    expect(targets).toContain(`s3://${BUCKET}/uploads/ (2 key(s))`);
    expect(targets).toContain(`DROP DATABASE "${DATABASE}"`);
  });

  it('needs no confirmation of anything, because it destroys nothing', async () => {
    const fixture = deployment([...SHARED_BUCKET, ...HEALTHY_DATABASE]);

    await expect(
      runUninstall({
        appsRoot: fixture.appsRoot,
        name: APP,
        proxyRoot: fixture.proxyRoot,
        cronDir: fixture.cronDir,
        dryRun: true,
        nonInteractive: true,
        dropDatabase: true,
        purgeStorage: true,
        runCommand: fixture.runCommand,
      }),
    ).resolves.toMatchObject({ dryRun: true });
  });
});

// =============================================================================
// 6. --non-interactive refuses each extra separately
// =============================================================================

describe('--non-interactive without a confirmation', () => {
  it('refuses the database drop, naming the flag that would authorise it', async () => {
    const fixture = deployment([...HEALTHY_DATABASE]);

    await expect(uninstall(fixture, { dropDatabase: true })).rejects.toThrow(
      `--confirm-database ${DATABASE}`,
    );
    expect(sql(fixture).some((statement) => statement.startsWith('DROP DATABASE'))).toBe(false);
  });

  it('refuses the storage purge, naming the flag that would authorise it', async () => {
    const fixture = deployment([...SHARED_BUCKET]);

    await expect(uninstall(fixture, { purgeStorage: true })).rejects.toThrow(
      `--confirm-bucket ${BUCKET}`,
    );
    expect(deleteCalls(fixture)).toEqual([]);
  });

  it('refuses BOTH separately - one confirmation never covers two resources', async () => {
    const fixture = deployment([...SHARED_BUCKET, ...HEALTHY_DATABASE]);

    // The bucket is confirmed; the database is not. The run must still refuse.
    await expect(
      uninstall(fixture, { dropDatabase: true, purgeStorage: true, confirmBucket: BUCKET }),
    ).rejects.toThrow(`--confirm-database ${DATABASE}`);

    // And nothing happened at all: both confirmations precede the pipeline, so
    // a half-authorised run does not empty the half it was allowed to.
    expect(deleteCalls(fixture)).toEqual([]);
    expect(existsSync(fixture.deployRoot)).toBe(true);
  });
});

// =============================================================================
// 7. Ordering
// =============================================================================

describe('the ordering', () => {
  it('stops the containers before any purge or drop, and removes the deployment last', async () => {
    const fixture = deployment([...SHARED_BUCKET, ...HEALTHY_DATABASE]);

    await uninstall(fixture, {
      dropDatabase: true,
      confirmDatabase: DATABASE,
      purgeStorage: true,
      confirmBucket: BUCKET,
    });

    const down = fixture.seen.findIndex((argv) => argv.includes('down') && argv.includes('-v'));
    const firstDelete = fixture.seen.findIndex((argv) => argv.includes('delete-objects'));
    const drop = fixture.seen.findIndex((argv) =>
      argv.some((item) => item.startsWith('DROP DATABASE')),
    );

    expect(down).toBeGreaterThanOrEqual(0);
    expect(firstDelete).toBeGreaterThanOrEqual(0);
    expect(drop).toBeGreaterThanOrEqual(0);

    // Containers first: nothing may write an object or open a connection
    // mid-teardown.
    expect(down).toBeLessThan(firstDelete);
    expect(down).toBeLessThan(drop);
    // Storage before the database: the deployment's own rows are the only
    // thing that could reconcile an object the purge missed.
    expect(firstDelete).toBeLessThan(drop);
    // The deployment last, because its .env holds the credentials the two
    // steps above authenticate with - so it was still readable when they ran.
    expect(existsSync(fixture.deployRoot)).toBe(false);
  });

  it('reads the whole inventory BEFORE the containers come down', async () => {
    // Requirement 2: an operator cannot consent to a number they were never
    // shown, and the confirmation is asked for before the pipeline starts.
    const fixture = deployment([...SHARED_BUCKET, ...HEALTHY_DATABASE]);

    await uninstall(fixture, {
      dropDatabase: true,
      confirmDatabase: DATABASE,
      purgeStorage: true,
      confirmBucket: BUCKET,
    });

    const down = fixture.seen.findIndex((argv) => argv.includes('down') && argv.includes('-v'));
    const firstList = fixture.seen.findIndex((argv) => argv.includes('list-objects-v2'));
    const size = fixture.seen.findIndex((argv) => argv.some((item) => item.includes('pg_size_pretty')));

    expect(firstList).toBeLessThan(down);
    expect(size).toBeLessThan(down);
  });

  it('reads no bucket and opens no connection when neither extra was asked for', async () => {
    const fixture = deployment([...SHARED_BUCKET, ...HEALTHY_DATABASE]);

    await uninstall(fixture);

    expect(awsCalls(fixture)).toEqual([]);
    expect(sql(fixture)).toEqual([]);
  });
});

// =============================================================================
// 8. #261's refusals still hold WITH the extras enabled
// =============================================================================

describe("#261's four refusals hold with both extras enabled", () => {
  it('still never removes devnet, the shared proxy container, or an unasked-for certificate', async () => {
    const fixture = deployment([...SHARED_BUCKET, ...HEALTHY_DATABASE]);

    const result = await uninstall(fixture, {
      dropDatabase: true,
      confirmDatabase: DATABASE,
      purgeStorage: true,
      confirmBucket: BUCKET,
    });

    const flat = fixture.seen.map((argv) => argv.join(' '));
    // devnet.
    expect(flat.some((argv) => argv.includes('network rm') || argv.includes('devnet'))).toBe(false);
    // The shared proxy container: reloaded, never stopped or removed.
    expect(flat.some((argv) => /\b(stop|rm|restart)\b.*proxy-nginx/.test(argv))).toBe(false);
    expect(flat).toContain('docker exec proxy-nginx nginx -s reload');
    // The certificate, without --certs.
    expect(flat.some((argv) => argv.includes('certbot'))).toBe(false);
    expect(existsSync(join(fixture.proxyRoot, 'letsencrypt', 'live', DOMAIN))).toBe(true);
    expect(JSON.stringify(result.kept)).toContain('Pass --certs to delete it');
  });

  it('still reports the devnet and proxy refusals even on a run that destroys everything else', async () => {
    const fixture = deployment([...SHARED_BUCKET, ...HEALTHY_DATABASE]);

    const result = await uninstall(fixture, {
      dropDatabase: true,
      confirmDatabase: DATABASE,
      purgeStorage: true,
      confirmBucket: BUCKET,
    });

    const kept = result.kept.map((item) => item.target);
    expect(kept).toContain('devnet (docker network)');
    expect(kept).toContain('proxy-nginx');
    // The database and the bucket are NOT reported as kept - they went. A
    // "not removed" list naming what the same run removed is worse than none.
    expect(kept).not.toContain(DATABASE);
    expect(kept.some((target) => target === `${BUCKET} (object storage)`)).toBe(false);
  });

  it('still warns about the last renewal cron with the extras on', async () => {
    const fixture = deployment([...SHARED_BUCKET, ...HEALTHY_DATABASE]);

    const result = await uninstall(fixture, {
      dropDatabase: true,
      confirmDatabase: DATABASE,
      purgeStorage: true,
      confirmBucket: BUCKET,
    });

    // #264's rule: this was the only entry, so renewal has stopped for the
    // WHOLE box and that must not be lost among the storage output.
    expect(result.warnings.join('\n')).toMatch(/automatic certificate renewal has STOPPED/);
  });
});

// =============================================================================
// 9. A drop blocked by an open connection
// =============================================================================

describe('a drop blocked by an open connection', () => {
  it('ends the sessions holding it, scoped to this database, and says how many', async () => {
    let dropped = false;
    const fixture = deployment([
      { match: ['pg_size_pretty'], stdout: '42 MB' },
      { match: ['count(*) from pg_stat_activity'], stdout: '3' },
    ]);
    // Re-wrap so the first DROP fails 55006 and the second succeeds.
    const inner = fixture.runCommand;
    fixture.runCommand = (async (argv: readonly string[], options: RunCommandOptions) => {
      const statement = argv[argv.indexOf('-tAc') + 1] ?? '';
      if (statement.startsWith('DROP DATABASE') && !dropped) {
        dropped = true;
        fixture.seen.push([...argv]);
        throw Object.assign(new Error('exited 1'), {
          result: {
            argv: [...argv],
            cwd: options.cwd,
            exitCode: 1,
            stdout: '',
            stderr: `ERROR:  database "${DATABASE}" is being accessed by other users\nDETAIL:  There are 3 other sessions using the database.`,
            durationMs: 1,
            timedOut: false,
          },
        });
      }
      if (statement.includes('pg_terminate_backend')) {
        fixture.seen.push([...argv]);
        return {
          argv: [...argv],
          cwd: options.cwd,
          exitCode: 0,
          stdout: '3',
          stderr: '',
          durationMs: 1,
          timedOut: false,
        };
      }
      return inner(argv, options);
    }) as typeof inner;

    const result = await uninstall(fixture, { dropDatabase: true, confirmDatabase: DATABASE });

    const terminate = sql(fixture).find((statement) => statement.includes('pg_terminate_backend'));
    expect(terminate).toBeDefined();
    // ⚠ SCOPED. Never a bare terminate-all: the operator authorised destroying
    // ONE database, and a session against a different one is not theirs to end.
    expect(terminate).toContain(`datname = '${DATABASE}'`);
    expect(terminate).toContain('pid <> pg_backend_pid()');

    // It succeeded, and it SAYS what it killed rather than doing it quietly.
    expect(result.database?.outcome).toMatchObject({ ok: true, terminated: 3 });
    expect(result.database?.outcome?.ok === true && result.database.outcome.detail).toContain(
      'after ending 3 open session(s)',
    );
  });

  it('touches no session at all on the ordinary path, where nothing is connected', async () => {
    const fixture = deployment([...HEALTHY_DATABASE]);

    await uninstall(fixture, { dropDatabase: true, confirmDatabase: DATABASE });

    // Termination is the remedy for one specific failure, not part of the
    // happy path. `pg_stat_activity` is READ for the inventory; nothing is
    // terminated.
    expect(sql(fixture).some((statement) => statement.includes('pg_terminate_backend'))).toBe(false);
  });

  it('reports an unbreakable block in English, not as a raw psql error', async () => {
    const fixture = deployment([
      { match: ['pg_size_pretty'], stdout: '42 MB' },
      { match: ['count(*) from pg_stat_activity'], stdout: '2' },
      {
        match: ['DROP DATABASE'],
        fail: true,
        stderr: `ERROR:  database "${DATABASE}" is being accessed by other users`,
      },
      {
        match: ['pg_terminate_backend'],
        fail: true,
        stderr: 'ERROR:  permission denied to terminate process',
      },
    ]);

    const result = await uninstall(fixture, { dropDatabase: true, confirmDatabase: DATABASE });

    const warning = result.warnings.join('\n');
    // The operator is NOT left staring at psql's own sentence with no remedy.
    expect(warning).toContain('may not end the sessions holding it');
    expect(warning).toContain('Close whatever is connected');
    // A pasteable query naming exactly what is holding it open.
    expect(warning).toContain('pg_stat_activity');
    expect(warning).toContain(`dropdb -h db.internal -p 5432 -U app ${DATABASE}`);
    // And the deployment still went: a failed extra is a warning, not an abort
    // with the containers already stopped.
    expect(existsSync(fixture.deployRoot)).toBe(false);
  });

  it('treats a database that is already gone as the state that was asked for', async () => {
    const fixture = deployment([
      { match: ['pg_size_pretty'], stdout: '7 MB' },
      { match: ['count(*) from pg_stat_activity'], stdout: '0' },
      {
        match: ['DROP DATABASE'],
        fail: true,
        stderr: `ERROR:  database "${DATABASE}" does not exist`,
      },
    ]);

    const result = await uninstall(fixture, { dropDatabase: true, confirmDatabase: DATABASE });

    expect(result.database?.outcome).toMatchObject({ ok: true });
    expect(result.warnings.join('\n')).not.toMatch(/NOT dropped/);
  });
});

// =============================================================================
// A resource that cannot be read is never confirmed, and never destroyed
// =============================================================================

describe('an unreadable resource', () => {
  it('does not ask for a confirmation it has no real name for, and reports why', async () => {
    const fixture = deployment([
      { match: ['get-bucket-versioning'], stdout: '{}' },
      { match: ['list-objects-v2', '--delimiter'], fail: true, stderr: 'AccessDenied' },
    ]);

    // No `confirmBucket` at all, and it still runs: there was nothing to
    // confirm the destruction of.
    const result = await uninstall(fixture, { purgeStorage: true });

    expect(deleteCalls(fixture)).toEqual([]);
    expect(result.storage?.problem).toContain('AccessDenied');
    expect(result.warnings.join('\n')).toContain('was NOT emptied');
    expect(result.warnings.join('\n')).toContain('Nothing in the bucket was read or changed');
  });

  it('reports a deployment with no bucket configured rather than failing', async () => {
    const fixture = deployment([], {
      env: [`POSTGRES_DB=${DATABASE}`, 'POSTGRES_HOST=db.internal'],
    });

    const result = await uninstall(fixture, { purgeStorage: true });

    expect(awsCalls(fixture)).toEqual([]);
    expect(result.storage?.problem).toContain('S3_BUCKET is not set');
    expect(existsSync(fixture.deployRoot)).toBe(false);
  });
});

/** Every path under the apps root, with its size - the whole world this owns. */
function snapshot(appsRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(`${path}/`);
        walk(path);
      } else {
        out.push(`${path} ${statSync(path).size}`);
      }
    }
  };
  walk(appsRoot);
  return out;
}
