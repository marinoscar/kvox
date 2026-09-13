import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { Readable } from 'node:stream';

import { buildDatabaseUrl, type DatabaseEnv } from '../common/database-url';

// =============================================================================
// Spawning the PostgreSQL client binaries (issue #280, epic #254)
// =============================================================================
//
// This module is the ONLY place in the codebase that starts a `pg_*` process.
// `pg-restore.util.ts` and `pg-version.util.ts` both come through
// {@link spawnPgProcess}; the properties below are the reason they do, and
// each one is a failure this template has to not have.
//
// -----------------------------------------------------------------------------
// THE DUMP IS A STREAM, NOT A BUFFER
// -----------------------------------------------------------------------------
//
// `stdout` is handed back as a live `Readable` and is never collected here.
// A production database dumps to gigabytes; buffering it — even "just to hash
// it first" — puts the whole backup in the heap of the API process, which is
// the exact memory profile the streaming upload in #281 exists to avoid, and
// it fails on the deployment that needs the backup most (the big one). The
// dump is piped straight into the storage provider and never lands on this
// process's heap or on its disk.
//
// That is also why {@link buildPgDumpArgs} emits NO `-f`: writing to stdout is
// what makes the process pipeable at all.
//
// -----------------------------------------------------------------------------
// THE PASSWORD IS ENVIRONMENT, NEVER ARGV
// -----------------------------------------------------------------------------
//
// `PGPASSWORD` goes into the CHILD's environment. It must never appear in the
// argument vector, because argv is world-readable on Linux: any user on the
// box can read `/proc/<pid>/cmdline`, and plain `ps` prints it. A `--dbname`
// carrying a full connection URI is the tempting shortcut that leaks it, so
// the connection is passed as separate host/port/user/dbname flags and the
// secret travels out of band. There is a test asserting the whole argv array
// contains the password nowhere; treat it as a security control, not a style
// preference.
//
// -----------------------------------------------------------------------------
// WHY THE TIMEOUT KILLS WITH SIGKILL
// -----------------------------------------------------------------------------
//
// A dump does not usually hang on CPU — it hangs on a socket, waiting on a
// server that went away without closing the connection, and a process blocked
// in an uninterruptible read may never act on SIGTERM. SIGTERM is a request;
// SIGKILL is the only signal guaranteed to land. A backup that hangs forever
// is worse than one that fails: it holds a run row in `running` (which the
// stale-run sweep then has to reason about), holds a storage multipart upload
// open, and never produces the failure that would have alerted anybody.
// =============================================================================

/**
 * The default `pg_dump` binary name.
 *
 * Plain names, resolved from `PATH`, rather than absolute paths: the API image
 * installs `postgresql<N>-client` (see `apps/api/Dockerfile`) and Alpine,
 * Debian and macOS all put the binaries somewhere different. Every entry point
 * takes a `command` override for the deployment that needs one, so no
 * environment variable had to be invented for this.
 */
export const PG_DUMP_COMMAND = 'pg_dump';

/**
 * How long a `pg_*` process may run before it is SIGKILLed, when the caller
 * names no bound of its own.
 *
 * Six hours is a BACKSTOP, not a policy: it is there so a wedged process
 * cannot outlive the deployment, and it is deliberately far longer than any
 * real dump so that it never truncates a legitimately slow one. Callers that
 * know their own budget (the scheduled backup has `runStaleMinutes`) pass it
 * explicitly. `timeoutMs: 0` disables the timer entirely.
 */
export const DEFAULT_PG_PROCESS_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/**
 * How much of a child's stderr is kept, in bytes.
 *
 * BOUNDED, AND THE TAIL RATHER THAN THE HEAD. `pg_dump` can emit a warning per
 * object — a schema with tens of thousands of objects produces megabytes of
 * them — so an unbounded capture turns a diagnostic into a second memory leak,
 * and one that only appears on the databases where dumps already hurt. The
 * head is the least useful part of that output (it is the first of ten
 * thousand identical warnings); the tail is where the error that actually
 * stopped the process is printed.
 */
export const STDERR_TAIL_BYTES = 8 * 1024;

/** The compression level used when the caller names none. Matches the `databaseBackup` default. */
export const DEFAULT_COMPRESSION_LEVEL = 6;

/** Connection parameters, already decoded, ready to be handed to a `pg_*` process. */
export interface PgConnection {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
  /** `sslmode` from the connection URL, or `null`. Passed to the child as `PGSSLMODE`. */
  sslMode: string | null;
}

/**
 * The `spawn` seam.
 *
 * Every entry point in this module takes one, defaulting to node's. It exists
 * so the unit tests can assert the argv, the environment, the kill signal and
 * the settle-once behaviour with NO PostgreSQL binaries installed — a suite
 * that needs `pg_dump` on the runner is a suite that gets skipped in CI, and a
 * skipped test guards nothing.
 */
export type PgSpawnFn = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: ('pipe' | 'ignore')[] }
) => ChildProcess;

const defaultSpawn: PgSpawnFn = (command, args, options) => nodeSpawn(command, args, options);

/** A running `pg_*` process, shaped for `Promise.all([upload, dump.done])`. */
export interface PgProcess {
  /**
   * The child's stdout, LIVE. Nothing in this module reads it — the caller
   * pipes it somewhere (a storage upload, a line reader) and back-pressure
   * flows through to the child for free.
   */
  stdout: Readable;
  /**
   * Settles exactly once: resolves on exit code 0, rejects with a
   * {@link PgProcessError} on anything else — a non-zero exit, a signal, a
   * spawn failure, or the timeout.
   *
   * ⚠ THIS, NOT THE CONSUMER OF `stdout`, IS THE AUTHORITY ON SUCCESS. When a
   * dump dies half way through, its stdout simply ENDS: a pipe into storage
   * sees a clean EOF and reports a perfectly successful upload of a truncated
   * archive. Only the exit code distinguishes that from a complete dump, which
   * is why callers await both and treat a rejected `done` as fatal however
   * well the upload went.
   */
  done: Promise<void>;
  /** Signals the child. Safe to call after it has exited. */
  kill(signal?: NodeJS.Signals): void;
}

/** Why a `pg_*` process failed, with everything needed to write a useful log line. */
export class PgProcessError extends Error {
  constructor(
    message: string,
    readonly detail: {
      command: string;
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      timedOut: boolean;
      stderr: string;
    }
  ) {
    super(message);
    this.name = 'PgProcessError';
  }
}

export interface SpawnPgProcessOptions {
  /** Binary to run, e.g. `pg_dump`. Resolved from `PATH` unless it is an absolute path. */
  command: string;
  /** The argument vector. MUST NOT contain the password — see this file's header. */
  args: string[];
  /** Becomes `PGPASSWORD` in the child's environment, and appears nowhere else. */
  password?: string;
  /** Extra child environment (e.g. `PGSSLMODE`), merged over `baseEnv`. */
  extraEnv?: NodeJS.ProcessEnv;
  /** The environment inherited by the child. Defaults to this process's. */
  baseEnv?: NodeJS.ProcessEnv;
  /** SIGKILL deadline in milliseconds; `0` disables it. */
  timeoutMs?: number;
  /** Bytes of stderr tail retained. */
  stderrTailBytes?: number;
  /** Piped into the child's stdin. When absent, stdin is `ignore`. */
  stdin?: Readable;
  /** Test seam; defaults to `node:child_process.spawn`. */
  spawnFn?: PgSpawnFn;
}

/**
 * Starts a `pg_*` process and returns its stdout stream plus a single-settle
 * completion promise.
 *
 * @see the module header for the four properties this exists to guarantee.
 */
export function spawnPgProcess(options: SpawnPgProcessOptions): PgProcess {
  const {
    command,
    args,
    password,
    extraEnv,
    baseEnv = process.env,
    timeoutMs = DEFAULT_PG_PROCESS_TIMEOUT_MS,
    stderrTailBytes = STDERR_TAIL_BYTES,
    stdin,
    spawnFn = defaultSpawn,
  } = options;

  const env: NodeJS.ProcessEnv = { ...baseEnv, ...extraEnv };

  // Set only when non-empty. An empty `PGPASSWORD` is not the same as an
  // absent one to libpq — it is an empty password, which suppresses the
  // `.pgpass` lookup a trust/peer deployment may be relying on.
  if (password !== undefined && password !== '') {
    env.PGPASSWORD = password;
  }

  // stdin is `ignore` unless something is being piped in: a child with an open
  // stdin it never reads is a child that can wait on it, and there is nothing
  // this API could type at a password prompt anyway.
  const child = spawnFn(command, [...args], {
    env,
    stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });

  // `Readable.from([])` rather than a throw: a spawn seam is free to return a
  // child without stdout, and the `error`/`close` handlers below already
  // produce a proper failure. Blowing up on the stream would replace that
  // diagnosis with a TypeError.
  const stdout = child.stdout ?? Readable.from([]);

  let stderrTail = Buffer.alloc(0);
  child.stderr?.on('data', (chunk: Buffer) => {
    const combined = Buffer.concat([stderrTail, chunk]);
    // `subarray(-limit)` keeps the TAIL. Both branches copy at most
    // `limit + chunk` bytes, so unbounded stderr costs bounded memory.
    stderrTail = combined.length <= stderrTailBytes ? combined : combined.subarray(-stderrTailBytes);
  });

  const readStderrTail = (): string => stderrTail.toString('utf8');

  let settled = false;
  let timer: NodeJS.Timeout | undefined;

  // A hand-rolled deferred rather than the work inside `new Promise(...)`,
  // because the stdin pipe below has to be able to fail the process from
  // OUTSIDE the executor's scope, and reaching `reject` from there by
  // re-emitting on the child would race the very settle guard it needs.
  let resolveDone!: () => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  // THE SETTLE GUARD. A timeout kills the child, which then emits `close`, and
  // a child that fails to spawn can emit both `error` and `close`. Every one of
  // those paths reaches this function, and only the first does anything: the
  // rest are deliberate no-ops. Without it, the SIGKILL we just sent would
  // overwrite the timeout's diagnosis with a bare "killed by SIGKILL", which is
  // the least informative version of the same event.
  const settle = (finish: () => void): void => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    finish();
  };

  child.on('error', (error: Error) => {
    settle(() =>
      rejectDone(
        new PgProcessError(
          `Failed to start ${command}: ${error.message}. Is the postgresql client package ` +
            'installed in this image? See docs/runbooks/postgres-client-version.md.',
          { command, exitCode: null, signal: null, timedOut: false, stderr: readStderrTail() }
        )
      )
    );
  });

  child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
    settle(() => {
      if (code === 0) {
        resolveDone();
        return;
      }

      const stderr = readStderrTail();
      rejectDone(
        new PgProcessError(
          `${command} exited with ${describeExit(code, signal)}${stderrSuffix(stderr)}`,
          { command, exitCode: code, signal, timedOut: false, stderr }
        )
      );
    });
  });

  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      // SIGKILL, not SIGTERM - see the module header. The kill is sent BEFORE
      // settling so the child is already on its way out by the time the
      // caller's rejection handler runs, and the `close` it will emit as a
      // result lands on a guard that ignores it.
      child.kill('SIGKILL');
      settle(() => {
        const stderr = readStderrTail();
        rejectDone(
          new PgProcessError(
            `${command} exceeded its ${timeoutMs}ms timeout and was killed with SIGKILL` +
              stderrSuffix(stderr),
            { command, exitCode: null, signal: 'SIGKILL', timedOut: true, stderr }
          )
        );
      });
    }, timeoutMs);

    // Unreferenced so a pending deadline never by itself keeps the process
    // (or a Jest worker) alive after everything else has finished.
    timer.unref();
  }

  // Marks `done` as handled WITHOUT consuming it: `.catch()` returns a NEW
  // promise, and every real consumer still sees the rejection on `done`
  // itself. It is here because a caller legitimately attaches its handler a
  // tick later (`const dump = spawnPgDump(...); await init(); await
  // Promise.all([...])`), and an immediate ENOENT rejection in that gap would
  // be an unhandled rejection - which terminates the process in current Node.
  void done.catch(() => undefined);

  if (stdin && child.stdin) {
    const childStdin = child.stdin;
    stdin.pipe(childStdin);

    // EPIPE is EXPECTED here, not an error: a reader that has everything it
    // needs (`pg_restore --list` stops once it has the table of contents)
    // exits while we are still writing. Rejecting on it would fail
    // verifications that actually succeeded. Anything else is a real write
    // failure, and it settles through the same guard as every other path.
    childStdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED') return;
      settle(() =>
        rejectDone(
          new PgProcessError(`Failed to write to ${command} stdin: ${error.message}`, {
            command,
            exitCode: null,
            signal: null,
            timedOut: false,
            stderr: readStderrTail(),
          })
        )
      );
    });
  }

  return {
    stdout,
    done,
    kill(signal: NodeJS.Signals = 'SIGTERM') {
      child.kill(signal);
    },
  };
}

/** `code 1`, or `signal SIGKILL` when the child was signalled rather than exited. */
function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal !== null) return `signal ${signal}`;
  return `code ${code ?? 'unknown'}`;
}

/** Appends the captured stderr tail to a message, when there is any. */
function stderrSuffix(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed === '' ? '' : `: ${trimmed}`;
}

/**
 * Reads the connection parameters the `pg_*` binaries need out of the
 * environment.
 *
 * DERIVED FROM {@link buildDatabaseUrl}, never re-implemented. That function is
 * "the one place a PostgreSQL connection string is built" (#172), and the
 * reason it is the only place is that three copies of the same derivation once
 * disagreed about percent-encoding. Building a fourth here — reading
 * `POSTGRES_*` directly — would recreate exactly that bug, and it would also
 * quietly ignore a `DATABASE_URL` override, which is the documented escape
 * hatch for a connection the `POSTGRES_*` formula cannot express. So this
 * builds the URL through the shared helper and takes it back apart.
 *
 * The user and the password are percent-DECODED on the way out, because
 * `buildDatabaseUrl` encoded them: `pg_dump` wants the literal password, and a
 * password containing `/` (which `openssl rand -base64 32` produces routinely)
 * would otherwise be handed over as `%2F`.
 */
export function resolvePgConnection(env: DatabaseEnv = process.env): PgConnection {
  const url = new URL(buildDatabaseUrl(env));

  // `?host=` wins over the authority so that a socket-directory URL
  // (`postgresql:///db?host=/var/run/postgresql`) — one of the shapes the
  // DATABASE_URL escape hatch exists for — is not silently rewritten to
  // localhost TCP.
  const hostParam = url.searchParams.get('host');
  const database = decodeComponent(url.pathname.replace(/^\//, ''));

  return {
    host: hostParam ?? (url.hostname === '' ? 'localhost' : url.hostname),
    port: url.port === '' ? '5432' : url.port,
    user: decodeComponent(url.username) || 'postgres',
    password: decodeComponent(url.password),
    database: database === '' ? 'appdb' : database,
    sslMode: url.searchParams.get('sslmode'),
  };
}

/**
 * The NON-SECRET part of a child's environment.
 *
 * `PGPASSWORD` is deliberately NOT here: it is a separate, named option on
 * {@link spawnPgProcess}, so that the one variable with a security rule
 * attached to it cannot be lost in a spread of an environment object.
 */
export function pgClientEnv(connection: PgConnection): NodeJS.ProcessEnv {
  return connection.sslMode === null ? {} : { PGSSLMODE: connection.sslMode };
}

export interface PgDumpArgsOptions {
  connection: PgConnection;
  /** 0-9; clamped rather than rejected, so a bad stored setting cannot stop a backup. */
  compressionLevel?: number;
}

/**
 * The `pg_dump` argument vector.
 *
 * Every flag here is load-bearing:
 *
 *  - `-Fc` (custom format) is the ONLY format `pg_restore` can reorder,
 *    filter and restore in parallel. A plain-SQL dump can only be replayed
 *    start to finish by `psql`, which rules out the `-j` restore #285 needs
 *    and rules out listing its table of contents to verify it (#281).
 *  - `--no-owner` / `--no-acl` leave the source's ownership and grants OUT of
 *    the archive. Baking them in makes a cross-host restore fail on the first
 *    `ALTER ... OWNER TO` naming a role that does not exist on the target —
 *    which is precisely the restore that matters, the one onto a fresh
 *    machine after the original is gone.
 *  - `-Z <level>` compresses inside pg_dump, before the bytes ever reach this
 *    process, so what is streamed and stored is what was compressed.
 *  - `--no-password` makes a missing or wrong password an immediate error
 *    instead of a prompt. There is no terminal on the other end of a
 *    scheduled backup, and a client waiting for one is a job that hangs until
 *    the timeout rather than failing in a second with a clear message.
 *  - NO `-f`. The archive goes to stdout; see the module header.
 *
 * Host, port, user and database are separate flags rather than one URI on
 * purpose — a URI would carry the password into argv.
 */
export function buildPgDumpArgs(options: PgDumpArgsOptions): string[] {
  const { connection, compressionLevel = DEFAULT_COMPRESSION_LEVEL } = options;

  return [
    '--host',
    connection.host,
    '--port',
    connection.port,
    '--username',
    connection.user,
    '--dbname',
    connection.database,
    '--no-password',
    '-Fc',
    '--no-owner',
    '--no-acl',
    '-Z',
    String(clampCompressionLevel(compressionLevel)),
  ];
}

/**
 * Clamps a compression level into `pg_dump`'s 0-9 range.
 *
 * CLAMPED, NOT REJECTED, for the same reason the schedule translation clamps
 * (see `schedule.util.ts`): the write path already validates this setting, so
 * a value out of range here means something upstream is already wrong — and
 * "run the backup at level 9" is a far better answer to that than "take no
 * backup tonight".
 */
export function clampCompressionLevel(level: number): number {
  if (!Number.isFinite(level)) return DEFAULT_COMPRESSION_LEVEL;
  return Math.min(9, Math.max(0, Math.trunc(level)));
}

export interface SpawnPgDumpOptions {
  /** Defaults to {@link resolvePgConnection} over `env`. */
  connection?: PgConnection;
  /** Environment the connection is derived from, when `connection` is absent. */
  env?: DatabaseEnv;
  compressionLevel?: number;
  timeoutMs?: number;
  command?: string;
  spawnFn?: PgSpawnFn;
}

/**
 * Starts `pg_dump` against this deployment's database and returns its archive
 * as a stream.
 *
 * The connection is read from the environment over the network — there is no
 * `docker exec` anywhere in this path, and there could not be: the application
 * PostgreSQL is EXTERNAL to the compose stack (`infra/compose/base.compose.yml`
 * declares no `db` service), so the only thing this process can assume about
 * the server is that the same `POSTGRES_*` variables Prisma connects with will
 * reach it too.
 */
export function spawnPgDump(options: SpawnPgDumpOptions = {}): PgProcess {
  const connection = options.connection ?? resolvePgConnection(options.env);

  return spawnPgProcess({
    command: options.command ?? PG_DUMP_COMMAND,
    args: buildPgDumpArgs({ connection, compressionLevel: options.compressionLevel }),
    password: connection.password,
    extraEnv: pgClientEnv(connection),
    timeoutMs: options.timeoutMs,
    spawnFn: options.spawnFn,
  });
}

/**
 * Percent-decodes a URL component, falling back to the raw string.
 *
 * `decodeURIComponent` throws `URIError` on a lone `%` — which an
 * operator-supplied `DATABASE_URL` can legitimately contain if they wrote the
 * password in unencoded. Failing the backup over that would be the wrong
 * trade: the raw string is at worst a password that does not authenticate,
 * and that produces a clear error from the server instead of a crash here.
 */
function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
