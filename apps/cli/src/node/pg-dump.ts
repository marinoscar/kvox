import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';

// =============================================================================
// Spawning `pg_dump` on a WORKER NODE  (issue #352, epic #345)
// =============================================================================
//
// The node-side counterpart of `apps/api/src/db-backup/pg-dump.util.ts`, and
// the rules are the server's rules because they are properties of `pg_dump`,
// not of whichever process happens to be running it.
//
// -----------------------------------------------------------------------------
// WHY THIS IS A SECOND IMPLEMENTATION AND NOT AN IMPORT
// -----------------------------------------------------------------------------
//
// REJECTED: importing the API's util. `apps/cli` is a standalone published
// binary that must not depend on the server package — it runs on a machine
// with no API source tree, and pulling in `apps/api` would drag `@nestjs/*`,
// Prisma's client and the whole settings graph onto a worker node whose entire
// job is to run one child process.
//
// REJECTED: extracting a shared `packages/pg-client` for the two. The shared
// surface is forty lines of argv and one `spawn`; a fourth build target with
// its own tsconfig, its own test runner and its own publish story is a large,
// permanent tax for that. `packages/shared/index.js` documents what a shared
// workspace already costs here.
//
// So the DUPLICATION IS DELIBERATE AND BOUNDED, and what the two must agree on
// is THE ARCHIVE, not the code that spawns the process — which is why the
// flags below are asserted here against the same list the server's
// `buildPgDumpArgs` emits (`-Fc`, `--no-owner`, `--no-acl`, `--no-password`,
// no `-f`). Those five are the agreement: the server VERIFIES what a node
// uploads with `pg_restore --list`, so an archive in any other format is
// refused at submission — correctly, and confusingly. Change one of them here
// and you have changed what this deployment's backups are.
//
// -----------------------------------------------------------------------------
// ⚠ THE PASSWORD IS ENVIRONMENT, NEVER ARGV — AND THAT MATTERS MORE HERE
// -----------------------------------------------------------------------------
//
// argv is world-readable on Linux: any user on the box can read
// `/proc/<pid>/cmdline`, and plain `ps` prints it. On the API server that is
// one trusted host; on a worker node it is a machine the deployment may not
// own, possibly shared, running a credential to somebody else's database.
// `--dbname` carrying a full connection URI is the tempting shortcut that
// leaks it, so the connection is passed as separate flags and the secret
// travels in the child's environment.
//
// The tests assert the whole argv contains the password nowhere. Treat that as
// a security control, not a style preference.
// =============================================================================

/** The client this executor runs. Resolved from PATH, like every other probe. */
export const PG_DUMP_COMMAND = 'pg_dump';

/** `psql`, used only for the two best-effort provenance reads. */
export const PSQL_COMMAND = 'psql';

/** The archive format. `-Fc` is the only one `pg_restore` can list and reorder. */
export const BACKUP_ARCHIVE_FORMAT = 'custom';

/** Matches the server's `databaseBackup.compressionLevel` default. */
export const DEFAULT_COMPRESSION_LEVEL = 6;

/** How much of a child's stderr is kept, in bytes — the TAIL, never the head. */
export const STDERR_TAIL_BYTES = 8 * 1024;

/**
 * A PostgreSQL connection, already decoded, as the broker handed it over.
 *
 * DISCRETE FIELDS, NEVER A DSN — the same decision `pg-job-role.broker.ts`
 * makes when it mints one: a `postgresql://user:pass@host/db` string is one
 * accidental log line away from a leaked password, and building one means
 * percent-encoding a password into a URL.
 */
export interface PgConnection {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
  /** libqp's own spelling, passed through as `PGSSLMODE`. `null` to leave it unset. */
  sslMode: string | null;
}

/** A running child, shaped for `Promise.all([upload, dump.done])`. */
export interface PgProcess {
  /** The child's stdout, LIVE. Nothing here reads it — the caller pipes it. */
  stdout: Readable;
  /**
   * Settles exactly once: resolves on exit code 0, rejects otherwise.
   *
   * ⚠ THIS, NOT THE CONSUMER OF `stdout`, IS THE AUTHORITY ON SUCCESS. When a
   * dump dies half way through, its stdout simply ENDS — an upload sees a
   * clean EOF and reports a perfectly successful transfer of a TRUNCATED
   * archive. Only the exit code tells the two apart, which is why the executor
   * awaits both halves.
   */
  done: Promise<void>;
  /** Stops the child. SIGKILL, because a socket-blocked process may never act on SIGTERM. */
  kill(): void;
}

/** The `spawn` seam, so the tests need no PostgreSQL binaries. */
export type PgSpawnFn = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: ('pipe' | 'ignore')[] },
) => ChildProcess;

const defaultSpawn: PgSpawnFn = (command, args, options) => nodeSpawn(command, args, options);

/**
 * The `pg_dump` argument vector. Every flag is load-bearing:
 *
 *  - `-Fc` (custom format) is the ONLY format `pg_restore` can list, reorder
 *    and restore in parallel. The server VERIFIES an uploaded archive by
 *    reading its table of contents, so a plain-SQL dump from a node would be
 *    refused at submission — correctly, and confusingly.
 *  - `--no-owner` / `--no-acl` keep the source's ownership and grants OUT of
 *    the archive, so a restore onto a fresh machine does not fail on an
 *    `ALTER ... OWNER TO` naming a role that does not exist there. They are
 *    also what makes a SELECT-only minted role a sufficient dumper.
 *  - `-Z <level>` compresses inside `pg_dump`, before the bytes cross the
 *    network to object storage — which on a node is a real network, not a
 *    loopback.
 *  - `--no-password` turns a missing or wrong password into an immediate error
 *    instead of a prompt. There is no terminal on the other end of a worker.
 *  - NO `-f`: the archive goes to stdout, which is what makes it pipeable into
 *    a single-shot PUT with nothing ever landing on this machine's disk.
 */
export function buildPgDumpArgs(connection: PgConnection, compressionLevel = DEFAULT_COMPRESSION_LEVEL): string[] {
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

/** 0-9, CLAMPED rather than rejected: "dump at level 9" beats "take no backup". */
export function clampCompressionLevel(level: number): number {
  if (!Number.isFinite(level)) return DEFAULT_COMPRESSION_LEVEL;
  return Math.min(9, Math.max(0, Math.trunc(level)));
}

/**
 * libpq variables that are CLEARED before the child starts.
 *
 * ⚠ NOT PARANOIA — A WORKER NODE IS THE ONE PLACE THESE ARE LIKELY TO EXIST.
 * It is a general-purpose machine an operator has probably used to run `psql`
 * by hand, running containers with their own `PG*` settings, executing several
 * jobs' worth of environments. Explicit `--host`/`--username`/`--dbname` flags
 * beat the plain variables, but `PGSERVICE` and `PGPASSFILE` are read from
 * FILES that can supply their own connection parameters and their own
 * password — so a leftover service name could point this dump at a different
 * database entirely, or authenticate as somebody else, and the failure would
 * look like a broker bug.
 *
 * `PGSSLMODE` is here too because the broker TELLS us the mode: an inherited
 * one would silently downgrade (or upgrade) a connection the server chose the
 * transport for. It is put back below when the material names it.
 */
export const CLEARED_PG_ENV = [
  'PGHOST',
  'PGHOSTADDR',
  'PGPORT',
  'PGUSER',
  'PGDATABASE',
  'PGPASSWORD',
  'PGPASSFILE',
  'PGSERVICE',
  'PGSERVICEFILE',
  'PGSSLMODE',
  'PGOPTIONS',
  'PGREQUIRESSL',
] as const;

/**
 * The child's environment: this process's, minus every libpq variable, plus
 * exactly the credential the broker issued.
 *
 * INHERITED RATHER THAN BUILT FROM NOTHING, because a stripped environment
 * breaks things that have nothing to do with PostgreSQL — `PATH` finds the
 * binary, and a container's locale, CA bundle path and dynamic-linker settings
 * are all things `pg_dump` legitimately reads. What must not be inherited is
 * the connection, and that is what {@link CLEARED_PG_ENV} removes.
 *
 * ⚠ `PGPASSWORD` IS THE ONLY PLACE THE SECRET GOES. Never argv (world-readable
 * on Linux), never a file, and never this process's own `process.env` — the
 * value is written into the child's copy and nowhere else, so nothing that
 * outlives the job can read it back.
 */
export function pgClientEnv(connection: PgConnection): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  for (const key of CLEARED_PG_ENV) delete env[key];

  env.PGPASSWORD = connection.password;
  if (connection.sslMode !== null) env.PGSSLMODE = connection.sslMode;

  return env;
}

export interface SpawnPgDumpOptions {
  connection: PgConnection;
  compressionLevel?: number | undefined;
  command?: string | undefined;
  spawnFn?: PgSpawnFn | undefined;
}

/** Starts `pg_dump -Fc` and hands back its stdout as a live stream. */
export function spawnPgDump(options: SpawnPgDumpOptions): PgProcess {
  const spawnFn = options.spawnFn ?? defaultSpawn;
  const command = options.command ?? PG_DUMP_COMMAND;
  const args = buildPgDumpArgs(options.connection, options.compressionLevel);

  const child = spawnFn(command, args, {
    env: pgClientEnv(options.connection),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    // BOUNDED, AND THE TAIL. `pg_dump` can emit a warning per object, so an
    // unbounded capture is a memory leak that only appears on the databases
    // where dumps already hurt — and the head is the least useful part of it.
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-STDERR_TAIL_BYTES);
  });

  const done = new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    child.on('error', (error: Error) => {
      // A spawn failure — usually "pg_dump not found", which the capability
      // self-test should have caught at startup. Named, so the operator is not
      // left with a bare ENOENT.
      settle(() => reject(new Error(`Could not run ${command}: ${error.message}`)));
    });

    child.on('close', (code: number | null, signal: string | null) => {
      if (code === 0) {
        settle(resolve);
        return;
      }

      settle(() =>
        reject(
          new Error(
            `${command} exited ${signal !== null ? `on ${signal}` : `with code ${code}`}` +
              `${stderr.trim().length > 0 ? `: ${stderr.trim()}` : ''}`,
          ),
        ),
      );
    });
  });

  return {
    stdout: child.stdout as unknown as Readable,
    done,
    // SIGKILL: a dump does not usually hang on CPU, it hangs on a socket
    // waiting for a server that went away, and a process blocked in an
    // uninterruptible read may never act on SIGTERM.
    kill: () => child.kill('SIGKILL'),
  };
}
