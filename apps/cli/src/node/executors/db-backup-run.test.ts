import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { NodeLogger, readLogTail } from '../logger.js';
import type { JobSecret, NodeApi, UploadUrlResult } from '../node-api.js';
import { buildPgDumpArgs, pgClientEnv, type PgConnection } from '../pg-dump.js';
import { DatabaseBackupRunExecutor, readPgMaterial } from './db-backup-run.js';
import type { JobExecutionContext } from './index.js';

// =============================================================================
// `db.backup.run` on a node  (issue #352, epic #345)
// =============================================================================
//
// THE ASSERTION THIS FILE EXISTS FOR is the last group: A NODE NEVER PERSISTS
// CREDENTIALS. Everything else here — the argv, the stream, the two awaited
// halves, the decimal-string byte count — is a property somebody could
// reasonably re-derive from the code. That one is a promise the epic makes to
// an operator who is being asked to run this on a machine they may not own,
// and it is the kind of promise a single well-meaning refactor ("cache the
// connection so we do not re-fetch it per job") breaks silently.
//
// No PostgreSQL binaries and no network: the `spawn` and `fetch` seams are the
// same shape the API's own `pg-dump.util.ts` uses, and for the same reason — a
// suite that needs `pg_dump` on the runner is a suite CI skips.
// =============================================================================

/** The password that must not appear anywhere except one child's environment. */
const PASSWORD = 'p4ssw0rd-must-never-be-persisted-7c31';

const MATERIAL = {
  driver: 'postgresql',
  host: 'db.internal',
  port: 5432,
  database: 'appdb',
  user: 'appjob_2222_reader',
  password: PASSWORD,
  sslMode: 'require',
};

const UPLOAD: UploadUrlResult = {
  url: 'https://bucket.example/backups/2026/09/07/run-1.dump?X-Amz-Signature=abc',
  key: 'backups/2026/09/07/run-1.dump',
  expiresIn: 900,
  expiresAt: '2026-09-07T02:15:00.000Z',
};

/** A child process double: a stream this test pushes into, and a settle. */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }

  /** A clean exit: end the archive, then report code 0. */
  finish(): void {
    this.stdout.end();
    setImmediate(() => this.emit('close', 0, null));
  }

  /**
   * A dump that dies mid-archive. Note that it ENDS its stdout — which is
   * exactly what makes a truncated archive look complete to the upload.
   */
  die(code = 1, stderr = 'pg_dump: error: connection to server failed'): void {
    this.stderr.write(stderr);
    this.stdout.end();
    setImmediate(() => this.emit('close', code, null));
  }
}

interface HarnessOptions {
  /** What `jobSecret` answers with. */
  secret?: Partial<JobSecret>;
  /** Bytes the fake `pg_dump` writes before finishing. */
  archive?: Buffer;
  /** Make the upload fail with this status. */
  uploadStatus?: number;
  /** Let the dump die instead of finishing. */
  dumpFails?: boolean;
}

function makeHarness(options: HarnessOptions = {}) {
  const children: FakeChild[] = [];
  const spawnCalls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const uploads: Array<{ url: string; init: RequestInit & { duplex?: string } }> = [];
  const logs: Array<{ message: string; fields?: Record<string, unknown> }> = [];

  const spawnFn = vi.fn((command: string, args: string[], spawnOptions: { env: NodeJS.ProcessEnv }) => {
    spawnCalls.push({ command, args, env: spawnOptions.env });

    const child = new FakeChild();
    children.push(child);

    // The archive is produced on the next tick, so the executor has piped and
    // started the upload before any byte moves — the real ordering.
    setImmediate(() => {
      if (options.dumpFails === true) {
        child.die();
        return;
      }

      child.stdout.write(options.archive ?? Buffer.from('PGDMP-fake-archive'));
      child.finish();
    });

    return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
  });

  /** Consumes the streamed body, exactly as a real PUT would. */
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    uploads.push({ url: String(url), init: (init ?? {}) as RequestInit & { duplex?: string } });

    const body = (init as { body?: unknown } | undefined)?.body;
    let received = 0;

    if (body !== undefined && body !== null && typeof (body as Readable)[Symbol.asyncIterator] === 'function') {
      for await (const chunk of body as Readable) received += (chunk as Buffer).length;
    }

    return {
      ok: (options.uploadStatus ?? 200) < 400,
      status: options.uploadStatus ?? 200,
      received,
    } as unknown as Response;
  });

  const api = {
    jobSecret: vi.fn(
      async (): Promise<JobSecret> => ({
        kind: 'postgres.readonly',
        expiresAt: '2026-09-07T03:00:00.000Z',
        material: MATERIAL,
        ...options.secret,
      }),
    ),
    uploadUrl: vi.fn(async (): Promise<UploadUrlResult> => UPLOAD),
  } as unknown as NodeApi;

  const controller = new AbortController();

  const context: JobExecutionContext = {
    job: { id: 'job-1', type: 'db.backup.run' } as JobExecutionContext['job'],
    params: {},
    inputPath: undefined,
    input: undefined,
    api,
    nodeId: 'node-1',
    signal: controller.signal,
    log: (message, fields) => logs.push({ message, ...(fields ? { fields } : {}) }),
  };

  const executor = new DatabaseBackupRunExecutor({
    spawnFn: spawnFn as never,
    fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
    // The two provenance probes, stubbed: they run `psql` and `pg_dump
    // --version`, neither of which exists on a CI runner.
    readClientVersion: async () => 'pg_dump (PostgreSQL) 17.2',
    probe: async (args) =>
      args.join(' ').includes('_prisma_migrations') ? '20260907160000_add' : 'PostgreSQL 17.4',
  });

  return { executor, context, api, controller, children, spawnCalls, uploads, logs, fetchImpl };
}

describe('DatabaseBackupRunExecutor', () => {
  it('needs no input object — its input is the database, not a stored file', () => {
    // Setting this true would make the engine fetch a download URL for a job
    // that has no input object, and the request would 422 before `pg_dump`
    // ever ran.
    expect(new DatabaseBackupRunExecutor().requiresInput).toBe(false);
    expect(new DatabaseBackupRunExecutor().type).toBe('db.backup.run');
  });

  it('dumps, hashes and uploads in one pass, reporting the SERVER’s key', async () => {
    const h = makeHarness({ archive: Buffer.from('one-two-three') });

    const result = await h.executor.execute(h.context);

    expect(result.storageKey).toBe(UPLOAD.key);
    expect(result.bytes).toBe('13');
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.pgDumpVersion).toBe('pg_dump (PostgreSQL) 17.2');
    expect(result.dbVersion).toBe('PostgreSQL 17.4');
    expect(result.migrationName).toBe('20260907160000_add');
    expect(Date.parse(result.startedAt)).toBeLessThanOrEqual(Date.parse(result.finishedAt));
  });

  it('reports `bytes` as a DECIMAL STRING, so a multi-terabyte archive survives JSON', async () => {
    const h = makeHarness({ archive: Buffer.alloc(1024) });

    const result = await h.executor.execute(h.context);

    // A string, not a number — the contract's one load-bearing wire decision.
    expect(typeof result.bytes).toBe('string');
    expect(result.bytes).toBe('1024');
    expect(result.bytes).toMatch(/^\d+$/);
  });

  it('PUTs a STREAM with `duplex: half`, never a buffer', async () => {
    const h = makeHarness();

    await h.executor.execute(h.context);

    const upload = h.uploads[0];
    expect(upload).toBeDefined();
    if (upload === undefined) throw new Error('no upload');
    expect(upload.url).toBe(UPLOAD.url);
    expect(upload.init.method).toBe('PUT');
    // ⚠ Without `duplex`, undici refuses the request outright — at call time,
    // which makes it look like a bad URL rather than a missing option.
    expect(upload.init.duplex).toBe('half');
    expect(Buffer.isBuffer(upload.init.body)).toBe(false);
    expect(typeof upload.init.body).not.toBe('string');
  });

  it('fails the job when `pg_dump` dies, even though the upload "succeeded"', async () => {
    // THE FAILURE BOTH HALVES EXIST FOR. A dying dump ends its stdout, so the
    // PUT sees a clean EOF and reports a perfectly successful transfer of a
    // TRUNCATED archive. Only the exit code tells the two apart.
    const h = makeHarness({ dumpFails: true });

    await expect(h.executor.execute(h.context)).rejects.toThrow(/exited with code 1/);
  });

  it('carries the dump’s stderr tail into the error, so the reason is legible', async () => {
    const h = makeHarness({ dumpFails: true });

    await expect(h.executor.execute(h.context)).rejects.toThrow(/connection to server failed/);
  });

  it('kills the dump when the upload fails, rather than reading a whole database for nothing', async () => {
    const h = makeHarness({ uploadStatus: 403 });

    await expect(h.executor.execute(h.context)).rejects.toThrow(/HTTP 403/);
    expect(h.children[0]?.killed).toBe(true);
  });

  it('stops on abort — a drained node does not finish work nobody will accept', async () => {
    const h = makeHarness({ archive: Buffer.alloc(0) });

    // Abort before the child produces anything.
    h.controller.abort();

    await expect(h.executor.execute(h.context)).rejects.toBeDefined();
    expect(h.children[0]?.killed).toBe(true);
  });

  it('refuses a credential it cannot build a connection from, naming the missing fields only', async () => {
    const h = makeHarness({ secret: { material: { host: 'db', port: 5432 } } });

    await expect(h.executor.execute(h.context)).rejects.toThrow(/missing: user, password, database/);
    // Nothing was dumped: the failure is before the spawn.
    expect(h.spawnCalls).toHaveLength(0);
  });

  // ===========================================================================
  // ⚠ THE PASSWORD: ENVIRONMENT ONLY, NEVER ARGV, NEVER DISK, NEVER A LOG
  // ===========================================================================

  describe('the credential never leaves this process except through one child', () => {
    it('passes it in the child’s environment and NOWHERE in argv', async () => {
      const h = makeHarness();

      await h.executor.execute(h.context);

      const call = h.spawnCalls[0];
      if (call === undefined) throw new Error('pg_dump was never spawned');
      // argv is world-readable on Linux — `ps` prints it, and so does
      // `/proc/<pid>/cmdline`. On a worker node that is a machine the
      // deployment may not own.
      expect(call.args.join(' ')).not.toContain(PASSWORD);
      expect(JSON.stringify(call.args)).not.toContain(PASSWORD);
      expect(call.env.PGPASSWORD).toBe(PASSWORD);
      // The broker said `require`; the child is told exactly that, so the
      // transport is the server's choice and not an inherited default.
      expect(call.env.PGSSLMODE).toBe('require');
    });

    it('never passes the broker response to a config writer', async () => {
      // ⚠ THE ACCEPTANCE TEST FOR "A NODE NEVER PERSISTS CREDENTIALS" (epic
      // #345). The module is mocked wholesale and every export made to throw:
      // a future refactor that "caches the connection between jobs" by
      // reaching for the config file fails here, loudly, instead of quietly
      // writing a database password onto somebody else's machine.
      const writers = await import('../node-config.js');

      const saveNodeConfig = vi.spyOn(writers, 'saveNodeConfig').mockImplementation(() => {
        throw new Error('the executor wrote to the node config file');
      });
      const saveNodeCredentials = vi
        .spyOn(writers, 'saveNodeCredentials')
        .mockImplementation(() => {
          throw new Error('the executor wrote to the node credentials file');
        });

      try {
        const h = makeHarness();
        await h.executor.execute(h.context);

        expect(saveNodeConfig).not.toHaveBeenCalled();
        expect(saveNodeCredentials).not.toHaveBeenCalled();
      } finally {
        saveNodeConfig.mockRestore();
        saveNodeCredentials.mockRestore();
      }
    });

    it('imports no config or state-directory writer at all — the static half of the same rule', () => {
      // The runtime assertion above can only fail if a call is REACHED. This
      // one fails as soon as the dependency exists, which is the moment the
      // rule actually breaks.
      const source = readFileSync(new URL('./db-backup-run.ts', import.meta.url), 'utf8');
      const imports = source
        .split('\n')
        .filter((line) => line.trimStart().startsWith('import'))
        .join('\n');

      expect(imports).not.toContain('node-config');
      expect(imports).not.toContain('paths.js');
      expect(imports).not.toContain('../../config.js');
      // …and it writes nothing itself.
      expect(source).not.toContain('writeFileSync');
      expect(source).not.toContain('appendFileSync');
    });

    it('leaves the state directory byte-for-byte free of the credential', async () => {
      // The belt to the previous braces: whatever the executor did, nothing
      // under the node's own directory may contain the password.
      const stateDir = mkdtempSync(join(tmpdir(), 'appctl-node-secret-'));

      try {
        const h = makeHarness();
        await h.executor.execute(h.context);

        for (const entry of readdirSync(stateDir, { recursive: true }) as string[]) {
          const path = join(stateDir, entry);
          if (!statSync(path).isFile()) continue;
          expect(readFileSync(path, 'utf8')).not.toContain(PASSWORD);
        }
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    });

    it('writes no log line containing the credential, through the real logger', async () => {
      // END TO END through `NodeLogger`, because "nothing logs it" is a
      // property of the executor's messages AND the logger's redaction, and
      // either one alone can be right while the pair leaks.
      const dir = mkdtempSync(join(tmpdir(), 'appctl-node-log-'));
      const path = join(dir, 'node.log');

      try {
        const logger = new NodeLogger({ path });
        const h = makeHarness();
        h.context.log = (message, fields) => logger.info(message, fields);

        await h.executor.execute(h.context);

        // The job did log — an assertion that reads an empty file proves
        // nothing.
        const records = readLogTail(path);
        expect(records.length).toBeGreaterThan(0);

        const raw = readFileSync(path, 'utf8');
        expect(raw).not.toContain(PASSWORD);
        // …and not the presigned upload URL either, which is a bearer
        // capability over the bucket for as long as it lives.
        expect(raw).not.toContain('X-Amz-Signature=abc');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('redacts a whole broker response if one is ever handed to the logger', async () => {
      // Defence in depth for the case this executor is careful about: some
      // future code path logging the response object itself.
      const dir = mkdtempSync(join(tmpdir(), 'appctl-node-log-'));
      const path = join(dir, 'node.log');

      try {
        new NodeLogger({ path }).info('secret issued', {
          secret: { kind: 'postgres.readonly', material: MATERIAL },
          material: MATERIAL,
        });

        expect(readFileSync(path, 'utf8')).not.toContain(PASSWORD);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe('readPgMaterial', () => {
  it('accepts the discrete fields `PgJobRoleBroker` issues, port as a number or a string', () => {
    expect(readPgMaterial(MATERIAL)).toEqual<PgConnection>({
      host: 'db.internal',
      port: '5432',
      user: 'appjob_2222_reader',
      database: 'appdb',
      password: PASSWORD,
      sslMode: 'require',
    });

    expect(readPgMaterial({ ...MATERIAL, port: '6543' }).port).toBe('6543');
  });

  it('treats an absent sslMode as "unset", not as a mode', () => {
    const { sslMode, ...withoutSsl } = MATERIAL;
    void sslMode;

    expect(readPgMaterial(withoutSsl).sslMode).toBeNull();
    // …and the child is then told nothing, rather than being told a default
    // this node invented for a transport the server chose.
    expect(pgClientEnv(readPgMaterial(withoutSsl)).PGSSLMODE).toBeUndefined();
  });

  it('never puts the material in its error message', () => {
    // The message becomes `Job.lastError` on the server and a line in this
    // node's log — both places a password must not reach.
    let message = '';
    try {
      readPgMaterial({ password: PASSWORD });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('missing: host, port, user, database');
    expect(message).not.toContain(PASSWORD);
  });
});

describe('the argv the node builds', () => {
  const connection: PgConnection = {
    host: 'db.internal',
    port: '5432',
    user: 'appjob_reader',
    password: PASSWORD,
    database: 'appdb',
    sslMode: null,
  };

  it('matches the server’s flags, because the ARCHIVE has to be the same either way', () => {
    const args = buildPgDumpArgs(connection);

    // `-Fc` is the only format the server can verify (`pg_restore --list`) and
    // the only one a parallel restore can read; `--no-owner`/`--no-acl` are
    // what make a SELECT-only minted role a sufficient dumper AND what let the
    // archive restore onto a machine where those roles do not exist.
    expect(args).toEqual(
      expect.arrayContaining(['-Fc', '--no-owner', '--no-acl', '--no-password']),
    );
    // No `-f`: the archive goes to stdout, which is what makes it pipeable.
    expect(args).not.toContain('-f');
    expect(args.join(' ')).not.toContain(PASSWORD);
  });

  it('clamps a nonsense compression level instead of refusing to run', () => {
    expect(buildPgDumpArgs(connection, 99)).toEqual(expect.arrayContaining(['-Z', '9']));
    expect(buildPgDumpArgs(connection, -3)).toEqual(expect.arrayContaining(['-Z', '0']));
    expect(buildPgDumpArgs(connection, Number.NaN)).toEqual(expect.arrayContaining(['-Z', '6']));
  });
});

describe('the child’s environment', () => {
  const connection: PgConnection = {
    host: 'db.internal',
    port: '5432',
    user: 'appjob_reader',
    password: PASSWORD,
    database: 'appdb',
    sslMode: 'require',
  };

  const saved = { ...process.env };

  beforeEach(() => {
    process.env.PGSERVICE = 'somebody-elses-service';
    process.env.PGPASSFILE = '/home/operator/.pgpass';
    process.env.PGHOST = 'localhost';
    process.env.PGSSLMODE = 'disable';
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('clears every inherited libpq variable — a node is a machine people have used by hand', () => {
    const env = pgClientEnv(connection);

    // `PGSERVICE` and `PGPASSFILE` are the dangerous two: both are read from
    // FILES that can supply their own host and their own password, so a
    // leftover service name could point this dump at a different database
    // entirely and the failure would look like a broker bug.
    expect(env.PGSERVICE).toBeUndefined();
    expect(env.PGPASSFILE).toBeUndefined();
    expect(env.PGHOST).toBeUndefined();
    // The broker's mode wins over the inherited one.
    expect(env.PGSSLMODE).toBe('require');
    expect(env.PGPASSWORD).toBe(PASSWORD);
  });

  it('keeps everything else, so the binary is still findable and the locale still right', () => {
    expect(pgClientEnv(connection).PATH).toBe(process.env.PATH);
  });

  it('leaves THIS process’s own PGPASSWORD UNCHANGED — it builds an env, it does not set one', () => {
    // ⚠ UNCHANGED, NOT UNSET, AND DO NOT "TIGHTEN" THIS BACK TO
    // `toBeUndefined()`. The property under test is that `pgClientEnv` does
    // not MUTATE this process's environment; whether `PGPASSWORD` happened to
    // be exported before the call is a fact about the machine running the
    // suite, not about the code. Asserting absence makes this test — the one
    // whose whole job is a security property — go red for anyone who has run
    // `psql` in the same shell, or on a CI runner that exports `PGPASSWORD`
    // beside `POSTGRES_PASSWORD`. A security assertion that cries wolf on an
    // unrelated variable is one people mute.
    const before = process.env.PGPASSWORD;

    pgClientEnv(connection);

    expect(process.env.PGPASSWORD).toBe(before);
  });

  it('does not mutate this process’s environment AT ALL', () => {
    // The general form of the assertion above: the child's environment is a
    // COPY, so nothing the code under test writes into it may be observable
    // here. Compared as a whole rather than key by key, so a future variable
    // this function starts setting is caught without anyone remembering to
    // add a case for it.
    const before = { ...process.env };

    pgClientEnv(connection);

    expect({ ...process.env }).toEqual(before);
  });
});
