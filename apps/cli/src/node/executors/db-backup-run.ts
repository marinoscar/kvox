import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { Transform } from 'node:stream';
import { promisify } from 'node:util';

import { PG_DUMP_COMMAND, PSQL_COMMAND, spawnPgDump, type PgConnection, type PgSpawnFn } from '../pg-dump.js';
import type { JobExecutionContext, JobExecutor } from './index.js';

// =============================================================================
// `db.backup.run` — taking the database dump on a worker node  (issue #352)
// =============================================================================
//
// The node counterpart of `DatabaseBackupRunHandler`, and the first executor in
// this repository that holds a CREDENTIAL. Everything unusual about it follows
// from that one fact, so the rules are worth stating before the code:
//
// -----------------------------------------------------------------------------
// ⚠ THE SECRET LIVES IN ONE LOCAL CONSTANT, FOR THE LIFE OF ONE FUNCTION CALL
// -----------------------------------------------------------------------------
//
// It is fetched inside `execute`, held in a `const`, handed to ONE child
// process through its environment, and dropped when the call returns. It must
// never reach:
//
//   * `node-config.ts` or anything that writes it — the config file is a
//     durable, world-readable-if-you-are-root artifact on a machine this
//     deployment may not own, and epic #345's founding rule is that A NODE
//     NEVER PERSISTS CREDENTIALS. `db-backup-run.test.ts` asserts that no
//     config writer is ever called from this path; that assertion is the
//     acceptance test for the rule, not a nicety.
//   * the state directory (`paths.ts`) — same argument, plus it survives
//     restarts.
//   * a log line. `logger.ts` redacts `PGPASSWORD` and the broker's material
//     shape, and this file additionally never puts the material in a message.
//     Two independent mechanisms, because "nothing logs it" is a property of
//     the whole pipeline and not of any one call site.
//   * a child process that outlives the job. `pg_dump` is awaited; `psql` (the
//     provenance probes) is awaited with a short timeout.
//
// The credential expires with the job's LEASE, so even a leak is bounded — but
// "bounded" is not the design, it is the backstop.
//
// -----------------------------------------------------------------------------
// THE ARCHIVE NEVER TOUCHES THIS MACHINE'S DISK OR HEAP
// -----------------------------------------------------------------------------
//
// `pg_dump` writes to stdout, which is piped through a hashing/metering
// `Transform` straight into a SINGLE-SHOT `PUT` at the presigned URL. Nothing
// buffers, nothing spools to a temp file: a 200 GB dump costs a hash context
// and a socket. That is the same streaming contract
// `db-backup-runner.service.ts` states at length for the server path, and it
// is what makes moving this work to a node worth doing at all — the bytes go
// from the database to object storage without transiting the API.
//
// ⚠ `fetch` WITH A `Readable` BODY REQUIRES `duplex: 'half'`. Without it
// undici refuses the request outright ("RequestInit: duplex option is required
// when sending a body"), and the failure is at call time rather than in the
// transfer, which makes it look like a bad URL.
//
// ⚠ BOTH HALVES ARE AWAITED, and neither one alone is evidence. A dump that
// dies mid-archive simply ENDS its stdout, so the upload reports a perfectly
// successful transfer of a TRUNCATED file; only `pg_dump`'s exit code tells
// the two apart. Equally, a dump that exits 0 says nothing about whether the
// PUT was accepted. The server then verifies what actually landed in the
// bucket — see `persistNodeResult` — because neither of these two checks is
// performed by a party the server has any reason to trust.
//
// -----------------------------------------------------------------------------
// PROVENANCE IS BEST-EFFORT AND NEVER FAILS THE BACKUP
// -----------------------------------------------------------------------------
//
// `pgDumpVersion`, `dbVersion` and `migrationName` are read with `--version`
// and two `psql` queries, each with a short timeout, each returning `null` on
// any failure at all. `psql` is a DEGRADABLE capability in
// `capabilities.ts` for exactly this reason: without it the node still takes a
// perfectly good backup and reports two nulls. An unreadable version string
// must never be the reason a database is not backed up — the same rule
// `pg-version.util.ts` states on the server.
// =============================================================================

const execFileAsync = promisify(execFile);

/** Mirrors `dbBackupRunResultSchema` in `apps/api/src/jobs/contracts/`. */
export interface DbBackupRunResult {
  storageKey: string;
  /** A DECIMAL STRING: the column is 64-bit and a JSON number is not exact past 2^53. */
  bytes: string;
  sha256: string;
  pgDumpVersion: string | null;
  dbVersion: string | null;
  migrationName: string | null;
  startedAt: string;
  finishedAt: string;
}

/** How long a provenance probe may take before it is abandoned as `null`. */
export const PROVENANCE_TIMEOUT_MS = 10_000;

/** What the archive is uploaded as. Matches the server's `BACKUP_CONTENT_TYPE`. */
export const BACKUP_CONTENT_TYPE = 'application/octet-stream';

export interface DatabaseBackupExecutorOptions {
  /** The `pg_dump` spawn seam, so the tests need no PostgreSQL binaries. */
  spawnFn?: PgSpawnFn | undefined;
  /** The upload seam. Defaults to the global `fetch`. */
  fetchImpl?: typeof globalThis.fetch | undefined;
  /** Runs a provenance probe. Defaults to `psql`. */
  probe?: ((args: string[], connection: PgConnection) => Promise<string | null>) | undefined;
  /** Reads `pg_dump --version`. Defaults to running it. */
  readClientVersion?: (() => Promise<string | null>) | undefined;
  pgDumpCommand?: string | undefined;
  psqlCommand?: string | undefined;
}

export class DatabaseBackupRunExecutor implements JobExecutor {
  readonly type = 'db.backup.run';

  /**
   * ⚠ FALSE, AND THE ONE THING NOT TO "FIX". Every other node-eligible type so
   * far reads an input object the server resolves for it; this one's input is
   * the DATABASE, reached through a credential it fetches itself. Setting this
   * true would make the engine ask for a download URL for a job that has no
   * input object, and the request would fail with a 422 before `pg_dump` ever
   * ran.
   */
  readonly requiresInput = false;

  constructor(private readonly options: DatabaseBackupExecutorOptions = {}) {}

  async execute(context: JobExecutionContext): Promise<DbBackupRunResult> {
    const { job, nodeId, api } = context;

    // -------------------------------------------------------------------------
    // 1. The credential. ONE LOCAL CONST — see the file header.
    // -------------------------------------------------------------------------
    const secret = await api.jobSecret(nodeId, job.id);
    const connection = readPgMaterial(secret.material);

    // -------------------------------------------------------------------------
    // 2. Where to write. THE SERVER CHOOSES THE KEY, always: this asks for it
    //    and reports it back verbatim in the result, and the server refuses a
    //    result naming anything else.
    // -------------------------------------------------------------------------
    const target = await api.uploadUrl(nodeId, job.id, BACKUP_CONTENT_TYPE);

    if (typeof target.url !== 'string' || target.url.length === 0) {
      throw new Error(`The server returned no upload URL for job ${job.id}; nothing was dumped.`);
    }

    const startedAt = new Date().toISOString();

    // Read BEFORE the dump, deliberately: the credential is alive now, the
    // probes are cheap, and doing them afterwards would run them against a
    // role that may have just been revoked by the job settling.
    const pgDumpVersion = await this.readClientVersion();
    const dbVersion = await this.probeValue(['-c', 'SELECT version()'], connection);
    const migrationName = await this.probeValue(
      [
        '-c',
        'SELECT migration_name FROM _prisma_migrations ' +
          'WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1',
      ],
      connection,
    );

    // -------------------------------------------------------------------------
    // 3. Dump → hash/meter → PUT, as one stream.
    // -------------------------------------------------------------------------
    const dump = spawnPgDump({
      connection,
      ...(this.options.spawnFn !== undefined ? { spawnFn: this.options.spawnFn } : {}),
      ...(this.options.pgDumpCommand !== undefined ? { command: this.options.pgDumpCommand } : {}),
    });

    const hash = createHash('sha256');
    let bytes = 0n;

    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        bytes += BigInt(chunk.length);
        // Forwarded UNCHANGED and NOT retained: a tap, not a buffer.
        callback(null, chunk);
      },
    });

    // ⚠ NO-OP `error` LISTENERS, AND THEY ARE NOT DECORATION. A Node stream
    // that emits `error` with nothing listening throws it as an UNCAUGHT
    // EXCEPTION and takes the worker down — taking every other job on this
    // node with it. Both of these are destroyed on purpose below (a dead dump,
    // an aborted job), at a moment when the upload may already have stopped
    // reading. The error is not lost: it travels to the caller through the
    // `Promise.all`.
    meter.on('error', () => undefined);
    dump.stdout.on('error', () => undefined);

    // Cooperative cancellation: a drain or a lost lease must stop a
    // multi-hour dump rather than finish work nobody will accept. The abort
    // tears down the child AND the pipe, so the upload fails too.
    const onAbort = (): void => {
      dump.kill();
      meter.destroy(new Error(`Backup of job ${job.id} was aborted`));
    };
    context.signal.addEventListener('abort', onAbort, { once: true });

    // ⚠ AND THE FLAG IS RE-READ, because a listener added AFTER the event has
    // already fired is never called. The engine aborts on drain and on lease
    // loss, and both can land while the credential fetch and the two
    // provenance probes above are in flight — a window of seconds, on the one
    // job type that then reads an entire database for nobody. Same defence
    // `db-backup-runner.service.ts` states for a cancel that arrives during
    // its version check.
    if (context.signal.aborted) onAbort();

    // A DEAD DUMP MUST TEAR THE UPLOAD DOWN, or the PUT sits waiting on a
    // stream that will never end. `.catch()` returns a NEW promise, so
    // `dump.done` still rejects into the `Promise.all` below.
    dump.done.catch((error: unknown) => {
      meter.destroy(error instanceof Error ? error : new Error(String(error)));
    });

    dump.stdout.pipe(meter);

    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;

    const upload = (async () => {
      const response = await fetchImpl(target.url, {
        method: 'PUT',
        headers: { 'content-type': BACKUP_CONTENT_TYPE },
        // Cast: `RequestInit.body` does not name Node's `Readable`, which
        // undici accepts natively. `duplex` is likewise not in the DOM lib and
        // is REQUIRED for a streaming body.
        body: meter as unknown as BodyInit,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' });

      if (!response.ok) {
        throw new Error(
          `Uploading the backup for job ${job.id} failed with HTTP ${response.status}.`,
        );
      }
    })();

    // ...AND A DEAD UPLOAD MUST TEAR THE DUMP DOWN, or `pg_dump` reads a whole
    // database to produce an archive nobody is storing.
    upload.catch(() => {
      dump.kill();
    });

    try {
      // BOTH HALVES. See the file header for why neither alone is evidence.
      await Promise.all([upload, dump.done]);
    } finally {
      context.signal.removeEventListener('abort', onAbort);
    }

    const result: DbBackupRunResult = {
      // Reported back, never chosen: the server refuses a key it did not hand
      // out, which is what stops a node pointing a restore at other bytes.
      storageKey: target.key,
      // ⚠ A DECIMAL STRING. A dump past 2 GiB is ordinary and a JSON number
      // stops being exact above 2^53, so the corruption would land on exactly
      // the largest backups. See the contract's header.
      bytes: bytes.toString(),
      sha256: hash.digest('hex'),
      pgDumpVersion,
      dbVersion,
      migrationName,
      startedAt,
      finishedAt: new Date().toISOString(),
    };

    // ⚠ THE LOG LINE NAMES NOTHING FROM `secret`. Size, digest and key are the
    // useful facts; the credential is not one of them.
    context.log('database backup uploaded', {
      jobId: job.id,
      bytes: result.bytes,
      sha256: result.sha256,
      key: result.storageKey,
    });

    return result;
  }

  /** `pg_dump --version`, or `null`. Never throws — see the file header. */
  private async readClientVersion(): Promise<string | null> {
    if (this.options.readClientVersion !== undefined) {
      return this.options.readClientVersion();
    }

    try {
      const { stdout } = await execFileAsync(this.options.pgDumpCommand ?? PG_DUMP_COMMAND, ['--version'], {
        timeout: PROVENANCE_TIMEOUT_MS,
      });

      return firstLine(stdout);
    } catch {
      return null;
    }
  }

  /**
   * One `psql` scalar, or `null`.
   *
   * ⚠ THE QUERIES ARE CONSTANTS, NOT BUILT FROM ANYTHING. Nothing
   * caller-supplied reaches SQL here: the connection travels as flags and the
   * password as an environment variable, so there is no interpolation to get
   * wrong. `-X` skips `~/.psqlrc` (a worker node is a machine somebody has
   * used by hand), `-A -t` give a bare value with no alignment or header.
   */
  private async probeValue(args: string[], connection: PgConnection): Promise<string | null> {
    if (this.options.probe !== undefined) {
      return this.options.probe(args, connection);
    }

    try {
      const { stdout } = await execFileAsync(
        this.options.psqlCommand ?? PSQL_COMMAND,
        [
          '--host',
          connection.host,
          '--port',
          connection.port,
          '--username',
          connection.user,
          '--dbname',
          connection.database,
          '--no-password',
          '-X',
          '-A',
          '-t',
          ...args,
        ],
        {
          timeout: PROVENANCE_TIMEOUT_MS,
          env: pgProbeEnv(connection),
        },
      );

      return firstLine(stdout);
    } catch {
      // A missing `psql`, a permission denied on `_prisma_migrations`, a
      // timeout: all of them mean "this fact was not readable", which is a
      // `null` column and never a failed backup.
      return null;
    }
  }
}

/**
 * Narrows the broker's opaque `material` into a connection, or throws.
 *
 * ⚠ VALIDATED RATHER THAN CAST, and the failure is a NAMED error. `material`
 * is `Record<string, unknown>` by contract — the API passes it through without
 * interpreting it — so a broker change, a version skew, or a fork's own
 * `postgres`-kind broker returning a DSN would otherwise surface as
 * `undefined` inside an argv and a `pg_dump` that connects to the wrong place
 * (or to localhost) with an unhelpful error.
 *
 * ⚠ THE ERROR MESSAGE NAMES THE MISSING FIELDS AND NOTHING ELSE. It must never
 * include the material itself: this string becomes `Job.lastError` on the
 * server and a line in this node's log.
 */
export function readPgMaterial(material: Record<string, unknown>): PgConnection {
  const read = (key: string): string | undefined => {
    const value = material[key];

    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);

    return undefined;
  };

  const host = read('host');
  const port = read('port');
  const user = read('user');
  const password = read('password');
  const database = read('database');

  const missing = Object.entries({ host, port, user, password, database })
    .filter(([, value]) => value === undefined)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(
      `The credential this server issued is missing: ${missing.join(', ')}. This node cannot ` +
        'build a PostgreSQL connection from it; nothing was dumped.',
    );
  }

  const sslMode = read('sslMode');

  return {
    host: host as string,
    port: port as string,
    user: user as string,
    password: password as string,
    database: database as string,
    sslMode: sslMode ?? null,
  };
}

/**
 * The provenance probe's environment.
 *
 * The same rule as the dump's — see `pgClientEnv` in `pg-dump.ts` — and it is
 * built here rather than imported wholesale because `execFile`'s `env` also
 * replaces the child's environment entirely.
 */
function pgProbeEnv(connection: PgConnection): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  delete env.PGSERVICE;
  delete env.PGSERVICEFILE;
  delete env.PGPASSFILE;

  env.PGPASSWORD = connection.password;
  if (connection.sslMode !== null) env.PGSSLMODE = connection.sslMode;

  return env;
}

/** First non-empty line, trimmed and bounded — the columns are 128/255 wide. */
function firstLine(value: string): string | null {
  const line = value.split('\n').map((entry) => entry.trim()).find((entry) => entry.length > 0);

  return line === undefined ? null : line.slice(0, 128);
}
