import { Readable } from 'node:stream';

import { createFakeSpawn } from '../../test/mocks/pg-process.mock';
import type { PgConnection } from './pg-dump.util';
import {
  MAX_RESTORE_JOBS,
  buildPgRestoreArgs,
  buildPgRestoreListArgs,
  clampRestoreJobs,
  parseTocEntryCount,
  readTocEntryCount,
  spawnPgRestore,
} from './pg-restore.util';

// =============================================================================
// Unit tests for pg_restore (issue #280, epic #254)
// =============================================================================
//
// The first assertion in this file is the one that matters: `--exit-on-error`.
// Without it `pg_restore` logs its errors, carries on, and EXITS 0 - so a
// restore that populated half the tables reports success, and #285 then swaps
// that half-populated database in as the live one and renames the intact
// original away. Everything else here is ordinary argument-building.
// =============================================================================

const CONNECTION: PgConnection = {
  host: 'db.internal',
  port: '5432',
  user: 'appuser',
  password: 'restore-s3cret',
  database: 'appdb_restore_tmp',
  sslMode: null,
};

/** A realistic `pg_restore --list` output: four header comments, three entries. */
const LISTING = [
  ';',
  '; Archive created at 2026-09-07 02:00:00 UTC',
  ';     dbname: appdb',
  ';',
  '215; 1259 16420 TABLE public users appuser',
  '216; 1259 16431 TABLE public roles appuser',
  '3412; 0 16420 TABLE DATA public users appuser',
  '',
].join('\n');

describe('buildPgRestoreArgs', () => {
  it('passes --exit-on-error, so a partial restore can never report success', () => {
    expect(buildPgRestoreArgs({ connection: CONNECTION })).toContain('--exit-on-error');
  });

  it('carries the connection as flags and the password not at all', () => {
    const args = buildPgRestoreArgs({ connection: CONNECTION });

    expect(args).toEqual([
      '--host',
      'db.internal',
      '--port',
      '5432',
      '--username',
      'appuser',
      '--dbname',
      'appdb_restore_tmp',
      '--no-password',
      '--no-owner',
      '--no-acl',
      '--exit-on-error',
    ]);
    expect(args.join(' ')).not.toContain(CONNECTION.password);
  });

  it('adds -j and the archive path when restoring from a file', () => {
    const args = buildPgRestoreArgs({ connection: CONNECTION, file: '/var/tmp/db.dump', jobs: 4 });

    expect(args).toContain('-j');
    expect(args[args.indexOf('-j') + 1]).toBe('4');
    // Positional and LAST, which is what `pg_restore [options] <file>` wants.
    expect(args[args.length - 1]).toBe('/var/tmp/db.dump');
  });

  it('never adds -j to a stdin restore', () => {
    const args = buildPgRestoreArgs({ connection: CONNECTION, jobs: 8 });

    // Parallel restore seeks around the archive to hand members to different
    // workers, and a pipe cannot seek - pg_restore rejects the combination, so
    // passing it here would turn a working restore into a usage error.
    expect(args).not.toContain('-j');
  });

  it('omits -j for a single job rather than passing a pointless -j 1', () => {
    expect(buildPgRestoreArgs({ connection: CONNECTION, file: '/x.dump', jobs: 1 })).not.toContain(
      '-j'
    );
  });

  it('clamps the job count instead of letting a setting exhaust the server', () => {
    // Each job is a connection AND a server-side worker; an unbounded value
    // from a settings row turns a restore into a connection-limit outage.
    expect(clampRestoreJobs(0)).toBe(1);
    expect(clampRestoreJobs(-4)).toBe(1);
    expect(clampRestoreJobs(1_000)).toBe(MAX_RESTORE_JOBS);
    expect(clampRestoreJobs(Number.NaN)).toBe(1);
  });
});

describe('buildPgRestoreListArgs', () => {
  it('names no connection at all', () => {
    // Listing reads the archive header and opens no database, which is what
    // lets #281 verify a stored object from anywhere.
    expect(buildPgRestoreListArgs()).toEqual(['--list']);
    expect(buildPgRestoreListArgs({ file: '/var/tmp/db.dump' })).toEqual([
      '--list',
      '/var/tmp/db.dump',
    ]);
  });
});

describe('spawnPgRestore', () => {
  it('keeps the password in the environment and out of argv', () => {
    const spawn = createFakeSpawn();

    spawnPgRestore({ connection: CONNECTION, file: '/var/tmp/db.dump', spawnFn: spawn.fn });

    expect(spawn.last().env.PGPASSWORD).toBe(CONNECTION.password);
    expect(spawn.last().args.join(' ')).not.toContain(CONNECTION.password);
  });
});

describe('parseTocEntryCount', () => {
  it('counts entries and ignores the comment header', () => {
    expect(parseTocEntryCount(LISTING)).toBe(3);
  });

  it('returns 0 for an archive whose table of contents is empty', () => {
    // The case the verification exists for: a truncated upload or a dump of
    // the wrong (empty) database still produces a well-formed header.
    expect(parseTocEntryCount(';\n; Archive created at 2026-09-07\n;\n')).toBe(0);
    expect(parseTocEntryCount('')).toBe(0);
  });
});

describe('readTocEntryCount', () => {
  it('counts the entries of an archive read from a file', async () => {
    const spawn = createFakeSpawn((record) => record.child.respondLater(LISTING, 0));

    await expect(
      readTocEntryCount({ source: { file: '/var/tmp/db.dump' }, spawnFn: spawn.fn })
    ).resolves.toBe(3);

    expect(spawn.last().args).toEqual(['--list', '/var/tmp/db.dump']);
  });

  it('pipes a stream into the child rather than buffering it', async () => {
    let piped = '';
    const spawn = createFakeSpawn((record) => {
      record.child.stdin.on('data', (chunk: Buffer) => {
        piped += String(chunk);
      });
      record.child.respondLater(LISTING, 0);
    });

    const count = await readTocEntryCount({
      source: Readable.from(['PGDMP', '-archive-bytes']),
      spawnFn: spawn.fn,
    });

    expect(count).toBe(3);
    expect(spawn.last().stdio[0]).toBe('pipe');
    expect(piped).toBe('PGDMP-archive-bytes');
  });

  it('survives the child closing its stdin early', async () => {
    const spawn = createFakeSpawn((record) => {
      setImmediate(() => {
        record.child.writeStdout(LISTING);
        // EPIPE is what a real `pg_restore --list` produces: it has the table
        // of contents and stops reading while we are still writing. Treating
        // it as a failure would fail verifications that actually succeeded.
        record.child.stdin.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
        record.child.close(0);
      });
    });

    await expect(
      readTocEntryCount({ source: Readable.from(['PGDMP']), spawnFn: spawn.fn })
    ).resolves.toBe(3);
  });

  it('fails when the archive cannot be read, however many entries were counted', async () => {
    const spawn = createFakeSpawn((record) => {
      record.child.stderr.write('pg_restore: error: did not find magic string in file header\n');
      record.child.respondLater('215; 1259 16420 TABLE public users appuser', 1);
    });

    // A corrupt object is exactly what the verification is looking for, so the
    // exit code is checked AFTER the stream is drained - never instead of it.
    await expect(
      readTocEntryCount({ source: { file: '/var/tmp/db.dump' }, spawnFn: spawn.fn })
    ).rejects.toThrow(/magic string/);
  });
});
