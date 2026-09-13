import { createFakeSpawn } from '../../test/mocks/pg-process.mock';
import {
  MIN_PG_CLIENT_MAJOR,
  checkPgClientVersion,
  parsePgClientMajor,
  parseServerVersionNum,
  readPgClientVersion,
  readServerVersionNumWithPgClient,
  serverMajorFromVersionNum,
  type PgQueryClient,
} from './pg-version.util';

// =============================================================================
// Unit tests for the client/server version guard (issue #280, epic #254)
// =============================================================================
//
// The two asymmetric outcomes are what this file is really about:
//
//   client < server → BLOCK, with a message an operator can act on without
//                     already knowing how pg_dump behaves.
//   anything unreadable → WARN AND PROCEED, because an unparseable version
//                     string must never be the reason a backup did not happen.
//
// Both readers are seams, so nothing here needs a PostgreSQL binary or a
// database.
// =============================================================================

/** A client older than the server: the exact configuration that cannot back up. */
const olderClient = () => Promise.resolve('pg_dump (PostgreSQL) 16.9');

describe('parsePgClientMajor', () => {
  it('reads the major out of the shapes packagers actually ship', () => {
    expect(parsePgClientMajor('pg_dump (PostgreSQL) 17.4')).toBe(17);
    expect(parsePgClientMajor('pg_dump (PostgreSQL) 17.4 (Ubuntu 17.4-1.pgdg24.04+2)\n')).toBe(17);
    expect(parsePgClientMajor('pg_dump (PostgreSQL) 18.0')).toBe(18);
    // Pre-10 versioning, where the major is two components. Still 9.
    expect(parsePgClientMajor('pg_dump (PostgreSQL) 9.6.24')).toBe(9);
  });

  it('returns null rather than a guess for anything it cannot read', () => {
    expect(parsePgClientMajor('')).toBeNull();
    expect(parsePgClientMajor('command not found')).toBeNull();
    expect(parsePgClientMajor(null)).toBeNull();
    expect(parsePgClientMajor(undefined)).toBeNull();
    // Parsed a number that is not a version; reporting it would produce a
    // nonsense block.
    expect(parsePgClientMajor('pg_dump 4200.1')).toBeNull();
  });
});

describe('parseServerVersionNum', () => {
  it('accepts the three shapes a driver can hand back', () => {
    expect(parseServerVersionNum('170004')).toBe(170004);
    expect(parseServerVersionNum(170004)).toBe(170004);
    expect(parseServerVersionNum(170004n)).toBe(170004);
  });

  it('returns null for anything else', () => {
    expect(parseServerVersionNum(undefined)).toBeNull();
    expect(parseServerVersionNum(null)).toBeNull();
    expect(parseServerVersionNum('not a number')).toBeNull();
    expect(parseServerVersionNum(0)).toBeNull();
  });
});

describe('serverMajorFromVersionNum', () => {
  it('divides out the major for both the modern and the pre-10 packing', () => {
    expect(serverMajorFromVersionNum(170004)).toBe(17);
    expect(serverMajorFromVersionNum(180000)).toBe(18);
    expect(serverMajorFromVersionNum(90624)).toBe(9);
    expect(serverMajorFromVersionNum(null)).toBeNull();
  });
});

describe('checkPgClientVersion', () => {
  it('BLOCKS when the client is older than the server, and says what to do', async () => {
    const check = await checkPgClientVersion({
      readClientVersion: olderClient,
      readServerVersionNum: () => Promise.resolve(170004),
    });

    expect(check.status).toBe('blocked');
    expect(check.clientMajor).toBe(16);
    expect(check.serverMajor).toBe(17);
    // Both versions named, and the fix named: an operator reading this in a
    // failed run should not have to already know that pg_dump refuses to dump
    // a newer server.
    expect(check.message).toContain('16');
    expect(check.message).toContain('17');
    expect(check.message).toContain('postgresql17-client');
    expect(check.message).toContain('docs/runbooks/postgres-client-version.md');
  });

  it('passes when the majors are equal', async () => {
    const check = await checkPgClientVersion({
      readClientVersion: () => Promise.resolve('pg_dump (PostgreSQL) 17.4'),
      readServerVersionNum: () => Promise.resolve(170004),
    });

    expect(check.status).toBe('ok');
    expect(check.warning).toBeUndefined();
  });

  it('passes when the client is newer, which is the supported direction', async () => {
    const check = await checkPgClientVersion({
      readClientVersion: () => Promise.resolve('pg_dump (PostgreSQL) 18.1'),
      readServerVersionNum: () => Promise.resolve(150012),
    });

    expect(check.status).toBe('ok');
  });

  it('warns, but still passes, when the client is older than the pinned major', async () => {
    // Dumping a 15 server with a 16 client works fine; it just means the
    // running image is not the one this build pins.
    const check = await checkPgClientVersion({
      readClientVersion: olderClient,
      readServerVersionNum: () => Promise.resolve(150012),
    });

    expect(check.status).toBe('ok');
    expect(check.warning).toContain(String(MIN_PG_CLIENT_MAJOR));
  });

  it('WARNS AND PROCEEDS when the client version cannot be parsed', async () => {
    const check = await checkPgClientVersion({
      readClientVersion: () => Promise.resolve('pg_dump: command not found'),
      readServerVersionNum: () => Promise.resolve(170004),
    });

    expect(check.status).toBe('unknown');
    expect(check.status).not.toBe('blocked');
    expect(check.message).toContain('Proceeding');
  });

  it('WARNS AND PROCEEDS when the server version cannot be read', async () => {
    const check = await checkPgClientVersion({
      readClientVersion: () => Promise.resolve('pg_dump (PostgreSQL) 17.4'),
      readServerVersionNum: () => Promise.resolve(null),
    });

    expect(check.status).toBe('unknown');
    expect(check.clientMajor).toBe(17);
    expect(check.serverMajor).toBeNull();
  });

  it('WARNS AND PROCEEDS when a reader throws outright', async () => {
    // A transient failure of ONE query must not be what stops a backup that
    // was otherwise about to succeed.
    const check = await checkPgClientVersion({
      readClientVersion: () => Promise.reject(new Error('spawn failed')),
      readServerVersionNum: () => Promise.reject(new Error('connection refused')),
    });

    expect(check.status).toBe('unknown');
    expect(check.message).toContain('unknown');
  });
});

describe('readPgClientVersion', () => {
  it('returns the banner the binary printed', async () => {
    const spawn = createFakeSpawn((record) =>
      record.child.respondLater('pg_dump (PostgreSQL) 17.4\n', 0)
    );

    await expect(readPgClientVersion({ spawnFn: spawn.fn })).resolves.toContain('17.4');
    expect(spawn.last().args).toEqual(['--version']);
  });

  it('returns null instead of throwing when the binary is missing', async () => {
    const spawn = createFakeSpawn((record) =>
      setImmediate(() => record.child.fail(new Error('spawn pg_dump ENOENT')))
    );

    // This is the whole "fail open" contract: a missing binary becomes
    // `unknown`, never an exception that a caller could turn into a skipped
    // backup by accident.
    await expect(readPgClientVersion({ spawnFn: spawn.fn })).resolves.toBeNull();
  });
});

describe('readServerVersionNumWithPgClient', () => {
  /** A `pg` client stand-in; the real one would need a database. */
  const createClient = (
    result: unknown,
    behaviour: { failConnect?: boolean } = {}
  ): PgQueryClient & { ended: boolean } => ({
    ended: false,
    connect: () =>
      behaviour.failConnect === true
        ? Promise.reject(new Error('connection refused'))
        : Promise.resolve(undefined),
    query: () => Promise.resolve({ rows: [{ server_version_num: result }] }),
    async end() {
      this.ended = true;
    },
  });

  it('reads server_version_num and closes the connection', async () => {
    const client = createClient('170004');

    await expect(
      readServerVersionNumWithPgClient({ env: {}, clientFactory: () => client })
    ).resolves.toBe(170004);
    expect(client.ended).toBe(true);
  });

  it('returns null and STILL closes the connection when the query fails', async () => {
    const client = createClient(null, { failConnect: true });

    await expect(
      readServerVersionNumWithPgClient({ env: {}, clientFactory: () => client })
    ).resolves.toBeNull();
    // A probe that leaks a connection every night is a slow way to exhaust
    // max_connections on the server the backups are protecting.
    expect(client.ended).toBe(true);
  });
});
