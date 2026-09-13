import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DatabaseBackupRun, Job, Prisma } from '@prisma/client';

import { PERMISSIONS } from '../common/constants/roles.constants';
import { MaintenanceModeService } from '../common/maintenance/maintenance-mode.service';
import type { SystemDatabaseBackupValue } from '../common/schemas/settings.schema';
import type { RestoreCompletedEmailData } from '../email';
import { JobsService } from '../jobs/jobs.service';
import { jobTempPath } from '../jobs/job-temp';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from '../storage/providers/storage-provider.interface';
import {
  buildScratchDatabaseName,
  createDatabase,
  databaseExists,
  dropDatabase,
  renameDatabase,
  resolveAdminConnection,
  terminateConnections,
  withAdminConnection,
  type AdminConnection,
  type AdminQueryClient,
} from './admin-connection.util';
import { DatabaseBackupRunnerService } from './db-backup-runner.service';
import {
  DatabaseRestoreArchiveError,
  DatabaseRestoreSwapError,
  DatabaseRestoreVerificationError,
} from './db-backup.errors';
import type { PgConnection } from './pg-dump.util';
import { readTocEntryCount, spawnPgRestore } from './pg-restore.util';
import {
  GUIDED_RESTORE_JOBS,
  DatabaseRestorePreflightService,
  type RestorePreflightResult,
} from './restore-preflight.service';

// =============================================================================
// The scratch-database restore and the atomic swap (issue #285, epic #254)
// =============================================================================
//
// This is the file that replaces a production database. Everything in it exists
// to hold ONE property:
//
//     THE APPLICATION SERVES NORMALLY THROUGHOUT THE ENTIRE RESTORE, AND THE
//     ONLY DESTRUCTIVE WINDOW IS TWO CATALOG UPDATES LONG.
//
// -----------------------------------------------------------------------------
// WHY NOT `pg_restore --clean` AGAINST THE LIVE DATABASE
// -----------------------------------------------------------------------------
//
// ⚠ REJECTED OUTRIGHT. DO NOT REINTRODUCE IT. The reason is written here rather
// than in a design document because it is the obvious implementation and it
// will be proposed again by somebody who has not thought about the failure:
//
//   `--clean` emits a `DROP` for every object in the archive before recreating
//   it. Those objects include `database_backup_runs` — THE TABLE TRACKING THE
//   RESTORE'S OWN PROGRESS — and `system_settings`, and `users`. If it fails
//   midway (an extension the server does not have, a client older than the
//   server, a network blip at 40 GB) what is left is a live database with half
//   its tables dropped: an application that cannot boot, no admin UI to look at,
//   no catalog to say what happened, and no way back except another restore of
//   the archive that just failed. The destructive window is not the swap. It is
//   THE WHOLE RESTORE, which on any database worth backing up is hours.
//
// And a restore IS hours. A `pg_dump` archive stores `CREATE INDEX`, not index
// data, so every index in the database is rebuilt from scratch on the way in.
// That single fact is what makes "restore somewhere else, then rename" not
// merely safer but the only sane shape: a window measured in hours must not be
// a window in which the application is broken.
//
// -----------------------------------------------------------------------------
// THE SHAPE
// -----------------------------------------------------------------------------
//
//   1. Download the archive to a seekable temp file; RE-VERIFY checksum and TOC.
//   2. (`pre_restore_dump` mode only) take a fresh safety backup.
//   3. `CREATE DATABASE <live>_restore_<ts>`
//   4. `pg_restore -j N` into it          ← the app is FULLY UP for all of this
//   5. Verify the restored database.
//   6. Swap, in seconds.
//
// ⚠ A FAILURE AT ANY POINT BEFORE THE RENAME LEAVES THE LIVE DATABASE
// COMPLETELY UNTOUCHED and drops the scratch database. Steps 1-5 create exactly
// one thing (a database with a name no other process uses) and one temp file,
// and both are removed on the way out. There is an explicit test per phase.
//
// -----------------------------------------------------------------------------
// WHY THE ARCHIVE IS DOWNLOADED TO A FILE INSTEAD OF STREAMED
// -----------------------------------------------------------------------------
//
// `pg_restore -j N` SEEKS. Parallel restore hands different table-data members
// to different workers, which means jumping around the archive, which a pipe
// cannot do — `pg_restore` rejects `-j` with a stdin source outright (see
// `pg-restore.util.ts`). Streaming the object straight into `pg_restore` would
// therefore forfeit ALL parallelism on the phase that dominates the runtime, to
// save a temp file on a host that is about to hold a second copy of the whole
// database anyway.
//
// The file carries `JOB_TEMP_PREFIX` — the application's janitor-swept prefix —
// so that a SIGKILL between the download and the delete cannot leak it forever.
// That import reaches into `jobs/` on purpose, and it is the one case where
// copying the prefix would be wrong: `db-backup-storage.ts` deliberately
// duplicated `job-temp.ts`'s slugifier because it only needed the same SHAPE,
// whereas this file needs the same VALUE — a file whose prefix merely resembles
// the janitor's is a file the janitor never sweeps.
//
// -----------------------------------------------------------------------------
// WHY THE CHECKSUM IS RE-VERIFIED WHEN #281 ALREADY VERIFIED IT
// -----------------------------------------------------------------------------
//
// Because #281 verified a DIFFERENT THING: that the bytes were readable and
// hashed to the recorded value AT UPLOAD TIME, possibly months ago. This
// verifies the bytes AS THEY ARE NOW, which catches bit-rot, a storage
// lifecycle rule that moved the object to a tier that returned something else, a
// truncated download, and a proxy that ended the transfer early. Trusting the
// stored checksum is trusting a measurement of a file nobody has looked at
// since — and the moment you find out it was wrong would otherwise be after the
// swap.
//
// -----------------------------------------------------------------------------
// THE SWAP, AND THE ONE GENUINELY DANGEROUS MOMENT
// -----------------------------------------------------------------------------
//
//     maintenance ON (allowAdmins: false)
//     prisma.$disconnect()  +  terminateConnections(live)
//     rename live    -> old        ← from here there is NO DATABASE NAMED <live>
//     rename scratch -> live       ← ...until here
//        on failure: rename old -> live, and rethrow
//
// ⚠ BETWEEN THE TWO RENAMES THERE IS NO DATABASE UNDER THE LIVE NAME AT ALL.
// That is why traffic must already be stopped before the first rename, and why
// the maintenance window is opened with `allowAdmins: false`:
//
//   - The PERSISTED maintenance flag lives INSIDE the database being renamed,
//     so during those seconds it is unreadable. `MaintenanceModeService` has an
//     IN-MEMORY override layer for exactly this caller and says so in its own
//     header; this is the only thing in the repository that sets it.
//   - `allowAdmins: true` would be actively wrong here rather than merely
//     generous. An admin request during the window does not get "access to a
//     degraded system"; it gets a connection attempt against a database that
//     momentarily does not exist.
//
// The inner recovery — renaming the original back when the second rename fails
// — is the single most important `catch` in this subsystem, and it has a test of
// its own. What it cannot do is guarantee success: if the recovery rename ALSO
// fails there is no database under the live name and a human must finish or undo
// the swap by hand. `DatabaseRestoreSwapError.originalRestored` is how the
// difference is reported, and in that case the maintenance window is deliberately
// LEFT OPEN so the deployment answers 503 rather than five hundred stack traces.
//
// -----------------------------------------------------------------------------
// TWO THINGS THE SWAP INTRODUCES
// -----------------------------------------------------------------------------
//
// 1. CATALOG CARRY-OVER. The restored database contains `database_backup_runs`
//    AS OF BACKUP TIME. Swap it in naively and this restore's own record, every
//    backup taken since the archive was made, and the `pre_restore` safety dump
//    taken ten minutes ago all cease to exist — including the row that says
//    where the way back is stored. So the rows are EXPORTED BEFORE THE RENAME,
//    WITH THIS RUN'S POST-SWAP AUDIT FIELDS ALREADY APPLIED (writing "restore
//    completed" into a database nobody will ever open again is exactly the
//    mistake this avoids) and re-inserted afterwards. See {@link exportCatalog}
//    for the FK rules, which are the subtle part.
//
// 2. MIGRATION ROLL-FORWARD. `_prisma_migrations` also comes from the archive,
//    so after the swap the restored database is at the ARCHIVE's migration. That
//    is precisely what #284's `schema_compatibility` gate detects and what
//    `prisma migrate deploy` fixes. IT IS DOCUMENTED AND NOT RUN AUTOMATICALLY:
//    a migration is a schema change against data an operator has just decided to
//    trust, and running it unattended inside a restore would make one
//    irreversible act into two.
//
// -----------------------------------------------------------------------------
// IT ENDS IN `process.exit(0)`
// -----------------------------------------------------------------------------
//
// The connection pool is bound to a database that has just been renamed out from
// under it, and every pooled session was terminated to allow that rename. There
// is no API that rebuilds a Prisma pool in place, and a process holding stale
// sessions to a database that no longer exists under that name cannot be trusted
// to serve. Exiting hands the problem to the supervisor, which is the one
// component that can solve it.
//
// ⚠ THIS MAKES A RESTART POLICY A HARD REQUIREMENT. `restart: unless-stopped`
// (or a Kubernetes Deployment) — WITHOUT IT, AN OTHERWISE SUCCESSFUL RESTORE
// LEAVES THE APPLICATION DOWN. The swap also assumes a SINGLE API REPLICA: the
// maintenance flag is per-process, so any other replica keeps serving traffic,
// gets terminated mid-request, and then talks to a renamed database. Both are
// pre-flight warnings (#284's `replicas` gate, and the runbook's §7) and both
// are prerequisites an operator satisfies in advance, not things this code can
// enforce.
//
// The exit is behind {@link DatabaseRestoreSeam.exitProcess} so the suite can
// assert it happened without killing the Jest worker.
// =============================================================================

/**
 * The states written to `database_backup_runs.restore_status`.
 *
 * `restoring` covers everything from the download to the last byte
 * `pg_restore` writes — the phase that takes hours — because splitting it
 * further would imply a progress signal this design does not have: a
 * `pg_restore` in flight reports nothing a caller could poll, and inventing
 * finer states that all mean "still restoring" would be dishonest precision.
 *
 * A plain string column rather than an enum, exactly as `schema.prisma` says:
 * adding `rolled_back` below cost no migration, which is the whole argument.
 */
export const RESTORE_STATUSES = [
  'restoring',
  'verifying',
  'swapping',
  'completed',
  'failed',
  /** A restore that was swapped in and then undone. See {@link DatabaseRestoreService.rollback}. */
  'rolled_back',
] as const;

export type RestoreStatus = (typeof RESTORE_STATUSES)[number];

/** Audit actions. `<area>:<verb>`, matching `maintenance:enable` and `users:update`. */
export const RESTORE_AUDIT_START = 'db_restore:start';
export const RESTORE_AUDIT_SWAP = 'db_restore:swap';
export const RESTORE_AUDIT_COMPLETE = 'db_restore:complete';
/**
 * Not one of the three the issue names, and it earns its place: a restore that
 * FAILED is the one an operator greps `audit_events` for, and without this row
 * the only trace of it in that table is a `db_restore:start` with nothing after
 * it — indistinguishable from a restore that is still running.
 */
export const RESTORE_AUDIT_FAILED = 'db_restore:failed';
/** Written into the database the rollback promoted, after the renames. */
export const RESTORE_AUDIT_ROLLBACK = 'db_restore:rollback';

/** `target_type` on every row above; `target_id` is the backup run's id. */
export const RESTORE_AUDIT_TARGET_TYPE = 'database_backup_run';

/**
 * Parallel `pg_restore` jobs.
 *
 * THE SAME NUMBER THE GUIDED COMMAND BLOCK PRINTS, and deliberately imported
 * rather than restated: an operator who pasted #284's block and an operator who
 * pressed the button must not get restores with different performance
 * characteristics, or the two paths become impossible to compare when one of
 * them is slow.
 */
export const RESTORE_JOBS = GUIDED_RESTORE_JOBS;

/**
 * How often the `pre_restore` safety backup's row is re-read while waiting for
 * it.
 *
 * `startBackup` is DETACHED by contract (it returns as soon as the row is
 * claimed, because a multi-gigabyte dump outlives every HTTP timeout in the
 * stack), so the only way to know it finished is to watch the row it writes.
 * Five seconds against a dump measured in minutes to hours is free.
 */
export const PRE_RESTORE_POLL_INTERVAL_MS = 5_000;

/**
 * Extra grace on top of `databaseBackup.runStaleMinutes` before giving up on
 * the safety backup.
 *
 * The dump's own budget IS the stale window (see the runner), so a run that has
 * outlived the window plus this margin is one the stale sweep is about to
 * settle. Waiting longer would mean a restore that hangs forever because a
 * container disappeared.
 */
export const PRE_RESTORE_SETTLE_GRACE_MS = 60_000;

/**
 * How long the rollback waits before exiting, so its HTTP response can be
 * flushed first.
 *
 * ⚠ THE RESTORE'S OWN SWAP NEEDS NO SUCH DELAY and does not take one: it runs
 * detached, and the request that started it was answered hours earlier. A
 * rollback is different — it is fast enough that an operator is still holding
 * the connection when the process decides to exit, and killing the process
 * mid-response would show them a network error for an operation that succeeded.
 */
export const ROLLBACK_EXIT_DELAY_MS = 500;

/**
 * What a blocked caller is shown during the swap.
 *
 * ⚠ NO APPLICATION, PRODUCT OR REPOSITORY NAME. This is a template; every
 * user-visible string in it describes what is happening, not whose it is.
 */
export const RESTORE_MAINTENANCE_MESSAGE =
  'A database restore is being completed. The service will return on its own within a ' +
  'few minutes; no action is needed.';

// -----------------------------------------------------------------------------
// The queue type, and what one restore job carries (#353, epic #345)
// -----------------------------------------------------------------------------

/**
 * The `Job.type` every restore row carries.
 *
 * DEFINED HERE, NOT IN THE HANDLER, for the reason `BACKUP_JOB_TYPE` is defined
 * in the runner: the enqueueing side and the executing side must agree on this
 * string exactly, and only one of the two can own the definition. This service
 * enqueues, so it owns it and `handlers/db-restore-run.handler.ts` imports it.
 *
 * PERMANENT once rows of this type exist — `jobs` rows outlive the handler that
 * produced them, so renaming this orphans every historical restore.
 */
export const DB_RESTORE_RUN_TYPE = 'db.restore.run';

/**
 * What `startRestore` writes into the job's payload, and what the handler reads
 * back out.
 *
 * ⚠ THE FOUR DERIVED VALUES ARE CARRIED, NOT RECOMPUTED, and that is the one
 * decision in this interface. `scratchDatabase`, `oldDatabase` and `startedAt`
 * come from the PRE-FLIGHT this restore was gated by, and they have already
 * been handed to the caller in the `started` result. Deriving them again in the
 * handler — from a different `now`, minutes later — would produce different
 * names, and the API response, the run row and the DDL would then name three
 * databases. `startRestore`'s own comment already makes this argument about the
 * pre-flight's names versus freshly derived ones; the queue simply widens the
 * gap between the two clocks from microseconds to however long the job waits.
 *
 * `rollbackMode` is carried for the same reason: it is the pre-flight's
 * EFFECTIVE mode, which disk pressure may have downgraded, and re-deciding it
 * later could take a restore the operator was told would be reversible by
 * rename and quietly make it reversible only by a multi-hour replay.
 *
 * Identifiers only, per `EnqueueJobInput.payload` — `runId` is re-read at run
 * time so the handler works from the row's current state.
 */
export interface RestoreJobPayload {
  runId: string;
  actorUserId: string | null;
  scratchDatabase: string;
  oldDatabase: string;
  rollbackMode: 'retain_database' | 'pre_restore_dump';
  /** ISO-8601. The instant the restore was accepted, not the instant it ran. */
  startedAt: string;
}

/**
 * Narrows a job's opaque payload to {@link RestoreJobPayload}, or throws.
 *
 * THROWS RATHER THAN DEFAULTING, and this is the one place in this file where
 * that is obviously right: every field is a database NAME or an identity, and a
 * defaulted one would be a `CREATE DATABASE`/`ALTER DATABASE ... RENAME`
 * against a name nobody chose. A malformed payload is a bug, and a `failed` job
 * carrying "malformed payload" is the correct outcome — with `maxAttempts: 1`
 * it is also a final one, so nothing retries a restore whose plan cannot be
 * read.
 */
export function parseRestoreJobPayload(payload: unknown): RestoreJobPayload {
  const value = (payload ?? {}) as Record<string, unknown>;

  const str = (key: keyof RestoreJobPayload): string => {
    const raw = value[key];

    if (typeof raw !== 'string' || raw.length === 0) {
      throw new Error(
        `The restore job's payload is missing "${String(key)}"; it cannot be run. This ` +
          'job was queued by a version of startRestore that wrote a different shape, or ' +
          'the payload was edited.'
      );
    }

    return raw;
  };

  const mode = value.rollbackMode;

  if (mode !== 'retain_database' && mode !== 'pre_restore_dump') {
    throw new Error(
      `The restore job's payload carries an unknown rollbackMode (${String(mode)}); it ` +
        'cannot be run.'
    );
  }

  const actorUserId = value.actorUserId;

  return {
    runId: str('runId'),
    actorUserId: typeof actorUserId === 'string' && actorUserId.length > 0 ? actorUserId : null,
    scratchDatabase: str('scratchDatabase'),
    oldDatabase: str('oldDatabase'),
    rollbackMode: mode,
    startedAt: str('startedAt'),
  };
}

// -----------------------------------------------------------------------------
// Results
// -----------------------------------------------------------------------------

/** What `startRestore` decided. #286 turns each case into a status code. */
export type StartRestoreResult =
  /** Accepted. The work is detached; poll `restore_status` on the run. */
  | {
      outcome: 'started';
      runId: string;
      scratchDatabase: string;
      oldDatabase: string;
      preflight: RestorePreflightResult;
    }
  /**
   * The pre-flight did not come back `ok`, so NOTHING was started and nothing
   * was created. The whole verdict is returned rather than an error message:
   * a `guided` outcome carries a command block the operator needs.
   */
  | { outcome: 'refused'; preflight: RestorePreflightResult }
  /**
   * A restore is already in flight IN THIS PROCESS.
   *
   * ⚠ A RESULT, NOT AN EXCEPTION, and PROCESS-LOCAL, and both are honest rather
   * than convenient. Nothing has gone wrong — #286 turns this into a 409 the
   * same way `CancelBackupResult` turns `not_running_here` into a truthful
   * answer. And there is no database constraint that could do better: a
   * restore's state lives on the row of the BACKUP it replays, so two restores
   * of two different archives are two different rows and no unique index over
   * them can conflict. What actually makes concurrent restores impossible is the
   * SINGLE-REPLICA prerequisite the `replicas` gate warns about and the runbook
   * states; this guard is the in-process half of it, for the case that
   * prerequisite is met and an operator double-clicks.
   */
  | { outcome: 'already_running'; runId: string };

/** What `rollback` managed. All three are honest answers, including the last. */
export type RestoreRollbackResult =
  /**
   * `retain_database` mode: the displaced database was renamed back into place.
   * SECONDS — this is the entire justification for paying roughly double the
   * PostgreSQL volume during the retention window.
   */
  | { outcome: 'renamed'; runId: string; promoted: string; parked: string }
  /**
   * `pre_restore_dump` mode: there is no database to rename, so this delegates
   * back into the restore path against the safety backup. HOURS.
   */
  | { outcome: 'restore_started'; runId: string; preRestoreRunId: string }
  /**
   * Neither exists. REPORTED HONESTLY RATHER THAN AS A FAILURE: nothing went
   * wrong just now, the rollback window simply closed, and an operator needs to
   * know that as a fact rather than as an error to retry.
   */
  | { outcome: 'unavailable'; runId: string; reason: string };

export interface StartRestoreOptions {
  /** The administrator who asked. `null` only for an internal delegation. */
  actorUserId?: string | null;
  /** Passed straight through to the pre-flight; unblocks the schema gate alone. */
  overrideSchemaMismatch?: boolean;
  /** Injected so a test can pin the derived database names. */
  now?: Date;
}

// -----------------------------------------------------------------------------
// The seam
// -----------------------------------------------------------------------------

/**
 * Everything this service does that touches a cluster, a disk, a child process
 * or the process's own lifetime.
 *
 * ONE OBJECT, INJECTED AS A WHOLE, following `RestorePreflightSeam` and
 * `DatabaseBackupEngine`: a suite that needs a live PostgreSQL, a `pg_restore`
 * binary and permission to call `process.exit` is a suite CI skips, and a
 * skipped test guards nothing — which for THIS file would mean the swap
 * sequence is not tested at all.
 */
export interface DatabaseRestoreSeam {
  resolveConnection(): AdminConnection;
  /**
   * One unit of work on a maintenance-database session.
   *
   * ⚠ UNBOUNDED, unlike pre-flight's. `admin-connection.util.ts` §
   * `statement_timeout` explains why: a wall-clock bound that fires part-way
   * through `CREATE DATABASE` or `ALTER DATABASE ... RENAME` buys ambiguity
   * about the state of the database the application is about to be pointed at,
   * and there is no safe automated response to "maybe".
   */
  withAdminConnection<T>(
    config: AdminConnection,
    fn: (client: AdminQueryClient) => Promise<T>
  ): Promise<T>;
  /** An absolute path carrying the janitor-swept prefix. Creates nothing. */
  tempFilePath(): string;
  /** Streams `source` to `path`, hashing and counting in the SAME single pass. */
  writeArchiveToFile(source: Readable, path: string): Promise<{ bytes: bigint; sha256: string }>;
  /** `pg_restore --list` over a local file. Zero means "restores nothing". */
  readTocEntryCount(file: string): Promise<number>;
  /** `pg_restore --exit-on-error -j N` into an existing database. */
  runPgRestore(options: { connection: PgConnection; file: string; jobs: number }): Promise<void>;
  /** Best-effort removal; a missing file is not an error. */
  removeFile(path: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): Date;
  /**
   * Ends this process so a supervisor can start one with a fresh pool.
   *
   * A SEAM, not a direct call, for one reason: a test that exercised the swap
   * would otherwise kill its own Jest worker, so the most dangerous sequence in
   * the repository would be the one sequence with no test.
   */
  exitProcess(code: number, delayMs?: number): void;
}

/**
 * DI token for {@link DatabaseRestoreSeam}.
 *
 * OPTIONAL AND LEFT UNBOUND in `DbBackupModule`, the same discipline
 * `DB_BACKUP_ENGINE`, `JOB_CLOCK` and `RESTORE_PREFLIGHT_SEAM` follow. A stubbed
 * seam in production would be a restore that reports success having renamed
 * nothing — or, worse, an `exitProcess` that does not exit, leaving a process
 * serving from a pool pointed at a database that no longer exists.
 */
export const DATABASE_RESTORE_SEAM = 'DATABASE_RESTORE_SEAM';

/** The real seam. Every member is a thin binding to the utility that owns it. */
export const defaultDatabaseRestoreSeam: DatabaseRestoreSeam = {
  resolveConnection: () => resolveAdminConnection(),

  // No `timeoutMs`: see the interface.
  withAdminConnection: (config, fn) => withAdminConnection(config, fn),

  tempFilePath: () => jobTempPath('.dump'),

  writeArchiveToFile: async (source, path) => {
    const hash = createHash('sha256');
    let bytes = 0n;

    // The same metering `Transform` the backup engine uses, for the same
    // reason: the checksum and the byte count come out of the single pass the
    // write is already making. Buffering the archive to hash it first would put
    // a whole production database in this process's heap.
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        bytes += BigInt(chunk.length);
        callback(null, chunk);
      },
    });

    // `pipeline` rather than three `.pipe()` calls: it propagates errors and
    // destroys every stream in the chain, so a storage read that dies half way
    // cannot leave a write stream holding a file handle open.
    await pipeline(source, meter, createWriteStream(path));

    return { bytes, sha256: hash.digest('hex') };
  },

  readTocEntryCount: (file) => readTocEntryCount({ source: { file } }),

  runPgRestore: async ({ connection, file, jobs }) => {
    const child = spawnPgRestore({ connection, file, jobs });

    // Drained, never read. `pg_restore` writing to a database says little on
    // stdout, but a child whose stdout nobody consumes blocks forever once the
    // pipe buffer fills, and "the restore hung at 64 KiB of notices" is not a
    // failure anyone would diagnose quickly.
    child.stdout.resume();

    // ⚠ `done` IS THE AUTHORITY, and with `--exit-on-error` it means what it
    // says: the first failed statement stops the process and rejects this.
    await child.done;
  },

  removeFile: async (path) => {
    await rm(path, { force: true });
  },

  sleep: (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      // Unreferenced so a pending wait cannot by itself hold a shutting-down
      // process (or a Jest worker) open.
      timer.unref?.();
    }),

  now: () => new Date(),

  exitProcess: (code, delayMs = 0) => {
    if (delayMs <= 0) {
      process.exit(code);
    }

    const timer = setTimeout(() => process.exit(code), delayMs);
    timer.unref?.();
  },
};

// -----------------------------------------------------------------------------
// Catalog carry-over
// -----------------------------------------------------------------------------

/**
 * One `database_backup_runs` row, flattened for re-insertion by raw SQL.
 *
 * ⚠ NOT A PRISMA MODEL, and it cannot be: the rows are re-inserted through a
 * `pg.Client` attached to the freshly promoted database, which Prisma has no
 * way to reach (it is bound to one database, by URL, at startup — the whole
 * reason `admin-connection.util.ts` exists). Everything is a string or `null`
 * so the values survive the trip through `pg`'s parameter binding without a
 * `bigint` or a `Date` being reformatted differently on either side.
 */
interface CarriedRun {
  id: string;
  status: string;
  trigger: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastHeartbeatAt: string | null;
  bytesWritten: string;
  sizeBytes: string;
  storageProvider: string;
  storageKey: string;
  bucket: string;
  format: string;
  checksumSha256: string | null;
  dbVersion: string | null;
  appVersion: string | null;
  migrationName: string | null;
  verifiedAt: string | null;
  lastError: string | null;
  createdById: string | null;
  restoreStatus: string | null;
  restoreError: string | null;
  restoredAt: string | null;
  restoredById: string | null;
  restoreScratchDb: string | null;
  restoreOldDb: string | null;
  swappedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One row's self-FK, applied in a SECOND PASS. See {@link exportCatalog}. */
interface CarriedSelfLink {
  id: string;
  preRestoreBackupId: string;
}

/**
 * An `audit_events` row written into the promoted database, after the renames.
 *
 * ⚠ THE `id` IS GENERATED HERE, not by the database. `audit_events.id` lost its
 * server-side default in `20260831014110_drop_stale_uuid_defaults` — every
 * other id in this application is generated client-side by Prisma — so an
 * INSERT that leaves the column out raises a NOT NULL violation. It is carried
 * on the row rather than minted at the moment of the INSERT for the same reason
 * every other value here is: {@link CarriedCatalog} is the complete description
 * of what the swap will write, and {@link DatabaseRestoreService.reinsertCatalog}
 * only binds what it was given.
 *
 * FRESHLY GENERATED, NOT PRESERVED, and that is the difference from
 * {@link CarriedRun.id}. A run is an EXISTING row read out of the database
 * being displaced, so carrying it over must preserve its identity or the
 * promoted copy would be a duplicate. This audit row has no original: nothing
 * ever wrote `db_restore:complete` anywhere — {@link exportCatalog}'s caller
 * builds it in memory precisely so it lands only in the database that survives
 * the swap. There is no id to preserve, so a new one is correct.
 */
interface CarriedAudit {
  /** A v4 UUID. See the note above: `audit_events` has no server-side default. */
  id: string;
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  meta: Record<string, unknown>;
}

/**
 * THE RESTORE'S OWN `jobs` ROW, settled, carried into the promoted database
 * (#353, epic #345).
 *
 * ⚠ READ THIS BEFORE CHANGING ANYTHING ABOUT THE SWAP'S ORDERING. Making the
 * restore a queue job creates a problem no other job type has: `process()`
 * NEVER RETURNS, because the process exits inside it (see
 * {@link DatabaseRestoreSeam.exitProcess} and the block comment at the exit).
 * The worker's terminal write therefore never runs, and without something in
 * its place the sequence is:
 *
 *   1. the swap succeeds and the process exits;
 *   2. the `jobs` row is left `running` with a live lease;
 *   3. the supervisor restarts the API, the reaper finds an expired lease, and
 *      — because this type declares `maxAttempts: 1` — permanently FAILS it.
 *
 * That last step is the right protection (a REQUEUED restore would replay a
 * restore that already succeeded, which is the worst outcome available in this
 * subsystem), but it records a perfectly successful restore as a `failed` job.
 * A job row that lies is not an acceptable price for a job row that exists.
 *
 * So the terminal write JOINS THE CATALOG CARRY. That is not a workaround; it
 * is the only place it can correctly go, and the reason is the same one
 * {@link exportCatalog} already gives for the run row's audit values: after the
 * renames, Prisma's `liveDatabase` name resolves to the PROMOTED database,
 * whose `jobs` table is the ARCHIVE's. A `succeeded` written before the swap
 * lands in the database that is about to be renamed away and dropped — it would
 * vanish, and worse, if the rename then FAILED and the original were put back,
 * the row would claim a restore succeeded that did not. Writing it as part of
 * the carry means it is written IF AND ONLY IF both renames have succeeded, into
 * the database that survives, immediately before the exit.
 *
 * Everything else about this row is the shape `JobTerminalService
 * .completeSucceeded` would have written: `succeeded`, `finished_at` stamped,
 * `scheduled_for`, `lease_expires_at` and `claimed_by_node_id` all cleared,
 * `executor` and `last_error` preserved. Nothing that reads a job row after the
 * restart can tell the difference, which is the point.
 */
interface CarriedJob {
  id: string;
  type: string;
  subjectType: string | null;
  subjectId: string | null;
  dedupKey: string | null;
  reason: string;
  priority: number;
  payload: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string;
  executor: string | null;
}

/** Everything that has to survive the rename, gathered before it. */
interface CarriedCatalog {
  runs: CarriedRun[];
  selfLinks: CarriedSelfLink[];
  audit: CarriedAudit;
  /**
   * The restore's own job row, settled. `null` only when the restore was not
   * run from a job at all — which no supported path produces since #353, and
   * which the type keeps expressible so a directly-constructed test double (and
   * any fork that calls `executeRestore` by hand) does not have to invent one.
   */
  job: CarriedJob | null;
}

/**
 * The settled `jobs` row, upserted into the promoted database.
 *
 * ⚠ `ON CONFLICT (id) DO UPDATE`, NOT `DO NOTHING`, and it is not theoretical
 * which case needs it. A `pre_restore` safety dump is taken DURING the restore,
 * so that archive contains this very job row as `running` — and rolling that
 * dump back replays it. `DO NOTHING` would keep the stale `running` copy, with
 * its lease, and the reaper would fail it after the restart. The upsert
 * overwrites it with the truth.
 *
 * ⚠ `claimed_by_node_id` IS WRITTEN NULL AND IS NOT A PARAMETER. This type is
 * server-only permanently (see the handler's header), so there is never a node
 * to attribute — and `jobs.claimed_by_node_id` references `worker_nodes`, whose
 * copy in the promoted database is the ARCHIVE's. Binding a node id the archive
 * has never heard of would raise a foreign-key violation and abort the whole
 * carry, losing the backup catalog to preserve an attribution that does not
 * exist. `lease_expires_at` and `scheduled_for` are NULL for the reason
 * `completeSucceeded` clears them: a terminal row must not appear to be held by
 * anybody.
 */
const CARRY_JOB_SQL = `
INSERT INTO jobs (
  id, type, subject_type, subject_id, dedup_key, status, reason, priority,
  payload, attempts, last_error, created_at, started_at, finished_at,
  scheduled_for, rate_limited_at, rate_limit_hits, claimed_by_node_id,
  lease_expires_at, executor
) VALUES (
  $1::uuid, $2, $3, $4, $5, 'succeeded'::"JobStatus", $6::"JobReason", $7::int,
  $8::jsonb, $9::int, $10, $11::timestamptz, $12::timestamptz, $13::timestamptz,
  NULL, NULL, 0, NULL,
  NULL, $14
)
ON CONFLICT (id) DO UPDATE SET
  type = EXCLUDED.type,
  subject_type = EXCLUDED.subject_type,
  subject_id = EXCLUDED.subject_id,
  dedup_key = EXCLUDED.dedup_key,
  status = EXCLUDED.status,
  reason = EXCLUDED.reason,
  priority = EXCLUDED.priority,
  payload = EXCLUDED.payload,
  attempts = EXCLUDED.attempts,
  last_error = EXCLUDED.last_error,
  created_at = EXCLUDED.created_at,
  started_at = EXCLUDED.started_at,
  finished_at = EXCLUDED.finished_at,
  scheduled_for = NULL,
  rate_limited_at = NULL,
  claimed_by_node_id = NULL,
  lease_expires_at = NULL,
  executor = EXCLUDED.executor
`.trim();

/**
 * Pass one: every column EXCEPT the self-FK.
 *
 * ⚠ THE TWO USER FKs GO THROUGH A SUBSELECT, and that is the load-bearing
 * detail. `created_by_id` and `restored_by_id` reference `users(id)`, and the
 * promoted database's `users` table is the ARCHIVE's — so an administrator who
 * was created after the backup was taken does not exist in it. A plain value
 * would raise a foreign-key violation and abort the WHOLE carry-over, losing
 * every backup record to preserve one attribution. `(SELECT id FROM users WHERE
 * id = $n)` yields NULL instead, which is exactly what the column already means
 * for a scheduled run, and which `onDelete: SetNull` already declares as the
 * behaviour when an actor goes away.
 *
 * `ON CONFLICT (id) DO UPDATE` rather than `DO NOTHING`: the archive contains
 * these rows as of backup time, so most ids ALREADY EXIST in the promoted
 * database with stale contents. `DO NOTHING` would silently keep the stale copy
 * — including a `restore_status` from an older restore — and the carry-over
 * would appear to work while changing nothing.
 */
const CARRY_RUN_SQL = `
INSERT INTO database_backup_runs (
  id, status, trigger, started_at, finished_at, last_heartbeat_at,
  bytes_written, size_bytes, storage_provider, storage_key, bucket, format,
  checksum_sha256, db_version, app_version, migration_name, verified_at, last_error,
  created_by_id, restore_status, restore_error, restored_at, restored_by_id,
  restore_scratch_db, restore_old_db, swapped_at, created_at, updated_at
) VALUES (
  $1::uuid, $2::"DatabaseBackupStatus", $3::"DatabaseBackupTrigger",
  $4::timestamptz, $5::timestamptz, $6::timestamptz,
  $7::bigint, $8::bigint, $9, $10, $11, $12,
  $13, $14, $15, $16, $17::timestamptz, $18,
  (SELECT id FROM users WHERE id = $19::uuid),
  $20, $21, $22::timestamptz,
  (SELECT id FROM users WHERE id = $23::uuid),
  $24, $25, $26::timestamptz, $27::timestamptz, $28::timestamptz
)
ON CONFLICT (id) DO UPDATE SET
  status = EXCLUDED.status,
  trigger = EXCLUDED.trigger,
  started_at = EXCLUDED.started_at,
  finished_at = EXCLUDED.finished_at,
  last_heartbeat_at = EXCLUDED.last_heartbeat_at,
  bytes_written = EXCLUDED.bytes_written,
  size_bytes = EXCLUDED.size_bytes,
  storage_provider = EXCLUDED.storage_provider,
  storage_key = EXCLUDED.storage_key,
  bucket = EXCLUDED.bucket,
  format = EXCLUDED.format,
  checksum_sha256 = EXCLUDED.checksum_sha256,
  db_version = EXCLUDED.db_version,
  app_version = EXCLUDED.app_version,
  migration_name = EXCLUDED.migration_name,
  verified_at = EXCLUDED.verified_at,
  last_error = EXCLUDED.last_error,
  created_by_id = EXCLUDED.created_by_id,
  restore_status = EXCLUDED.restore_status,
  restore_error = EXCLUDED.restore_error,
  restored_at = EXCLUDED.restored_at,
  restored_by_id = EXCLUDED.restored_by_id,
  restore_scratch_db = EXCLUDED.restore_scratch_db,
  restore_old_db = EXCLUDED.restore_old_db,
  swapped_at = EXCLUDED.swapped_at,
  created_at = EXCLUDED.created_at,
  updated_at = EXCLUDED.updated_at
`.trim();

/**
 * Pass two: the self-FK, and it MUST be a second pass.
 *
 * `pre_restore_backup_id` points at another row in this same table — the safety
 * dump taken minutes before the swap. Set during pass one it would reference a
 * row that may not have been inserted yet (the export is ordered by creation
 * time, but nothing forces the referent to sort first, and a future ordering
 * change must not be able to break the carry-over silently). Applied afterwards,
 * every referent is already present.
 *
 * The subselect is here for the same reason it is in pass one: a referent that
 * genuinely is not present yields NULL rather than aborting the pass.
 */
const CARRY_SELF_LINK_SQL = `
UPDATE database_backup_runs
SET pre_restore_backup_id = (SELECT id FROM database_backup_runs WHERE id = $2::uuid)
WHERE id = $1::uuid
`.trim();

/**
 * The completion audit row, written into the promoted database.
 *
 * ⚠ `id` IS SUPPLIED, exactly as {@link CARRY_RUN_SQL} supplies it — see
 * {@link CarriedAudit} for where the value comes from and why it is a new one.
 * Omitting it relied on a server-side default that
 * `20260831014110_drop_stale_uuid_defaults` removed, which made this INSERT
 * fail on every real restore; {@link DatabaseRestoreService.reinsertCatalog}
 * never throws, so the only trace was a `CRITICAL` log line and the record of
 * the restore was missing from the one database anybody would look in (#337).
 *
 * The actor goes through the same subselect as {@link CARRY_RUN_SQL}'s two user
 * FKs, and for the same reason: the promoted database's `users` is the
 * ARCHIVE's, so an administrator created after the backup was taken is not in
 * it, and a plain value would raise a foreign-key violation.
 */
const CARRY_AUDIT_SQL = `
INSERT INTO audit_events (id, actor_user_id, action, target_type, target_id, meta)
VALUES ($1::uuid, (SELECT id FROM users WHERE id = $2::uuid), $3, $4, $5, $6::jsonb)
`.trim();

/** Tables in a non-system schema — the "did anything actually arrive" check. */
const COUNT_USER_TABLES_SQL = `
SELECT count(*)::text AS count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%'
`.trim();

/** Rows in the migration ledger. `to_regclass` is NULL when the table is absent. */
const COUNT_MIGRATIONS_SQL = `
SELECT CASE WHEN to_regclass('_prisma_migrations') IS NULL THEN NULL
            ELSE (SELECT count(*)::text FROM _prisma_migrations) END AS count
`.trim();

/**
 * The settled form of the restore's own job row, ready for {@link CARRY_JOB_SQL}.
 *
 * A pure function of the row and the swap instant, so the whole terminal write
 * is decided BEFORE the renames begin and {@link DatabaseRestoreService
 * .reinsertCatalog} only binds what it was given — the same rule every other
 * member of {@link CarriedCatalog} follows.
 *
 * `payload` is re-serialised to a string because `pg` binds `jsonb` from text;
 * a `null` payload stays `null` rather than becoming the JSON literal `"null"`.
 */
function carryJob(job: Job | null, finishedAt: Date): CarriedJob | null {
  if (job === null) return null;

  return {
    id: job.id,
    type: job.type,
    subjectType: job.subjectType,
    subjectId: job.subjectId,
    dedupKey: job.dedupKey,
    reason: job.reason,
    priority: job.priority,
    payload: job.payload == null ? null : JSON.stringify(job.payload),
    attempts: job.attempts,
    // PRESERVED, not cleared: on a job that logged something on the way past,
    // that message is the only surviving explanation of it. Same reasoning
    // `JobTerminalService.completeSucceeded` gives for leaving it alone.
    lastError: job.lastError,
    createdAt: job.createdAt.toISOString(),
    startedAt: iso(job.startedAt),
    finishedAt: finishedAt.toISOString(),
    executor: job.executor,
  };
}

/** Anything thrown, as an `Error`. JavaScript lets you throw a string. */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** A `Date | null` as an ISO string, which is what the raw inserts bind. */
function iso(value: Date | null | undefined): string | null {
  return value == null ? null : value.toISOString();
}

/** A `count`-shaped result row, as a number. `null`/unparseable becomes `-1`. */
function readCount(rows: Array<Record<string, unknown>>): number {
  const value = rows[0]?.count;
  if (typeof value !== 'string') return -1;

  const parsed = Number.parseInt(value, 10);

  return Number.isFinite(parsed) ? parsed : -1;
}

@Injectable()
export class DatabaseRestoreService {
  private readonly logger = new Logger(DatabaseRestoreService.name);

  private readonly seam: DatabaseRestoreSeam;

  /**
   * The restore this process is executing, or `null`.
   *
   * PROCESS-LOCAL AND HONESTLY SO — see {@link StartRestoreResult}'s
   * `already_running` variant. There is no database constraint that could
   * express "one restore at a time", because a restore's state lives on the row
   * of the BACKUP it replays and two restores are two different rows. The real
   * exclusion is the single-replica prerequisite; this is the guard for the case
   * that prerequisite is met and an operator double-clicks.
   */
  private activeRestoreRunId: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SystemSettingsService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    // The pre-flight is a REQUIRED collaborator, not a courtesy. See
    // `startRestore`: a restore that could be started without the gates having
    // run is a restore whose gates are a UI decoration.
    private readonly preflight: DatabaseRestorePreflightService,
    // The one writer of `database_backup_runs`' active slot. The `pre_restore`
    // safety dump goes through it rather than through a second claim path, or
    // the single-active-run index stops being a guarantee.
    private readonly runner: DatabaseBackupRunnerService,
    private readonly maintenance: MaintenanceModeService,
    // #288 (epic #254). REQUIRED, and the one collaborator here whose absence
    // would be silent: `db_backup.restore_completed` is a `mandatory` event, so
    // an instance constructed without a notifier would replace the live
    // database and tell nobody.
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
    // #353 (epic #345). A restore is queued, not detached: `startRestore`
    // writes a `db.restore.run` row and returns, and
    // `handlers/db-restore-run.handler.ts` executes it on a worker slot.
    private readonly jobs: JobsService,
    @Optional() @Inject(DATABASE_RESTORE_SEAM) seam?: DatabaseRestoreSeam
  ) {
    this.seam = seam ?? defaultDatabaseRestoreSeam;
  }

  // =========================================================================
  // Starting a restore
  // =========================================================================

  /**
   * Runs the pre-flight and, if it comes back `ok`, starts the restore in the
   * background.
   *
   * ⚠ THE PRE-FLIGHT RUNS HERE, not only in #286's endpoint, and the duplication
   * is deliberate. The gates are the difference between "a restore that fails"
   * and "a restore that destroys a database", and a service that trusted its
   * caller to have run them would be one refactor — or one new caller, such as
   * this file's own rollback path — away from a restore with no gates at all.
   * The cost is a handful of catalog reads.
   *
   * @param run the archive to replay. Looked up, permission-checked and
   * `completed`-filtered by #286, exactly as pre-flight's own contract says.
   */
  async startRestore(
    run: DatabaseBackupRun,
    options: StartRestoreOptions = {}
  ): Promise<StartRestoreResult> {
    if (this.activeRestoreRunId !== null) {
      return { outcome: 'already_running', runId: this.activeRestoreRunId };
    }

    // ⚠ TWO GUARDS, AND THE DEDUP KEY REPLACES NEITHER OF THEM (#353).
    //
    // The natural reading of "the restore is a job now" is that the active-dedup
    // unique index supersedes the process-local flag above. IT DOES NOT, and the
    // difference matters: a `db.restore.run` job's dedup key folds in its
    // SUBJECT, so the index guarantees at most one active restore OF ONE BACKUP
    // RUN. Two restores of two DIFFERENT archives have two different keys and
    // the index permits both — which is precisely the concurrent-restore
    // catastrophe this service must not have.
    //
    // So the three guards divide the work, and each closes something the others
    // cannot:
    //
    //   1. `activeRestoreRunId` (above) — closes the DOUBLE-CLICK race inside
    //      one process. It is set before the pre-flight's several round trips
    //      and read synchronously, so two overlapping requests cannot both reach
    //      the enqueue. Nothing else in this list can do that: every other guard
    //      is a read followed by a write.
    //   2. THE QUERY BELOW — closes the case the flag structurally cannot: a
    //      restore queued by a PREVIOUS PROCESS (this one restarted, or a second
    //      replica queued it), which the flag knows nothing about. It is
    //      type-wide, not subject-wide, so it is the only guard that refuses a
    //      second restore of a DIFFERENT archive.
    //   3. THE ACTIVE-DEDUP INDEX — closes the same-archive race between two
    //      replicas, atomically, which neither of the above can.
    //
    // The single-replica prerequisite still stands and is still what the runbook
    // requires; these three narrow the window inside it rather than replacing
    // it.
    const queued = await this.prisma.job.findFirst({
      where: { type: DB_RESTORE_RUN_TYPE, status: { in: ['pending', 'running'] } },
      select: { id: true, subjectId: true },
    });

    if (queued) {
      return { outcome: 'already_running', runId: queued.subjectId ?? queued.id };
    }

    const now = options.now ?? this.seam.now();
    const actorUserId = options.actorUserId ?? null;

    // ⚠ CLAIMED BEFORE THE PRE-FLIGHT, NOT AFTER IT. The pre-flight is several
    // network round trips, and claiming afterwards would leave a window in which
    // two clicks both pass the gates and both start a restore. Released in the
    // `finally` on every path that does NOT hand the slot to the detached body.
    this.activeRestoreRunId = run.id;
    let claimHandedOver = false;

    try {
      const preflight = await this.preflight.check(run, {
        overrideSchemaMismatch: options.overrideSchemaMismatch,
        now,
      });

      if (preflight.outcome !== 'ok') {
        // NOTHING HAS BEEN CREATED AND NOTHING HAS BEEN WRITTEN, including on
        // the run's row. A refused restore is not an attempted restore, and
        // recording one would put a `failed` restore on a backup nobody touched.
        return { outcome: 'refused', preflight };
      }

      const connection = this.seam.resolveConnection();

      // THE PRE-FLIGHT'S NAMES, not freshly derived ones. Both are built from
      // the same builders and the same `now`, so they would agree today — and
      // would stop agreeing the first time a caller passed a different clock, at
      // which point the row, the API response and the DDL would name three
      // databases.
      const { scratchDatabase, oldDatabase } = preflight;

      // ⚠ QUEUED, NOT DETACHED (#353, epic #345). This used to be
      // `void this.executeRestore(...)` with a terminal `.catch()` — the work is
      // hours long and every proxy between a browser and this process has a
      // response timeout measured in seconds, so it could not be awaited. A
      // queue job answers the same problem and answers three more with it: the
      // restore now has a row in `GET /api/admin/jobs` with a duration and a
      // `lastError`, it holds a worker slot with a ceiling
      // (`RESTORE_JOB_MAX_RUNTIME_MS`) rather than an unbounded promise nothing
      // owns, and its `maxAttempts: 1` makes "never automatically retried" a
      // property the queue ENFORCES rather than a property of not being in the
      // queue.
      //
      // THE PAYLOAD CARRIES THE PRE-FLIGHT'S DECISIONS, not seeds for
      // recomputing them — see `RestoreJobPayload` for why deriving the names
      // again from a later clock would make the row, the API response and the
      // DDL name three databases.
      const job = await this.jobs.enqueue({
        type: DB_RESTORE_RUN_TYPE,
        // `rerun` is the closest of the three reasons: a human asked for this
        // archive to be replayed. It is not a response to an upload and it is
        // not scheduled maintenance.
        reason: 'rerun',
        // The SUBJECT is the backup being replayed, which is what makes the
        // dedup key refuse a second restore of the same archive. See the
        // three-guard note above for what it deliberately does NOT refuse.
        subjectType: RESTORE_AUDIT_TARGET_TYPE,
        subjectId: run.id,
        // INLINE WITH `satisfies` rather than a typed local, the same shape
        // `queueBackup` uses: `EnqueueJobInput.payload` is
        // `Prisma.InputJsonValue`, which an object LITERAL satisfies and a
        // named interface does not (it has no index signature). The `satisfies`
        // is what keeps this checked against `RestoreJobPayload` anyway, which
        // matters because `parseRestoreJobPayload` is the only other place the
        // shape is stated.
        payload: {
          runId: run.id,
          actorUserId,
          scratchDatabase,
          oldDatabase,
          rollbackMode: preflight.rollback.effective,
          startedAt: now.toISOString(),
        } satisfies RestoreJobPayload,
      });

      this.logger.warn(
        `Queued a database restore of backup run ${run.id} as job ${job.id}. The live ` +
          `database will be replaced by "${scratchDatabase}" and the current one parked ` +
          `as "${oldDatabase}".`
      );

      return { outcome: 'started', runId: run.id, scratchDatabase, oldDatabase, preflight };
    } finally {
      // ⚠ ALWAYS RELEASED NOW, ON EVERY PATH, INCLUDING THE ACCEPTED ONE.
      //
      // Before #353 the flag was handed to the detached body and released in its
      // `.finally()`, because the body WAS the restore. It no longer is: this
      // method's work ends at the enqueue, and the executor is a worker that may
      // not even be in this process. Holding the flag past the enqueue would
      // mean a restore whose job failed at 3am left this replica refusing every
      // later restore until somebody restarted it — a process-local flag
      // becoming a durable outage. The durable exclusion is the queue query and
      // the dedup index above; this flag's job is only the double-click window
      // around the pre-flight, and that window closes here.
      this.activeRestoreRunId = null;
    }
  }

  /**
   * Runs a queued restore. THE HANDLER'S ONLY ENTRY POINT (#353, epic #345).
   *
   * ⚠ IT DOES NOT RE-RUN THE PRE-FLIGHT, and that is deliberate. The gates ran
   * in `startRestore`, seconds ago, and their VERDICT — including the two
   * database names and the effective rollback mode — is what the payload
   * carries; re-running them here would derive different names from a different
   * clock and quietly disagree with the answer the operator was already given.
   * What this method does re-read is the RUN ROW, by id, because the payload
   * carries identifiers rather than copies (`EnqueueJobInput.payload`) and the
   * row's storage key and checksum must be the current ones.
   *
   * THROWS TO FAIL, like every handler. `executeRestore` records the failure on
   * the run's restore columns first — that is still its contract, and it is
   * still the only account an operator has — and then rethrows so the queue can
   * write `lastError` and mark the row `failed`. Before #353 it swallowed,
   * because there was no caller left to tell; now there is one.
   */
  async executeRestoreJob(job: Job): Promise<void> {
    const payload = parseRestoreJobPayload(job.payload);

    const run = await this.prisma.databaseBackupRun.findUnique({
      where: { id: payload.runId },
    });

    if (run === null) {
      throw new Error(
        `The backup run ${payload.runId} this restore job replays no longer exists; ` +
          'nothing has been created and nothing has been touched.'
      );
    }

    await this.executeRestore({
      run,
      connection: this.seam.resolveConnection(),
      scratchDatabase: payload.scratchDatabase,
      oldDatabase: payload.oldDatabase,
      actorUserId: payload.actorUserId,
      rollbackMode: payload.rollbackMode,
      startedAt: new Date(payload.startedAt),
      job,
    });
  }

  // =========================================================================
  // The restore itself
  // =========================================================================

  /**
   * The six phases.
   *
   * ⚠ IT RECORDS THE FAILURE AND THEN RETHROWS (#353, epic #345). Until the
   * restore became a queue job this method NEVER REJECTED: it wrote the failure
   * onto the run's restore columns and returned, because it was launched
   * detached and there was no caller left to tell. There is one now — the
   * worker running `db.restore.run` — and a handler that returned normally after
   * a failed restore would be settled `succeeded`, which is exactly the "job row
   * that lies" this conversion exists to avoid. The row-first ordering is
   * unchanged and still matters: the run's `restore_status` and `restore_error`
   * are the operator's account of what happened, and they are written before
   * anything is rethrown, so they survive whatever the queue then decides.
   */
  private async executeRestore(context: RestoreContext): Promise<void> {
    const { run, connection, scratchDatabase, oldDatabase, actorUserId, startedAt } = context;

    /** Set as soon as the path is chosen, cleared once the file is gone. */
    let tempPath: string | null = null;
    /** Only `true` once `CREATE DATABASE` has actually returned. */
    let scratchCreated = false;

    try {
      await this.writeRestoreState(run.id, {
        restoreStatus: 'restoring' satisfies RestoreStatus,
        restoreError: null,
        // The instant this restore BEGAN, not the instant it finished:
        // `swappedAt` is the destructive moment and is written separately, and
        // an operator reading a stuck row needs to know how long it has been
        // stuck.
        restoredAt: startedAt,
        restoredById: actorUserId,
        // Written before either database exists, so a restore that dies without
        // reaching its `catch` still says which names it was going to use.
        restoreScratchDb: scratchDatabase,
        restoreOldDb: oldDatabase,
      });

      await this.writeAudit(RESTORE_AUDIT_START, actorUserId, run.id, {
        storageKey: run.storageKey,
        archiveMigration: run.migrationName,
        scratchDatabase,
        oldDatabase,
        rollbackMode: context.rollbackMode,
      });

      // --- 1. The archive, re-verified against the bytes as they are now -----
      tempPath = this.seam.tempFilePath();
      await this.downloadAndVerifyArchive(run, tempPath);

      // --- 2. The safety backup, when the effective mode calls for one -------
      const preRestoreRunId = await this.takePreRestoreBackupIfNeeded(context, actorUserId);

      if (preRestoreRunId !== null) {
        await this.writeRestoreState(run.id, { preRestoreBackupId: preRestoreRunId });
      }

      // --- 3. The scratch database ------------------------------------------
      await this.createScratchDatabase(connection, scratchDatabase);
      scratchCreated = true;

      // --- 4. The replay. Hours, and the application is fully up for all of it.
      await this.seam.runPgRestore({
        connection: { ...connection, database: scratchDatabase },
        file: tempPath,
        jobs: RESTORE_JOBS,
      });

      // --- 5. Verification --------------------------------------------------
      await this.writeRestoreState(run.id, { restoreStatus: 'verifying' satisfies RestoreStatus });
      await this.verifyRestoredDatabase(connection, scratchDatabase);

      // ⚠ THE TEMP FILE GOES BEFORE THE SWAP, NOT AFTER IT. The process does not
      // come back from the swap, so a `finally` that ran after it would never
      // run at all and every successful restore would leave a database-sized
      // file behind — swept eventually by the janitor, but only eventually, and
      // only because of the prefix. Deleting it here means the success path
      // cleans up after itself and the janitor stays a safety net.
      await this.seam.removeFile(tempPath);
      tempPath = null;

      // --- 6. The swap. Seconds. --------------------------------------------
      await this.swap(context, preRestoreRunId);

      // Unreachable in production: `swap` ends in `process.exit(0)`.
    } catch (error) {
      const failure = toError(error);

      // ORDER: give the scratch database back first, then record the failure.
      // A `failed` row whose scratch database is still on disk is a full copy of
      // the database nothing will ever look for again — the same argument the
      // backup engine's "delete the object, then mark the row" ordering makes.
      //
      // ⚠ EXCEPT WHEN THE SWAP ITSELF FAILED, WHERE IT IS KEPT. By that point
      // the scratch database is a COMPLETE, VERIFIED restore that cost hours to
      // build, and the failure was a rename — something an operator can retry by
      // hand in seconds (runbook §5.2). Dropping it here would turn a recoverable
      // five-second problem into another multi-hour replay, and would do it
      // unattended. Every failure BEFORE the rename is the opposite case: the
      // scratch database is a half-built artefact nobody will ever want.
      if (scratchCreated && !(failure instanceof DatabaseRestoreSwapError)) {
        await this.dropScratchDatabase(connection, scratchDatabase);
      }

      await this.recordFailure(run.id, actorUserId, failure);

      // ⚠ RETHROWN, AFTER THE ROW HAS BEEN WRITTEN AND THE SCRATCH DATABASE
      // GIVEN BACK. Both of those are this method's contract and neither may be
      // skipped by a throw travelling earlier: the queue's `lastError` is a
      // summary, the run row is the account. Note that the temp-file cleanup in
      // the `finally` below still runs — a rethrow does not skip it.
      throw failure;
    } finally {
      // The safety net for every failure path. A no-op on success, where the
      // file was already removed and `tempPath` nulled.
      if (tempPath !== null) await this.seam.removeFile(tempPath);
    }
  }

  /**
   * Phase 1: pull the object to a seekable file and prove it is still the
   * archive it was.
   *
   * Two checks, and they catch different things:
   *
   *   - THE CHECKSUM proves the bytes are unchanged since the dump was hashed
   *     on its way into storage. It cannot tell you they are a valid archive —
   *     a correctly-checksummed zero-byte object is still zero bytes.
   *   - THE TABLE OF CONTENTS proves `pg_restore` can read them and that there
   *     is something in there to restore. It cannot tell you they are the RIGHT
   *     bytes.
   *
   * @throws {DatabaseRestoreArchiveError} before anything has been created.
   */
  private async downloadAndVerifyArchive(run: DatabaseBackupRun, path: string): Promise<void> {
    const source = await this.storage.download(run.storageKey);
    const { bytes, sha256 } = await this.seam.writeArchiveToFile(source, path);

    if (run.checksumSha256 !== null && run.checksumSha256 !== sha256) {
      throw new DatabaseRestoreArchiveError(
        run.storageKey,
        `the sha256 of the ${bytes} bytes downloaded is ${sha256}, but the backup recorded ` +
          `${run.checksumSha256}. The object in storage is not the archive that was written.`
      );
    }

    if (run.checksumSha256 === null) {
      // A completed run always records one, so this is a row that predates the
      // column or was written by hand. WARN AND PROCEED: the table-of-contents
      // check below still runs, and refusing to restore because a provenance
      // field is missing would make a best-effort value load-bearing after the
      // fact — the same call the schema gate makes for a missing migration.
      this.logger.warn(
        `Backup run ${run.id} has no recorded checksum, so the downloaded archive could ` +
          'only be checked for readability, not for identity.'
      );
    }

    const entries = await this.seam.readTocEntryCount(path);

    if (entries <= 0) {
      throw new DatabaseRestoreArchiveError(
        run.storageKey,
        `pg_restore --list found ${entries} table-of-contents entries in the downloaded ` +
          'file, so replaying it would produce an empty database.'
      );
    }

    this.logger.log(
      `Verified the archive for backup run ${run.id}: ${bytes} bytes, ${entries} archive ` +
        `entries, ${run.checksumSha256 === null ? 'no checksum to compare' : 'checksum matches'}.`
    );
  }

  /**
   * Phase 2: the `pre_restore` safety dump — the way back when the displaced
   * database will not be kept.
   *
   * ⚠ ONLY IN `pre_restore_dump` MODE. Under `retain_database` the way back is
   * the displaced database itself, and taking a full dump as well would add
   * hours to a restore to duplicate a guarantee it already has.
   *
   * ⚠ IT IS AWAITED TO COMPLETION, and that is why this method exists at all.
   * `startBackup` is detached by contract: it returns the moment the row is
   * claimed, with `pg_dump` still streaming. Swapping while that dump was in
   * flight would rename the database out from under it and leave a truncated
   * "safety" archive — a way back that does not work, discovered at the only
   * moment it is ever used.
   */
  private async takePreRestoreBackupIfNeeded(
    context: RestoreContext,
    actorUserId: string | null
  ): Promise<string | null> {
    if (context.rollbackMode !== 'pre_restore_dump') return null;

    const policy = await this.settings.getDatabaseBackupPolicy();
    const started = await this.runner.startBackup({
      trigger: 'pre_restore',
      createdById: actorUserId,
    });

    this.logger.log(
      `Taking a pre-restore safety backup (run ${started.id}) before replacing ` +
        `"${context.connection.liveDatabase}"; the displaced database will not be kept.`
    );

    const settled = await this.awaitBackupSettled(started.id, policy);

    if (settled !== 'completed') {
      throw new Error(
        `The pre-restore safety backup (run ${started.id}) ended as "${settled}" instead of ` +
          'completing. The restore was abandoned before anything was created: with no way ' +
          'back and no database being retained, swapping would have been irreversible.'
      );
    }

    return started.id;
  }

  /**
   * Watches a backup's row until it leaves `pending`/`running`.
   *
   * Bounded by the dump's own budget — `runStaleMinutes`, which is what the
   * runner passes as the child's timeout — plus a grace margin, after which the
   * stale sweep is about to settle the row anyway and waiting longer would mean
   * a restore that hangs forever because a container vanished.
   */
  private async awaitBackupSettled(
    runId: string,
    policy: SystemDatabaseBackupValue
  ): Promise<string> {
    const deadline =
      this.seam.now().getTime() + policy.runStaleMinutes * 60_000 + PRE_RESTORE_SETTLE_GRACE_MS;

    for (;;) {
      const row = await this.prisma.databaseBackupRun.findUnique({
        where: { id: runId },
        select: { status: true },
      });

      if (row === null) return 'missing';
      if (row.status !== 'pending' && row.status !== 'running') return row.status;

      if (this.seam.now().getTime() >= deadline) return 'timed_out';

      await this.seam.sleep(PRE_RESTORE_POLL_INTERVAL_MS);
    }
  }

  /**
   * Phase 3: `CREATE DATABASE <live>_restore_<ts>`.
   *
   * ⚠ THE EXISTENCE CHECK IS HERE AND NOT IN PRE-FLIGHT, deliberately: the
   * timestamp in the name is generated when the name is built, so a pre-flight
   * check would have proved something about a different name. `databaseExists`
   * is exported precisely for this call site.
   *
   * A collision is refused rather than reused. A scratch database that already
   * exists holds another restore's half-replayed contents, and `pg_restore`
   * would happily add to them.
   */
  private async createScratchDatabase(
    connection: AdminConnection,
    scratchDatabase: string
  ): Promise<void> {
    await this.seam.withAdminConnection(connection, async (client) => {
      if (await databaseExists(client, scratchDatabase)) {
        throw new Error(
          `The scratch database "${scratchDatabase}" already exists. It is left alone: it ` +
            'holds another restore\'s contents, and replaying an archive into it would mix ' +
            'two databases together. Drop it by hand once you know what it is.'
        );
      }

      await createDatabase(client, scratchDatabase);
    });

    this.logger.log(`Created the scratch database "${scratchDatabase}".`);
  }

  /**
   * Phase 5: is what came out of the archive a database this application could
   * run on?
   *
   * `--exit-on-error` already proved that no statement failed. It cannot prove
   * the archive contained statements worth running, which is the same gap
   * `DatabaseBackupVerificationError` closes on the other side of the round
   * trip. Two checks, deliberately cheap, deliberately not clever:
   *
   *   - AT LEAST ONE ORDINARY TABLE outside the system schemas. Zero means the
   *     replay produced an empty database.
   *   - A NON-EMPTY `_prisma_migrations`. A database with tables but no
   *     migration ledger is not one this application can boot against, and it
   *     is what a restore of somebody else's archive looks like.
   *
   * ⚠ IT DELIBERATELY DOES NOT RE-READ "the newest applied migration".
   * `migration-state.util.ts` is emphatic that exactly one query answers that
   * question, because the pre-flight's schema gate compares its two callers'
   * answers; a third reader here would be a third chance for the rule to drift.
   * The archive's migration is already on the run row and was already gated.
   */
  private async verifyRestoredDatabase(
    connection: AdminConnection,
    scratchDatabase: string
  ): Promise<void> {
    await this.seam.withAdminConnection(
      // Attached to the SCRATCH database — the only place in this file that
      // connects to something other than the maintenance database, and safe
      // because nothing renames the scratch database while this session is open.
      { ...connection, database: scratchDatabase },
      async (client) => {
        const tables = readCount((await client.query(COUNT_USER_TABLES_SQL)).rows);

        if (tables <= 0) {
          throw new DatabaseRestoreVerificationError(
            scratchDatabase,
            `it holds ${tables < 0 ? 'an unreadable number of' : 'no'} tables outside the ` +
              'system schemas, so the archive restored nothing.'
          );
        }

        const migrations = readCount((await client.query(COUNT_MIGRATIONS_SQL)).rows);

        if (migrations <= 0) {
          throw new DatabaseRestoreVerificationError(
            scratchDatabase,
            'its _prisma_migrations table is missing or empty, so this application could ' +
              'not boot against it even though the archive replayed cleanly.'
          );
        }

        this.logger.log(
          `Verified the restored database "${scratchDatabase}": ${tables} tables, ` +
            `${migrations} migration ledger row(s).`
        );
      }
    );
  }

  // =========================================================================
  // The swap
  // =========================================================================

  /**
   * Phase 6. Seconds, and the only destructive window in the whole design.
   *
   * Read this together with the file header. The ordering below is not
   * incidental — every line before the first rename is there so that the two
   * renames have nothing left to fail on:
   *
   *   1. `swapping` on the row, so a poll sees the window open.
   *   2. The swap audit row, written into the database that is ABOUT TO BE
   *      DISPLACED — it survives in `<live>_old_<ts>`, and the completion row
   *      written after the renames is the one that lands in the promoted
   *      database with the whole timeline in its `meta`.
   *   3. The catalog export, WITH THE POST-SWAP AUDIT VALUES ALREADY APPLIED.
   *   4. The maintenance window, in memory, `allowAdmins: false`.
   */
  private async swap(context: RestoreContext, preRestoreRunId: string | null): Promise<void> {
    const { run, connection, scratchDatabase, oldDatabase, actorUserId } = context;
    const swappedAt = this.seam.now();

    await this.writeRestoreState(run.id, { restoreStatus: 'swapping' satisfies RestoreStatus });

    await this.writeAudit(RESTORE_AUDIT_SWAP, actorUserId, run.id, {
      scratchDatabase,
      oldDatabase,
      preRestoreBackupId: preRestoreRunId,
      note:
        'This row is in the database being displaced. The matching completion row is ' +
        'written into the promoted database after the renames.',
    });

    const catalog = await this.exportCatalog(run.id, {
      // ⚠ THE JOB'S TERMINAL WRITE RIDES WITH THE CATALOG (#353). See
      // `CarriedJob`'s header: `process()` never returns on this path, so the
      // worker's own settle never runs, and the only correct place for the
      // terminal write is the set of rows that lands IF AND ONLY IF both
      // renames succeed. `swappedAt` is its `finished_at` — the same instant
      // the run row records — so the two agree about when the restore was over.
      job: context.job ?? null,
      finishedAt: swappedAt,
      restoreStatus: 'completed',
      restoreError: null,
      restoredAt: iso(context.startedAt),
      restoredById: actorUserId,
      restoreScratchDb: scratchDatabase,
      restoreOldDb: oldDatabase,
      swappedAt: iso(swappedAt),
      preRestoreBackupId: preRestoreRunId,
      audit: {
        actorUserId,
        action: RESTORE_AUDIT_COMPLETE,
        targetType: RESTORE_AUDIT_TARGET_TYPE,
        targetId: run.id,
        meta: {
          storageKey: run.storageKey,
          archiveMigration: run.migrationName,
          scratchDatabase,
          oldDatabase,
          oldDatabaseRetained: context.rollbackMode === 'retain_database',
          preRestoreBackupId: preRestoreRunId,
          startedAt: iso(context.startedAt),
          swappedAt: iso(swappedAt),
        },
      },
    });

    await this.renameSwap(context, {
      parkAs: oldDatabase,
      promote: scratchDatabase,
      catalog,
      // Under `pre_restore_dump` the displaced database is not the way back —
      // the safety archive is — so it is dropped immediately rather than left
      // to the retention sweep. Under `retain_database` it is the entire point.
      dropParked: context.rollbackMode !== 'retain_database',
    });

    this.logger.warn(
      `Database restore of backup run ${run.id} swapped "${scratchDatabase}" into ` +
        `"${connection.liveDatabase}". Exiting so a supervisor can start a process with a ` +
        'connection pool built against the restored database. If this process does not come ' +
        'back, this deployment has no restart policy — see docs/runbooks/database-restore.md.'
    );

    // =========================================================================
    // ⚠ AWAITED, AND IT MUST STAY BETWEEN THE RENAME AND THE EXIT (#288, #254)
    // =========================================================================
    //
    // THE ORDERING BELOW IS THE WHOLE POINT, AND IT IS WHAT A LATER REFACTOR
    // WILL SILENTLY BREAK. Three constraints pin this one line to this one
    // place, and losing any of them produces a `mandatory` event that appears
    // wired, passes every registry and template test, and delivers nothing in
    // production on the only path that matters.
    //
    //   1. AFTER `renameSwap`, BECAUSE OF WHERE THE ROWS LAND. Prisma is
    //      pointed at `connection.liveDatabase` BY NAME, and after the renames
    //      that name resolves to the PROMOTED database. So the
    //      `notification_deliveries` and `notifications` rows this writes go
    //      into the database the operator will actually be looking at, and the
    //      recipients are resolved from the restored `users`/`user_roles` — the
    //      post-restore answer to "who can act on this?", which is the correct
    //      one. Raising it before the swap would write the record of the
    //      restore into the database the restore is about to rename away.
    //
    //   2. BEFORE `exitProcess`, OBVIOUSLY — and that is exactly why it is
    //      AWAITED. The detached `notifyPermissionHolders` would schedule the
    //      work on a microtask and return; `exitProcess` would then tear the
    //      process down before any of it ran, and `onModuleDestroy`'s shutdown
    //      drain never runs here because nothing is shutting Nest down. The
    //      awaited sibling is the only shape that survives this seam.
    //
    //   3. `notifyPermissionHoldersNow` NEVER REJECTS — same containment as
    //      every other entry point, via `runContained` — so awaiting it cannot
    //      turn a completed restore into a failure. It cannot hang the exit
    //      either: the seam's `exitProcess` is the next statement whatever the
    //      transports did.
    //
    // The audience is `db_backup:read` (the string `db-backup.controller.ts`
    // enforces) PLUS the actor, de-duplicated by user id inside the dispatcher —
    // an operator who triggered the restore through `db_backup:restore` need not
    // also hold `db_backup:read` to hear that their own restore finished.
    await this.announceRestoreCompleted(context, swappedAt, preRestoreRunId);

    this.seam.exitProcess(0);
  }

  /**
   * Raise `db_backup.restore_completed`, AWAITED, from inside the promoted
   * database (#288, epic #254).
   *
   * See the block comment at the call site for why this sits exactly where it
   * does. What is worth saying HERE is the two things this method does that
   * the other three operational notifiers do not:
   *
   * 1. IT RESOLVES THE ACTOR'S ADDRESS FROM THE RESTORED DATABASE, AND MAY
   *    LEGITIMATELY FIND NOTHING. The account that triggered the restore is
   *    looked up AFTER the swap, so it is looked up in the archive's copy of
   *    `users` — and an operator whose account was created after the backup was
   *    taken genuinely does not exist there. That is not an error to log
   *    loudly; it is a true and rather important fact about the state the
   *    deployment is now in, and it renders as "Not recorded" rather than as a
   *    failure.
   *
   * 2. IT ADDS THE ACTOR TO THE AUDIENCE RATHER THAN SENDING THEM A SECOND
   *    MESSAGE. `alsoNotifyUserIds` is unioned with the permission holders and
   *    de-duplicated by user id inside the dispatcher, so an actor who also
   *    holds `db_backup:read` gets exactly one email and one bell row. See
   *    `NotifyPermissionHoldersOptions`.
   *
   * NEVER THROWS. `notifyPermissionHoldersNow` cannot reject by construction,
   * and the try/catch covers the address lookup and the payload build — because
   * a throw here would land in `executeRestore`'s `catch`, which would then
   * record a COMPLETED restore as a failure and, worse, try to drop a scratch
   * database that has already been promoted to live.
   */
  private async announceRestoreCompleted(
    context: RestoreContext,
    swappedAt: Date,
    preRestoreRunId: string | null
  ): Promise<void> {
    const { run, actorUserId } = context;

    try {
      const payload: RestoreCompletedEmailData = {
        runId: run.id,
        // `startedAt`, NOT `finishedAt`: `pg_dump` takes its snapshot when it
        // starts, so the state this database now holds is the state at the
        // START of that run. `finishedAt` would overstate it by however long
        // the dump took, which on a large database is the difference between
        // "we lost ten minutes" and "we lost two hours".
        backupTakenAt: run.startedAt ?? run.finishedAt,
        completedAt: swappedAt,
        triggeredBy: await this.resolveActorEmail(actorUserId),
        preRestoreBackupId: preRestoreRunId,
        appUrl: this.appUrl(),
      };

      await this.notifications.notifyPermissionHoldersNow(
        'db_backup.restore_completed',
        PERMISSIONS.DB_BACKUP_READ,
        payload,
        {
          // The actor, when there is one. Unioned and de-duplicated by the
          // dispatcher — see the header.
          alsoNotifyUserIds: actorUserId === null ? [] : [actorUserId],
        }
      );
    } catch (error) {
      this.logger.error(
        `The restore of backup run ${run.id} completed, but ` +
          `'db_backup.restore_completed' could not be raised: ` +
          `${toError(error).message}`
      );
    }
  }

  /**
   * The actor's email address as recorded IN THE RESTORED DATABASE, or `null`.
   *
   * `null` for three different and equally ordinary reasons: there was no actor
   * (a restore triggered without one), the actor's account does not exist in
   * the archive, or the read failed. None of them justifies holding up an exit
   * or failing a completed restore, so all three collapse to `null` and the
   * template gives it words.
   */
  private async resolveActorEmail(actorUserId: string | null): Promise<string | null> {
    if (actorUserId === null) return null;

    try {
      const actor = await this.prisma.user.findUnique({
        where: { id: actorUserId },
        select: { email: true },
      });

      return actor?.email ?? null;
    } catch (error) {
      this.logger.warn(
        `Could not read the restore actor's address from the restored database: ` +
          `${toError(error).message}`
      );

      return null;
    }
  }

  /**
   * The application root, trailing slashes trimmed, or `undefined`.
   *
   * Same shape as `UsersService.appUrl()`; `undefined` makes the template omit
   * its CTA rather than render a button that goes nowhere.
   */
  private appUrl(): string | undefined {
    const appUrl = this.config.get<string>('appUrl');
    return appUrl ? appUrl.replace(/\/+$/, '') : undefined;
  }

  /**
   * THE TWO RENAMES, and the inner recovery between them.
   *
   * ⚠ ONE IMPLEMENTATION, USED BY BOTH DIRECTIONS. The restore parks the live
   * database as `<live>_old_<ts>` and promotes the scratch database; the
   * rollback parks the bad restore as a fresh `<live>_restore_<ts>` and promotes
   * the retained original. They are the same three statements with the names
   * exchanged, and writing them twice would mean the recovery `catch` — the one
   * genuinely dangerous moment in this design — existed in two places, one of
   * which would eventually be wrong.
   *
   * ⚠ THE MAINTENANCE WINDOW IS OPENED WITH `allowAdmins: false`, IN MEMORY.
   * See the file header: the persisted flag lives inside the database being
   * renamed, and an admin request during the window would reach a database that
   * momentarily does not exist.
   *
   * ⚠ THE WINDOW IS NOT CLOSED ON THE SUCCESS PATH. `process.exit(0)` is the
   * release: closing it here would open a gap in which this process served
   * requests through a connection pool it is about to tear down. It IS closed
   * when the swap failed and the original was renamed back, because then there
   * is a working database to serve from and the deployment must not be left in
   * a window nothing will ever close. It is deliberately LEFT OPEN when the
   * recovery also failed — an orderly 503 beats five hundred stack traces
   * against a database that is not there.
   */
  private async renameSwap(
    context: RestoreContext,
    options: { parkAs: string; promote: string; catalog: CarriedCatalog; dropParked: boolean }
  ): Promise<void> {
    const { connection } = context;
    const { parkAs, promote, catalog, dropParked } = options;
    const live = connection.liveDatabase;

    this.maintenance.setInMemoryOverride({
      enabled: true,
      message: RESTORE_MAINTENANCE_MESSAGE,
      allowAdmins: false,
    });

    try {
      await this.seam.withAdminConnection(connection, async (client) => {
        // The application's own pool is the largest set of sessions holding the
        // rename off. Disconnecting first is a courtesy that makes the
        // termination below smaller and quieter; `.catch()` because a pool that
        // is already broken must not stop the swap.
        await this.prisma.$disconnect().catch(() => undefined);

        // AND THEN EVERYTHING ELSE. A rename fails while ANY session is
        // attached — a pooler, a metrics exporter, an open psql window, a
        // replica that should not be running.
        const terminated = await terminateConnections(client, live);

        if (terminated > 0) {
          this.logger.warn(`Terminated ${terminated} session(s) on "${live}" for the swap.`);
        }

        // ⚠ FROM HERE UNTIL THE NEXT STATEMENT SUCCEEDS THERE IS NO DATABASE
        // NAMED `live`.
        await renameDatabase(client, live, parkAs);

        try {
          await renameDatabase(client, promote, live);
        } catch (error) {
          const cause = toError(error);
          let originalRestored = true;

          // THE ONE GENUINELY DANGEROUS MOMENT. Put the original back, whatever
          // it costs, and never let a failure here hide the failure that caused
          // it.
          await renameDatabase(client, parkAs, live).catch((recoveryError: unknown) => {
            originalRestored = false;

            this.logger.error(
              `CRITICAL: "${live}" could not be renamed from "${promote}" ` +
                `(${cause.message}) AND "${parkAs}" could not be renamed back ` +
                `(${toError(recoveryError).message}). THERE IS NOW NO DATABASE NAMED ` +
                `"${live}". Nothing has been deleted - both databases still exist under ` +
                `their other names ("${parkAs}" is the original. "${promote}" is the ` +
                'replacement). Finish or undo the swap by hand: see section 5.2 of ' +
                'docs/runbooks/database-restore.md.'
            );
          });

          throw new DatabaseRestoreSwapError(live, originalRestored, cause);
        }

        // The renames are done and the promoted database is live. Everything
        // below is repair of what the rename cost, and NONE of it may undo the
        // swap — see `reinsertCatalog`.
        await this.reinsertCatalog(connection, catalog);

        if (dropParked) {
          // Best-effort: the swap has already succeeded, and a database left on
          // disk is a storage cost the retention sweep will collect later.
          try {
            await dropDatabase(client, parkAs);
            this.logger.log(`Dropped the displaced database "${parkAs}".`);
          } catch (error) {
            this.logger.warn(
              `The displaced database "${parkAs}" could not be dropped ` +
                `(${toError(error).message}); the retained-database sweep will retry it.`
            );
          }
        }
      });
    } catch (error) {
      if (error instanceof DatabaseRestoreSwapError && !error.originalRestored) {
        // No database under the live name. Leave the window OPEN so callers get
        // a 503 rather than a connection error, and leave the process running so
        // its logs — which contain the only account of what happened — survive.
        throw error;
      }

      this.maintenance.setInMemoryOverride(null);

      throw error;
    }
  }

  // =========================================================================
  // Catalog carry-over
  // =========================================================================

  /**
   * Reads `database_backup_runs` out of the database that is about to be
   * displaced, applying this restore's POST-SWAP audit values on the way past.
   *
   * ⚠ THE AUDIT VALUES ARE APPLIED HERE, NOT WRITTEN TO THE LIVE ROW. Writing
   * "restore completed" to the database this restore is about to rename away
   * would put the record of the operation in the one database nobody will ever
   * open again. The row the operator eventually reads is the one this function
   * builds.
   *
   * ⚠ THE SELF-FK IS STRIPPED INTO {@link CarriedCatalog.selfLinks} and applied
   * in a second pass. See {@link CARRY_SELF_LINK_SQL}.
   */
  private async exportCatalog(
    runId: string,
    postSwap: {
      /** The restore's job row, or `null` for a caller that is not the queue. */
      job: Job | null;
      /** The instant the swap happened — the job's `finished_at`. */
      finishedAt: Date;
      restoreStatus: RestoreStatus;
      restoreError: string | null;
      restoredAt: string | null;
      restoredById: string | null;
      restoreScratchDb: string | null;
      restoreOldDb: string | null;
      swappedAt: string | null;
      preRestoreBackupId: string | null;
      /** Without its `id`: this function mints it. See {@link CarriedAudit}. */
      audit: Omit<CarriedAudit, 'id'>;
    }
  ): Promise<CarriedCatalog> {
    const rows = await this.prisma.databaseBackupRun.findMany({
      // Oldest first: the order rows are re-inserted in. It does not matter for
      // correctness — pass two exists precisely so no ordering is load-bearing —
      // but a table whose ids come back in creation order is easier to read.
      orderBy: { createdAt: 'asc' },
    });

    const runs: CarriedRun[] = [];
    const selfLinks: CarriedSelfLink[] = [];

    for (const row of rows) {
      const isThisRestore = row.id === runId;

      runs.push({
        id: row.id,
        status: row.status,
        trigger: row.trigger,
        startedAt: iso(row.startedAt),
        finishedAt: iso(row.finishedAt),
        lastHeartbeatAt: iso(row.lastHeartbeatAt),
        bytesWritten: row.bytesWritten.toString(),
        sizeBytes: row.sizeBytes.toString(),
        storageProvider: row.storageProvider,
        storageKey: row.storageKey,
        bucket: row.bucket,
        format: row.format,
        checksumSha256: row.checksumSha256,
        dbVersion: row.dbVersion,
        appVersion: row.appVersion,
        migrationName: row.migrationName,
        verifiedAt: iso(row.verifiedAt),
        lastError: row.lastError,
        createdById: row.createdById,
        restoreStatus: isThisRestore ? postSwap.restoreStatus : row.restoreStatus,
        restoreError: isThisRestore ? postSwap.restoreError : row.restoreError,
        restoredAt: isThisRestore ? postSwap.restoredAt : iso(row.restoredAt),
        restoredById: isThisRestore ? postSwap.restoredById : row.restoredById,
        restoreScratchDb: isThisRestore ? postSwap.restoreScratchDb : row.restoreScratchDb,
        restoreOldDb: isThisRestore ? postSwap.restoreOldDb : row.restoreOldDb,
        swappedAt: isThisRestore ? postSwap.swappedAt : iso(row.swappedAt),
        createdAt: row.createdAt.toISOString(),
        // Bumped for the row this restore changed, so the promoted database's
        // `updated_at` is not older than the change it describes.
        updatedAt: (isThisRestore ? this.seam.now() : row.updatedAt).toISOString(),
      });

      const link = isThisRestore ? postSwap.preRestoreBackupId : row.preRestoreBackupId;

      if (link !== null) selfLinks.push({ id: row.id, preRestoreBackupId: link });
    }

    return {
      runs,
      selfLinks,
      audit: { id: randomUUID(), ...postSwap.audit },
      job: carryJob(postSwap.job, postSwap.finishedAt),
    };
  }

  /**
   * Writes the carried catalog into the database that has just been promoted.
   *
   * ⚠ IT NEVER THROWS, AND THAT IS A SAFETY PROPERTY RATHER THAN LAZINESS. By
   * the time this runs, both renames have succeeded: the restored database IS
   * the live one and the swap is irreversible. A throw here would travel to
   * `executeRestore`'s `catch`, which would try to drop a scratch database that
   * no longer exists under that name and then write a `failed` restore status
   * into a database that no longer holds that row — and it would tempt a future
   * change to "roll the swap back", which at this point would mean discarding a
   * database the deployment is already serving from. Losing the backup catalog
   * is bad. Undoing a successful restore to avoid losing it would be worse.
   *
   * A separate session on the LIVE name, not the maintenance one: the rows go
   * into the promoted database, and the outer session is attached elsewhere
   * precisely so it could do the renaming.
   */
  private async reinsertCatalog(
    connection: AdminConnection,
    catalog: CarriedCatalog
  ): Promise<void> {
    try {
      await this.seam.withAdminConnection(
        { ...connection, database: connection.liveDatabase },
        async (client) => {
          // ⚠ THE JOB ROW GOES FIRST, AND THE ORDER IS NOT COSMETIC. Everything
          // else in this carry is READ by a human later; this row is ACTED ON by
          // a machine — the lease reaper, on the very next process start. If the
          // session dies part way through this loop, the value most worth having
          // landed is the one that stops a successful restore being marked
          // `failed`. `reinsertCatalog` never throws, so a failure here still
          // leaves the backup catalog to be attempted.
          if (catalog.job !== null) {
            await client.query(CARRY_JOB_SQL, [
              catalog.job.id,
              catalog.job.type,
              catalog.job.subjectType,
              catalog.job.subjectId,
              catalog.job.dedupKey,
              catalog.job.reason,
              catalog.job.priority,
              catalog.job.payload,
              catalog.job.attempts,
              catalog.job.lastError,
              catalog.job.createdAt,
              catalog.job.startedAt,
              catalog.job.finishedAt,
              catalog.job.executor,
            ]);
          }

          for (const row of catalog.runs) {
            await client.query(CARRY_RUN_SQL, [
              row.id,
              row.status,
              row.trigger,
              row.startedAt,
              row.finishedAt,
              row.lastHeartbeatAt,
              row.bytesWritten,
              row.sizeBytes,
              row.storageProvider,
              row.storageKey,
              row.bucket,
              row.format,
              row.checksumSha256,
              row.dbVersion,
              row.appVersion,
              row.migrationName,
              row.verifiedAt,
              row.lastError,
              row.createdById,
              row.restoreStatus,
              row.restoreError,
              row.restoredAt,
              row.restoredById,
              row.restoreScratchDb,
              row.restoreOldDb,
              row.swappedAt,
              row.createdAt,
              row.updatedAt,
            ]);
          }

          // PASS TWO. Every referent is now present.
          for (const link of catalog.selfLinks) {
            await client.query(CARRY_SELF_LINK_SQL, [link.id, link.preRestoreBackupId]);
          }

          await client.query(CARRY_AUDIT_SQL, [
            catalog.audit.id,
            catalog.audit.actorUserId,
            catalog.audit.action,
            catalog.audit.targetType,
            catalog.audit.targetId,
            JSON.stringify(catalog.audit.meta),
          ]);
        }
      );

      this.logger.log(
        `Carried ${catalog.runs.length} backup record(s), ${catalog.selfLinks.length} ` +
          `pre-restore link(s) and ${catalog.job === null ? 'no' : 'the settled'} restore ` +
          `job row into "${connection.liveDatabase}".`
      );
    } catch (error) {
      this.logger.error(
        `CRITICAL: the restore succeeded but its backup catalog could not be carried into ` +
          `"${connection.liveDatabase}" (${toError(error).message}). The database now shows ` +
          'backups as of the archive\'s own age: any backup taken after that archive, and ' +
          'the record of this restore itself, are missing from database_backup_runs, and ' +
          'the restore\'s own job row was not settled (the lease reaper will mark it ' +
          'failed after the restart even though the restore succeeded). The ' +
          'ARCHIVES are untouched in object storage, and any displaced database has to be ' +
          'dropped by hand because nothing now records its name. See section 5 of ' +
          'docs/runbooks/database-restore.md.'
      );
    }
  }

  // =========================================================================
  // Rollback
  // =========================================================================

  /**
   * Undoes a restore, by whichever of the two routes this deployment still has.
   *
   * The two costs are not comparable, and reporting which one happened is the
   * whole reason this returns a discriminated result rather than a boolean:
   *
   *   - `retain_database` → ONE RENAME. Seconds. This is the entire
   *     justification for paying roughly double the PostgreSQL volume for
   *     `oldDatabaseRetentionHours`.
   *   - `pre_restore_dump` → a full restore of the safety archive. HOURS,
   *     and it goes back through `startRestore`, gates and all.
   *   - Neither → `unavailable`, honestly. Nothing failed; the window closed.
   *
   * ⚠ THE DELEGATED RESTORE OVERRIDES THE SCHEMA GATE. The `pre_restore` dump
   * was taken from the schema this code was running moments before the restore,
   * so the live migration it would be compared against is the ARCHIVE's — the
   * gate would block on a mismatch that exists only because the thing being
   * undone happened. That block would be spurious, and it would fire at the
   * exact moment an operator needs the way back.
   */
  async rollback(run: DatabaseBackupRun, actorUserId: string | null): Promise<RestoreRollbackResult> {
    const connection = this.seam.resolveConnection();
    const oldDatabase = run.restoreOldDb;

    if (oldDatabase !== null && oldDatabase !== '') {
      const exists = await this.seam.withAdminConnection(connection, (client) =>
        databaseExists(client, oldDatabase)
      );

      if (exists) return this.rollbackByRename(run, connection, oldDatabase, actorUserId);

      this.logger.warn(
        `The database displaced by the restore of backup run ${run.id} ("${oldDatabase}") no ` +
          'longer exists; falling back to the pre-restore archive.'
      );
    }

    if (run.preRestoreBackupId !== null) {
      const preRestore = await this.prisma.databaseBackupRun.findUnique({
        where: { id: run.preRestoreBackupId },
      });

      if (preRestore !== null && preRestore.status === 'completed') {
        const started = await this.startRestore(preRestore, {
          actorUserId,
          // See the method comment. It unblocks that gate and nothing else.
          overrideSchemaMismatch: true,
        });

        if (started.outcome === 'started') {
          return { outcome: 'restore_started', runId: run.id, preRestoreRunId: preRestore.id };
        }

        return {
          outcome: 'unavailable',
          runId: run.id,
          reason:
            `The pre-restore safety backup (run ${preRestore.id}) exists, but a restore of ` +
            `it could not be started (${started.outcome}). Run the pre-flight against that ` +
            'backup to see what is in the way.',
        };
      }
    }

    return {
      outcome: 'unavailable',
      runId: run.id,
      reason:
        oldDatabase === null || oldDatabase === ''
          ? 'This backup has no recorded restore to roll back.'
          : `The displaced database "${oldDatabase}" has been dropped (past ` +
            'databaseBackup.oldDatabaseRetentionHours) and there is no completed pre-restore ' +
            'backup to fall back on. There is nothing left to roll back to; restoring any ' +
            'other archive is a new restore, not a rollback.',
    };
  }

  /**
   * The fast rollback: park the current live database, promote the retained one.
   *
   * ⚠ THE CATALOG IS CARRIED OVER HERE TOO, and it matters more than it looks.
   * The retained database's `database_backup_runs` is as of the moment BEFORE
   * the restore — so without a carry-over the rollback would delete every
   * backup record created since, INCLUDING the `pre_restore` dump's, which under
   * some configurations is the only remaining way back from the thing being
   * undone. Reusing {@link exportCatalog} rather than writing a second, smaller
   * version is the point: one carry-over, one set of FK rules.
   */
  private async rollbackByRename(
    run: DatabaseBackupRun,
    connection: AdminConnection,
    oldDatabase: string,
    actorUserId: string | null
  ): Promise<RestoreRollbackResult> {
    const now = this.seam.now();
    // Where the database being undone goes. A fresh scratch name rather than
    // reusing the recorded one: that name belonged to a database that no longer
    // exists under it, and a collision here would fail the first rename.
    const parkAs = buildScratchDatabaseName(connection.liveDatabase, now);

    const catalog = await this.exportCatalog(run.id, {
      // NO JOB ROW ON THIS PATH. A rollback-by-rename is not a queue job — it
      // is a synchronous admin request that renames two databases and exits —
      // so there is nothing to settle. `finishedAt` is still supplied because
      // the parameter is not optional; it is unused when `job` is `null`.
      job: null,
      finishedAt: now,
      restoreStatus: 'rolled_back',
      restoreError: null,
      restoredAt: iso(run.restoredAt),
      restoredById: run.restoredById,
      // The names AFTER the rollback: the parked database is the one this
      // restore produced, and the database that was displaced is now live.
      restoreScratchDb: parkAs,
      restoreOldDb: null,
      swappedAt: iso(run.swappedAt),
      preRestoreBackupId: run.preRestoreBackupId,
      audit: {
        actorUserId,
        action: RESTORE_AUDIT_ROLLBACK,
        targetType: RESTORE_AUDIT_TARGET_TYPE,
        targetId: run.id,
        meta: {
          promoted: oldDatabase,
          parked: parkAs,
          swappedAt: iso(run.swappedAt),
          rolledBackAt: iso(now),
        },
      },
    });

    await this.renameSwap(
      {
        run,
        connection,
        scratchDatabase: parkAs,
        oldDatabase,
        actorUserId,
        rollbackMode: 'retain_database',
        startedAt: now,
      },
      {
        parkAs,
        promote: oldDatabase,
        catalog,
        // NEVER. The database being parked is the restore that is being undone,
        // and an operator who rolled back at 3am may still want to look at it.
        // The retained-database sweep does not know about it either, which is
        // correct: it is the operator's to drop.
        dropParked: false,
      }
    );

    this.logger.warn(
      `Rolled the restore of backup run ${run.id} back: "${oldDatabase}" is live again and ` +
        `the restored database is parked as "${parkAs}". Exiting so a supervisor can start ` +
        'a process with a connection pool built against it.'
    );

    // DELAYED, unlike the restore's: a rollback is fast enough that its HTTP
    // caller is still holding the connection, and exiting mid-response would
    // show an operator a network error for an operation that succeeded.
    this.seam.exitProcess(0, ROLLBACK_EXIT_DELAY_MS);

    return { outcome: 'renamed', runId: run.id, promoted: oldDatabase, parked: parkAs };
  }

  // =========================================================================
  // Retained-database cleanup
  // =========================================================================

  /**
   * Drops `<live>_old_<ts>` databases whose `oldDatabaseRetentionHours` window
   * has passed.
   *
   * ⚠ ROW-DRIVEN, NOT NAME-DRIVEN, and that is a deliberate refusal. Sweeping
   * `pg_database` for anything matching the `<live>_old_` prefix would be
   * self-healing and would also DROP DATABASES THIS APPLICATION NEVER CREATED —
   * specifically the one an operator makes by hand when they follow #284's
   * guided command block, which uses exactly that name and which the runbook
   * tells them to keep until they have verified the restore. An unattended cron
   * that deletes a full copy of a production database nobody in this system
   * recorded creating is not a trade worth making for tidiness.
   *
   * The cost is honest: if the catalog carry-over failed, the row naming the
   * displaced database is gone and nothing here will ever drop it. That case
   * logs CRITICAL at the time and is in the runbook.
   *
   * Called from `DatabaseBackupScheduleTask`'s ten-minute tick rather than from
   * a `@Cron` of its own, for the reason `DbBackupModule` already gives about
   * retention: a second timer is a second unsynchronised thing acting on the
   * same subsystem, and a window measured in hours does not need a schedule
   * finer than the one that already exists.
   *
   * @returns how many databases were actually dropped.
   */
  async dropExpiredOldDatabases(policy: SystemDatabaseBackupValue, now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - policy.oldDatabaseRetentionHours * 3_600_000);

    const candidates = await this.prisma.databaseBackupRun.findMany({
      where: {
        restoreOldDb: { not: null },
        // `swappedAt` and not `restoredAt`: the retention clock starts when the
        // database was actually displaced. A restore still in flight has a
        // `restoreOldDb` and a NULL `swappedAt`, and `NULL < cutoff` is never
        // true — so an in-flight restore's name can never be swept.
        swappedAt: { lt: cutoff },
      },
      select: { id: true, restoreOldDb: true, swappedAt: true },
    });

    if (candidates.length === 0) return 0;

    const connection = this.seam.resolveConnection();
    let dropped = 0;

    await this.seam.withAdminConnection(connection, async (client) => {
      for (const candidate of candidates) {
        const name = candidate.restoreOldDb;

        if (name === null) continue;

        // ⚠ A SEMANTIC GUARD, NOT A SYNTACTIC ONE. `quoteIdentifier` already
        // makes the statement safe to send; this makes it safe to MEAN. A row
        // whose `restore_old_db` somehow names the live database (a hand-edited
        // row, a restored settings blob, a bug) would otherwise have this cron
        // drop the database the application is serving from.
        if (name === connection.liveDatabase || name === connection.database) {
          this.logger.error(
            `Refusing to drop "${name}" for backup run ${candidate.id}: it is this ` +
              'deployment\'s live or maintenance database, not a displaced one.'
          );

          continue;
        }

        try {
          if (!(await databaseExists(client, name))) continue;

          await dropDatabase(client, name);
          dropped += 1;

          this.logger.warn(
            `Dropped the retained database "${name}" from the restore of backup run ` +
              `${candidate.id} (displaced ${iso(candidate.swappedAt)}, past ` +
              `${policy.oldDatabaseRetentionHours}h). Rolling that restore back now means ` +
              'restoring an archive, not renaming a database.'
          );
        } catch (error) {
          // Per row, so one database that still has a session attached does not
          // stop the rest. The next tick retries it.
          this.logger.warn(
            `Could not drop the retained database "${name}" for backup run ` +
              `${candidate.id}; the next sweep retries it: ${toError(error).message}`
          );
        }
      }
    });

    return dropped;
  }

  // =========================================================================
  // Row and audit writes
  // =========================================================================

  /**
   * One progress write. SWALLOWS ITS OWN FAILURES.
   *
   * The same call the backup heartbeat makes, for the same reason: a transient
   * write failure — a recycled connection, a brief failover, a lock wait — is
   * not evidence that a restore which is otherwise going perfectly should be
   * abandoned. Abandoning a two-hour replay because one status UPDATE failed
   * would be a self-inflicted outage, and the phase this is reporting on is the
   * one where nothing has been touched yet anyway.
   */
  private async writeRestoreState(
    runId: string,
    data: Prisma.DatabaseBackupRunUncheckedUpdateInput
  ): Promise<void> {
    try {
      await this.prisma.databaseBackupRun.update({ where: { id: runId }, data });
    } catch (error) {
      this.logger.warn(
        `Could not write restore progress for backup run ${runId} (the restore ` +
          `continues): ${toError(error).message}`
      );
    }
  }

  /** The terminal `failed` write, plus the audit row an operator greps for. */
  private async recordFailure(
    runId: string,
    actorUserId: string | null,
    error: Error
  ): Promise<void> {
    this.logger.error(`Database restore of backup run ${runId} failed: ${error.message}`);

    await this.writeRestoreState(runId, {
      restoreStatus: 'failed' satisfies RestoreStatus,
      restoreError: error.message,
    });

    await this.writeAudit(RESTORE_AUDIT_FAILED, actorUserId, runId, {
      error: error.message,
      errorName: error.name,
    });
  }

  /**
   * One `audit_events` row, in the repository's existing shape
   * (`UsersService.createAuditEvent`, `MaintenanceModeService.writeAuditEvent`).
   *
   * BEST-EFFORT. An audit write that threw inside `executeRestore`'s `try` would
   * be a logging failure that failed a restore, and inside its `catch` it would
   * be a logging failure that replaced the real diagnosis.
   *
   * ⚠ ROWS WRITTEN BEFORE THE SWAP LAND IN THE DATABASE THAT IS ABOUT TO BE
   * DISPLACED. That is unavoidable — they are written while it is still the live
   * database — and it is why the completion row is written afterwards, into the
   * promoted database, carrying the whole timeline in its `meta`.
   */
  private async writeAudit(
    action: string,
    actorUserId: string | null,
    runId: string,
    meta: Record<string, unknown>
  ): Promise<void> {
    try {
      await this.prisma.auditEvent.create({
        data: {
          actorUserId,
          action,
          targetType: RESTORE_AUDIT_TARGET_TYPE,
          targetId: runId,
          meta: meta as never,
        },
      });
    } catch (error) {
      this.logger.warn(
        `Could not write the "${action}" audit row for backup run ${runId}: ` +
          `${toError(error).message}`
      );
    }
  }

  /**
   * Gives the scratch database back after a failure before the swap.
   *
   * BEST-EFFORT AND IT NEVER MASKS THE ORIGINAL ERROR — the same contract the
   * backup engine's partial-object delete has. Whatever broke the restore is
   * what belongs on the row; "and the cleanup also failed" is a log line.
   */
  private async dropScratchDatabase(
    connection: AdminConnection,
    scratchDatabase: string
  ): Promise<void> {
    try {
      await this.seam.withAdminConnection(connection, async (client) => {
        await dropDatabase(client, scratchDatabase);
      });

      this.logger.log(
        `Dropped the scratch database "${scratchDatabase}" after a failed restore. The live ` +
          'database was never touched.'
      );
    } catch (error) {
      this.logger.warn(
        `Could not drop the scratch database "${scratchDatabase}" after a failed restore; ` +
          `it may need dropping by hand: ${toError(error).message}`
      );
    }
  }
}

/** Everything one restore needs, gathered once so no phase re-derives a name. */
interface RestoreContext {
  run: DatabaseBackupRun;
  connection: AdminConnection;
  scratchDatabase: string;
  oldDatabase: string;
  actorUserId: string | null;
  /** The pre-flight's EFFECTIVE mode, which disk pressure may have downgraded. */
  rollbackMode: 'retain_database' | 'pre_restore_dump';
  startedAt: Date;
  /**
   * The `db.restore.run` row this restore is executing under (#353).
   *
   * OPTIONAL ONLY FOR CALLERS THAT ARE NOT THE QUEUE — of which there are none
   * in the application since #353. It is what {@link CarriedJob} is built from,
   * so a context without one produces a swap that carries no settled job row;
   * see `CarriedJob`'s header for why that would be a job row left `running`
   * with a live lease, and why the queue path must always supply this.
   */
  job?: Job;
}
