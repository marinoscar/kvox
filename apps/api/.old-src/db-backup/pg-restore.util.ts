import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';

import {
  PgProcess,
  PgSpawnFn,
  pgClientEnv,
  spawnPgProcess,
  type PgConnection,
} from './pg-dump.util';

// =============================================================================
// pg_restore: replaying an archive, and reading its table of contents (#280)
// =============================================================================
//
// Two jobs, both on top of `spawnPgProcess` from `pg-dump.util.ts` — the same
// argv/environment/SIGKILL/settle-once guarantees, because there is exactly
// one place in this codebase that starts a `pg_*` process.
//
//   1. RESTORE. Replays a custom-format archive into a database (#285 restores
//      into a fresh one and then swaps it in under a maintenance window).
//   2. LIST. Reads an archive's table of contents WITHOUT CONNECTING TO
//      ANYTHING. `pg_restore --list` opens no database at all, which is what
//      makes it usable as the post-upload verification in #281: stream the
//      object that was just stored back through it, and an archive whose table
//      of contents is empty is an archive that would restore nothing.
//
// -----------------------------------------------------------------------------
// `--exit-on-error` IS THE ONE FLAG THIS FILE EXISTS FOR
// -----------------------------------------------------------------------------
//
// By default `pg_restore` treats errors as advisory: it logs each one,
// CONTINUES, and — this is the part that costs you the database — exits 0. A
// restore that failed on half its tables is indistinguishable, to every caller
// that checks an exit code, from one that worked. In #285 that half-populated
// database is then RENAMED INTO PLACE as the live one, and the intact original
// is renamed away. The data loss happens at the moment the restore reports
// success.
//
// With `--exit-on-error`, the first failure stops the process and produces a
// non-zero exit, `spawnPgProcess` rejects, and the swap never happens. There
// is a unit test asserting the flag is present; do not remove it to make a
// noisy restore quieter.
//
// NOT `--single-transaction`, which would be the other way to get all-or-
// nothing: it is mutually exclusive with the parallel `-j` restore #285 needs
// on any database large enough for this feature to matter. The safety comes
// from restoring into a SCRATCH database and only swapping a restore that
// exited 0 — the transaction boundary is the swap, not the restore.
// =============================================================================

/** Default binary name; `PG_DUMP_COMMAND` carries the note on why it is not an absolute path. */
export const PG_RESTORE_COMMAND = 'pg_restore';

/**
 * Upper bound on `-j`.
 *
 * Each parallel job is a separate connection AND a separate server-side
 * worker, so an unbounded value taken from a setting turns a restore into a
 * connection-limit outage on the server it is restoring to. Sixteen is far
 * past the point of diminishing returns for a restore that is almost always
 * I/O bound.
 */
export const MAX_RESTORE_JOBS = 16;

export interface PgRestoreArgsOptions {
  connection: PgConnection;
  /**
   * The archive to read.
   *
   * When absent, `pg_restore` reads stdin — which is what a restore streamed
   * straight out of object storage does, and which rules out `-j` (see below).
   */
  file?: string;
  /** Parallel jobs. Clamped to 1..{@link MAX_RESTORE_JOBS}; ignored without `file`. */
  jobs?: number;
}

/**
 * The `pg_restore` argument vector.
 *
 *  - `--exit-on-error` — see the module header. Load-bearing.
 *  - `--no-owner` / `--no-acl` mirror the dump's: the archive carries no
 *    ownership, and the restore must not try to reapply any.
 *  - `--no-password` fails instead of prompting; nothing is watching a
 *    terminal on a restore either.
 *  - `-j <N>` ONLY when restoring from a file. Parallel restore seeks around
 *    the archive to hand different table-data members to different workers,
 *    and a pipe cannot seek — `pg_restore` rejects the combination outright,
 *    so passing it with a stdin source would turn a working restore into an
 *    immediate usage error.
 *
 * The password is absent here, as everywhere: it travels in `PGPASSWORD`.
 */
export function buildPgRestoreArgs(options: PgRestoreArgsOptions): string[] {
  const { connection, file, jobs } = options;

  const args = [
    '--host',
    connection.host,
    '--port',
    connection.port,
    '--username',
    connection.user,
    '--dbname',
    connection.database,
    '--no-password',
    '--no-owner',
    '--no-acl',
    '--exit-on-error',
  ];

  if (file !== undefined && jobs !== undefined) {
    const parallel = clampRestoreJobs(jobs);
    if (parallel > 1) args.push('-j', String(parallel));
  }

  // Positional, and LAST: `pg_restore [options] <file>`. Without it the child
  // reads stdin, which is the streaming path.
  if (file !== undefined) args.push(file);

  return args;
}

/** Clamps `-j` into 1..{@link MAX_RESTORE_JOBS}; a non-finite value means "not parallel". */
export function clampRestoreJobs(jobs: number): number {
  if (!Number.isFinite(jobs)) return 1;
  return Math.min(MAX_RESTORE_JOBS, Math.max(1, Math.trunc(jobs)));
}

/**
 * The `pg_restore --list` argument vector.
 *
 * No connection flags at all, and that is the point: listing reads the archive
 * header and nothing else, so a verification can run against an object pulled
 * out of storage on a host that cannot reach the database.
 */
export function buildPgRestoreListArgs(options: { file?: string } = {}): string[] {
  return options.file === undefined ? ['--list'] : ['--list', options.file];
}

export interface SpawnPgRestoreOptions extends PgRestoreArgsOptions {
  /** Piped into the child's stdin. Required when `file` is absent. */
  stdin?: Readable;
  timeoutMs?: number;
  command?: string;
  spawnFn?: PgSpawnFn;
}

/** Starts `pg_restore` against `connection`, from a file or from a stream. */
export function spawnPgRestore(options: SpawnPgRestoreOptions): PgProcess {
  const { connection, file, jobs, stdin, timeoutMs, command, spawnFn } = options;

  return spawnPgProcess({
    command: command ?? PG_RESTORE_COMMAND,
    args: buildPgRestoreArgs({ connection, file, jobs }),
    password: connection.password,
    extraEnv: pgClientEnv(connection),
    stdin,
    timeoutMs,
    spawnFn,
  });
}

/**
 * Whether one line of `pg_restore --list` output is a table-of-contents entry.
 *
 * The listing is a header of `;`-prefixed comments followed by one line per
 * archive member:
 *
 *     ;
 *     ; Archive created at 2026-09-07 02:00:00 UTC
 *     ;     dbname: appdb
 *     ;
 *     215; 1259 16420 TABLE public users appuser
 *
 * so "entry" is precisely "not blank and not a comment". Counting lines
 * naively would report a healthy count for an EMPTY archive, whose listing is
 * all header — which is exactly the case the verification in #281 has to
 * catch.
 */
export function isTocEntryLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed !== '' && !trimmed.startsWith(';');
}

/** Counts the table-of-contents entries in a complete `pg_restore --list` output. */
export function parseTocEntryCount(listing: string): number {
  return listing.split('\n').filter(isTocEntryLine).length;
}

export interface ReadTocEntryCountOptions {
  /** A stream of archive bytes, or a path to an archive file. */
  source: Readable | { file: string };
  timeoutMs?: number;
  command?: string;
  spawnFn?: PgSpawnFn;
}

/**
 * Runs `pg_restore --list` over an archive and returns how many entries its
 * table of contents holds.
 *
 * ZERO IS A LEGITIMATE ANSWER, and the one worth acting on: an archive that
 * lists nothing is a file that would restore an empty database. #281 verifies
 * a freshly uploaded backup by streaming the stored object back through here
 * and failing the run when the count is zero — which catches a truncated
 * upload, a zero-byte object, and a dump that ran against the wrong (empty)
 * database, none of which are visible in an exit code or a byte count alone.
 *
 * The lines are counted AS THEY ARRIVE rather than buffered: the table of
 * contents of a large schema is itself large, and the whole point of this
 * subsystem is that nothing about a backup is proportional to the heap.
 */
export async function readTocEntryCount(options: ReadTocEntryCountOptions): Promise<number> {
  const { source, timeoutMs, command, spawnFn } = options;
  const file = source instanceof Readable ? undefined : source.file;

  const child = spawnPgProcess({
    command: command ?? PG_RESTORE_COMMAND,
    args: buildPgRestoreListArgs({ file }),
    stdin: source instanceof Readable ? source : undefined,
    timeoutMs,
    spawnFn,
  });

  let entries = 0;
  // `crlfDelay: Infinity` so a `\r\n` archive listing (a dump produced on
  // Windows, or piped through a tool that rewrote the line endings) is not
  // counted as twice as many lines.
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });

  for await (const line of lines) {
    if (isTocEntryLine(line)) entries += 1;
  }

  // AFTER the stream is drained, never instead of it. A non-zero exit here
  // means the archive is unreadable — a corrupt object, or one that is not a
  // custom-format archive at all — and that must fail the verification even
  // though some entries may already have been counted.
  await child.done;

  return entries;
}
