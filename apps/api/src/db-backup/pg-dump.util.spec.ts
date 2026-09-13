import { Readable } from 'node:stream';

import { collect, createFakeSpawn } from '../../test/mocks/pg-process.mock';
import {
  DEFAULT_COMPRESSION_LEVEL,
  buildPgDumpArgs,
  clampCompressionLevel,
  pgClientEnv,
  resolvePgConnection,
  spawnPgDump,
  spawnPgProcess,
  type PgConnection,
} from './pg-dump.util';

// =============================================================================
// Unit tests for the pg_* process wrapper (issue #280, epic #254)
// =============================================================================
//
// NO POSTGRESQL BINARIES ARE INVOLVED. Every case drives the injected `spawnFn`
// seam, which is why the suite can assert things a real process would not let
// it observe reliably: which signal a timeout sent, that a `close` arriving
// after that kill changes nothing, and that an ENOENT produces an actionable
// message rather than a raw errno.
//
// The first describe block is a SECURITY TEST, not a formatting one. See the
// module header of pg-dump.util.ts.
// =============================================================================

/** A connection whose password is unmistakable if it ever leaks into argv. */
const CONNECTION: PgConnection = {
  host: 'db.internal',
  port: '5433',
  user: 'appuser',
  password: 'sup3r-s3cret-p@ss/word',
  database: 'appdb',
  sslMode: null,
};

/** Lets a PassThrough's queued `data` events run before the next assertion. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('spawnPgProcess', () => {
  describe('the password', () => {
    it('goes into the child environment and appears nowhere in argv', () => {
      const spawn = createFakeSpawn();

      spawnPgDump({ connection: CONNECTION, spawnFn: spawn.fn });

      const { args, env } = spawn.last();

      expect(env.PGPASSWORD).toBe(CONNECTION.password);
      // Asserted over the WHOLE vector rather than over the flags we happen to
      // know about: the leak this guards against is a future `--dbname` given
      // a full connection URI, which no per-flag assertion would notice.
      expect(args.join(' ')).not.toContain(CONNECTION.password);
      expect(args).not.toContain(CONNECTION.password);
      expect(args.some((argument) => argument.includes('p@ss'))).toBe(false);
    });

    it('is left unset when there is none, rather than set to an empty string', () => {
      const spawn = createFakeSpawn();

      spawnPgProcess({
        command: 'pg_dump',
        args: [],
        password: '',
        baseEnv: {},
        spawnFn: spawn.fn,
      });

      // An empty PGPASSWORD is an empty PASSWORD to libpq, not an absent one:
      // it suppresses the .pgpass lookup a trust deployment may rely on.
      expect(spawn.last().env).not.toHaveProperty('PGPASSWORD');
    });
  });

  describe('stdout', () => {
    it('is handed back live rather than collected', async () => {
      const spawn = createFakeSpawn();

      const process = spawnPgProcess({ command: 'pg_dump', args: [], spawnFn: spawn.fn });

      // The bytes are written AFTER the call returned, which only works
      // because nothing in the wrapper waited for the stream to finish.
      spawn.last().child.writeStdout('PGDMP-archive-bytes');
      spawn.last().child.close(0);

      await expect(collect(process.stdout)).resolves.toBe('PGDMP-archive-bytes');
      await expect(process.done).resolves.toBeUndefined();
    });
  });

  describe('the timeout', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('kills with SIGKILL, not SIGTERM', async () => {
      const spawn = createFakeSpawn();

      const process = spawnPgProcess({
        command: 'pg_dump',
        args: [],
        timeoutMs: 1_000,
        spawnFn: spawn.fn,
      });
      const rejection = expect(process.done).rejects.toThrow(/SIGKILL/);

      jest.advanceTimersByTime(1_001);
      await rejection;

      // SIGTERM is a request a process blocked on a dead socket may never act
      // on; SIGKILL is the only one guaranteed to land.
      expect(spawn.last().child.killSignals).toEqual(['SIGKILL']);
    });

    it('settles exactly once - a close after the kill is a no-op', async () => {
      const spawn = createFakeSpawn();

      const process = spawnPgProcess({
        command: 'pg_dump',
        args: [],
        timeoutMs: 1_000,
        spawnFn: spawn.fn,
      });
      const rejection = expect(process.done).rejects.toThrow(/exceeded its 1000ms timeout/);

      jest.advanceTimersByTime(1_001);
      await rejection;

      // Exactly what a real SIGKILLed child does next: `close` with a signal.
      // A second settle here would either overwrite the timeout diagnosis with
      // a bare "killed by SIGKILL" or, worse, resolve a run that was killed.
      spawn.last().child.close(0);
      spawn.last().child.fail(new Error('late spawn error'));

      await expect(process.done).rejects.toThrow(/exceeded its 1000ms timeout/);
    });

    it('does not arm a timer at all when timeoutMs is 0', async () => {
      const spawn = createFakeSpawn();

      const process = spawnPgProcess({
        command: 'pg_dump',
        args: [],
        timeoutMs: 0,
        spawnFn: spawn.fn,
      });

      jest.advanceTimersByTime(24 * 60 * 60 * 1_000);
      expect(spawn.last().child.killSignals).toEqual([]);

      spawn.last().child.close(0);
      await expect(process.done).resolves.toBeUndefined();
    });
  });

  describe('stderr capture', () => {
    it('is bounded and keeps the tail', async () => {
      const spawn = createFakeSpawn();

      const process = spawnPgProcess({
        command: 'pg_dump',
        args: [],
        stderrTailBytes: 64,
        spawnFn: spawn.fn,
      });

      // pg_dump emits one warning per object; a big schema produces megabytes
      // of them, and the last line is the one that says why it stopped.
      for (let index = 0; index < 200; index += 1) {
        spawn.last().child.writeStderr(`warning ${index}\n`);
      }
      spawn.last().child.writeStderr('FATAL: the real error\n');
      await flush();

      spawn.last().child.close(1);

      const error = await process.done.then(
        () => new Error('expected a rejection'),
        (rejection: Error) => rejection
      );

      expect(error.message).toContain('FATAL: the real error');
      // The head is gone, and that is the point: it is the first of two
      // hundred identical warnings, and keeping it would have cost the line
      // that says what actually happened.
      expect(error.message).not.toContain('warning 0');
    });
  });

  describe('failures', () => {
    it('reports a non-zero exit with its code', async () => {
      const spawn = createFakeSpawn();

      const process = spawnPgProcess({ command: 'pg_dump', args: [], spawnFn: spawn.fn });
      spawn.last().child.close(2);

      await expect(process.done).rejects.toThrow(/pg_dump exited with code 2/);
    });

    it('turns a spawn failure into a message that names the fix', async () => {
      const spawn = createFakeSpawn();

      const process = spawnPgProcess({ command: 'pg_dump', args: [], spawnFn: spawn.fn });
      spawn.last().child.fail(new Error('spawn pg_dump ENOENT'));

      // ENOENT here means the image was built without the client package, so
      // the message points at the runbook rather than at the errno.
      await expect(process.done).rejects.toThrow(/postgres-client-version\.md/);
    });
  });

  it('defaults kill() to SIGTERM, so an ordinary cancellation is polite', () => {
    const spawn = createFakeSpawn();

    const process = spawnPgProcess({ command: 'pg_dump', args: [], spawnFn: spawn.fn });
    process.kill();
    process.kill('SIGKILL');

    expect(spawn.last().child.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('ignores stdin only when nothing is being piped in', () => {
    const withStdin = createFakeSpawn();
    const withoutStdin = createFakeSpawn();

    spawnPgProcess({
      command: 'pg_restore',
      args: [],
      stdin: Readable.from(['bytes']),
      spawnFn: withStdin.fn,
    });
    spawnPgProcess({ command: 'pg_dump', args: [], spawnFn: withoutStdin.fn });

    expect(withStdin.last().stdio[0]).toBe('pipe');
    // A child with an open stdin it never reads is a child that can block on
    // it - and there is nothing this API could answer a prompt with anyway.
    expect(withoutStdin.last().stdio[0]).toBe('ignore');
  });
});

describe('buildPgDumpArgs', () => {
  it('emits the custom format, no ownership, no ACLs and a compression level', () => {
    const args = buildPgDumpArgs({ connection: CONNECTION, compressionLevel: 9 });

    expect(args).toEqual([
      '--host',
      'db.internal',
      '--port',
      '5433',
      '--username',
      'appuser',
      '--dbname',
      'appdb',
      '--no-password',
      '-Fc',
      '--no-owner',
      '--no-acl',
      '-Z',
      '9',
    ]);
  });

  it('never writes to a file, because the archive has to be pipeable', () => {
    const args = buildPgDumpArgs({ connection: CONNECTION });

    // `-f` would land the dump on the container's disk - the memory problem
    // moved to a filesystem that may not have room for it - instead of
    // streaming it into storage.
    expect(args).not.toContain('-f');
    expect(args).not.toContain('--file');
  });

  it('clamps the compression level rather than refusing to run', () => {
    expect(clampCompressionLevel(-3)).toBe(0);
    expect(clampCompressionLevel(42)).toBe(9);
    expect(clampCompressionLevel(4.7)).toBe(4);
    expect(clampCompressionLevel(Number.NaN)).toBe(DEFAULT_COMPRESSION_LEVEL);
  });
});

describe('resolvePgConnection', () => {
  it('reads the POSTGRES_* variables through the shared URL builder', () => {
    const connection = resolvePgConnection({
      POSTGRES_HOST: 'pg.example.net',
      POSTGRES_PORT: '6432',
      POSTGRES_USER: 'app',
      POSTGRES_PASSWORD: 'p@ss/word',
      POSTGRES_DB: 'appdb',
    });

    expect(connection).toEqual({
      host: 'pg.example.net',
      port: '6432',
      user: 'app',
      // Percent-DECODED: buildDatabaseUrl encoded it, and pg_dump wants the
      // literal password. `openssl rand -base64 32` produces `/` and `+`
      // routinely, so this is the ordinary case rather than an exotic one.
      password: 'p@ss/word',
      database: 'appdb',
      sslMode: null,
    });
  });

  it('honours a DATABASE_URL override, including its sslmode', () => {
    const connection = resolvePgConnection({
      DATABASE_URL: 'postgresql://ovr%2Fuser:ovr%40pass@other.host:5555/otherdb?sslmode=require',
      POSTGRES_HOST: 'ignored.example.net',
    });

    expect(connection.host).toBe('other.host');
    expect(connection.port).toBe('5555');
    expect(connection.user).toBe('ovr/user');
    expect(connection.password).toBe('ovr@pass');
    expect(connection.database).toBe('otherdb');
    expect(connection.sslMode).toBe('require');
  });

  it('falls back to the defaults the rest of the app uses', () => {
    expect(resolvePgConnection({})).toEqual({
      host: 'localhost',
      port: '5432',
      user: 'postgres',
      password: 'postgres',
      database: 'appdb',
      sslMode: null,
    });
  });
});

describe('pgClientEnv', () => {
  it('passes sslmode to the child and nothing else', () => {
    expect(pgClientEnv({ ...CONNECTION, sslMode: 'require' })).toEqual({ PGSSLMODE: 'require' });
    // The password is deliberately NOT here: it is a named option on
    // spawnPgProcess so it cannot be lost in a spread.
    expect(pgClientEnv(CONNECTION)).toEqual({});
  });
});
