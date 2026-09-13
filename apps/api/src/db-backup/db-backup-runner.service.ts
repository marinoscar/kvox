import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DatabaseBackupRun,
  DatabaseBackupTrigger,
  Job,
  Prisma,
} from '@prisma/client';

import type { DbBackupRunResult } from '../jobs/contracts/db-backup-run.contract';
import { enqueueHousekeepingJob } from '../jobs/housekeeping.enqueue';
import { buildDedupKey } from '../jobs/job-keys';
import { DB_BACKUP_SWEEP_TYPE } from './handlers/db-backup-sweep.handler';
import { isActiveDedupConflict, JobsService } from '../jobs/jobs.service';
import { resolveApiVersion } from '../openapi/version';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from '../storage/providers/storage-provider.interface';
import type { SystemDatabaseBackupValue } from '../common/schemas/settings.schema';
import {
  ACTIVE_STORAGE_PROVIDER_ID,
  assertUsableStorageProvider,
  BACKUP_ARCHIVE_FORMAT,
  BACKUP_CONTENT_TYPE,
  buildBackupStorageKey,
} from './db-backup-storage';
import { PERMISSIONS } from '../common/constants/roles.constants';
import type { BackupFailedEmailData } from '../email';
import { NotificationsService } from '../notifications/notifications.service';
import {
  DatabaseBackupAlreadyRunningError,
  DatabaseBackupCancelledError,
  DatabaseBackupClientVersionError,
  DatabaseBackupVerificationError,
} from './db-backup.errors';
import { readLatestAppliedMigration } from './migration-state.util';
import { spawnPgDump, type PgProcess } from './pg-dump.util';
import { readTocEntryCount } from './pg-restore.util';
import {
  checkPgClientVersion,
  readServerVersionNumWithPgClient,
  type PgVersionCheck,
} from './pg-version.util';

// =============================================================================
// The streaming pg_dump engine (issue #281, epic #254)
// =============================================================================
//
// One backup = one `database_backup_runs` row + one `pg_dump` process whose
// stdout goes STRAIGHT INTO OBJECT STORAGE. This file is the only place either
// is created. Everything in it exists to hold five properties, and each of the
// five is a failure this template has to not have.
//
// -----------------------------------------------------------------------------
// 1. THE DUMP IS A QUEUE JOB, AND THE JOB'S LIFETIME IS THE DUMP'S LIFETIME
//    (issue #351, epic #345)
// -----------------------------------------------------------------------------
//
// It did not used to be. Until #351 `startBackup` awaited an INSERT and then
// fired `void this.executeRun(...)`: the dump had no job type, appeared in
// neither `GET /api/admin/jobs` nor insights, occupied no worker slot, and
// could not run anywhere but the API process. `schema.prisma` gave three
// reasons for that, and #346/#347 removed all three:
//
//   1. "The 30-minute reaper would requeue a running dump" → answered by a
//      per-type PROFILE. `db.backup.run` declares `maxRuntimeMs: 6h`, and the
//      lease is DERIVED from it (`resolveJobLeaseMs`), so the reaper's
//      deadline is longer than the ceiling by construction.
//   2. "The in-process worker never renews its lease" → answered by #347.
//      `JobWorker` renews on a ticker for as long as `process()` runs.
//   3. "A retry budget would re-run a failed multi-gigabyte dump" → answered
//      by `maxAttempts: 1` in that same profile. The correct retry for a
//      backup is still the next scheduled one; the difference is that the
//      QUEUE now knows that, and `JobStuckService`'s give-up phase enforces
//      it rather than the absence of a queue enforcing it by accident.
//
// So there are now TWO entry points into this file, and the difference
// between them is exactly which of them owns a `jobs` row:
//
//   `queueBackup`  — the normal path (#283's endpoint, #282's cron). Writes a
//                    `jobs` row and a `pending` run row IN ONE TRANSACTION and
//                    returns; a worker claims the job and calls
//                    `runQueuedBackup`, which is where the dump actually
//                    happens, AWAITED.
//   `startBackup`  — the ONE remaining detached path: the `pre_restore` safety
//                    dump (`DatabaseRestoreService`). It takes a backup while
//                    a restore is mid-flight, so it must not depend on a
//                    worker slot being free, on `JOBS_WORKER_MODE`, or on this
//                    process still polling the queue seconds from now. It
//                    claims `running` directly, with no job.
//
// ⚠ THE DETACHED PROMISE (`startBackup` only) CARRIES A TERMINAL `.catch()`.
// Without one, an EXPECTED failure (the dump exits non-zero; the bucket
// refuses the write) becomes an unhandled promise rejection, and an unhandled
// rejection TERMINATES the Node process by default. A failed backup must not
// be able to take the API down with it. `runQueuedBackup` needs no such guard
// and deliberately has none: it has a caller — the worker — whose entire job
// is to turn a rejection into a settled row.
//
// ⚠ WHY `executeRun` RETURNS AN OUTCOME RATHER THAN THROWING. It records
// every failure it anticipates on the run row and returns; the decision to
// FAIL THE JOB belongs to `runQueuedBackup`, which rethrows the recorded
// error. Had `executeRun` simply kept swallowing, the queued path would
// report `succeeded` for a job whose run row said `failed` — a job row that
// lies, which is worse than no job row at all.
//
// -----------------------------------------------------------------------------
// 2. THE VERSION CHECK RUNS BEFORE A SINGLE BYTE IS DUMPED
// -----------------------------------------------------------------------------
//
// `pg_dump` refuses to dump a server newer than itself. Checked first (see
// `pg-version.util.ts`), that becomes a run whose `lastError` says "rebuild the
// image with postgresql<N>-client"; checked never, it becomes an opaque
// non-zero exit after a partial object has already been written.
//
// It runs INSIDE the detached body rather than before the claim, deliberately:
// the check opens a connection of its own, and a blocked deployment deserves a
// VISIBLE failed run in the admin list every night rather than an exception
// swallowed by a cron with no row to point at.
//
// -----------------------------------------------------------------------------
// 3. THE ARCHIVE IS NEVER MATERIALISED — ONE PASS, ONE COPY, NO HEAP
// -----------------------------------------------------------------------------
//
//     dump.done.catch(err => meter.destroy(err));
//     dump.stdout.pipe(meter);
//     await Promise.all([provider.upload(key, meter, opts), dump.done]);
//
// The metering `Transform` hashes and counts each chunk AS IT PASSES and
// forwards it unchanged. There is no buffer, no temp file, no second read:
// checksum and byte count are produced by the same single pass the upload is
// already making. Buffering "just to hash it first" would put an entire
// production database in this process's heap — the memory profile this whole
// design exists to avoid, and one that fails on the deployment that needs the
// backup most.
//
// ⚠ `Promise.all` ON **BOTH** HALVES IS LOAD-BEARING, NOT BELT-AND-BRACES.
// The two failure modes are genuinely independent and each is invisible to the
// other side:
//
//   - A DUMP THAT DIES MID-STREAM simply ENDS its stdout. The upload sees a
//     clean EOF and reports a perfectly successful upload OF A TRUNCATED
//     ARCHIVE. Only `dump.done`'s exit code distinguishes that from a complete
//     dump — which is why `pg-dump.util.ts` calls it "the authority on
//     success".
//   - A DUMP CAN EXIT NON-ZERO AFTER ITS LAST BYTE LANDED (a failure during
//     cleanup), and an upload can fail after the dump finished cleanly.
//
// So both are awaited, and either one rejecting fails the run. The two
// cross-teardowns beside them close the remaining leaks: a dead dump destroys
// the metering stream (or the upload would hang forever waiting on bytes that
// will never come), and a dead upload SIGKILLs the dump (or `pg_dump` would
// keep reading a database for an archive nobody is storing).
//
// -----------------------------------------------------------------------------
// 4. VERIFICATION READS THE STORED OBJECT BACK, NOT THE STREAM WE SENT
// -----------------------------------------------------------------------------
//
// Before a run is `completed`, the UPLOADED OBJECT is streamed back out of
// storage and through `pg_restore --list`; an empty table of contents fails the
// run. The checksum proves the bytes we SENT are the bytes we hashed. This
// proves the bytes that ARRIVED are a readable archive — which catches a
// truncated upload, a zero-byte object, and a dump that ran against the wrong
// (empty) database, none of which any exit code or byte count can see.
//
// The cost is one extra read of the object. That is the correct price for the
// property that makes the whole feature worth having: a backup marked
// `completed` in this table is a backup that has been proven restorable-shaped
// at least once.
//
// -----------------------------------------------------------------------------
// 5. FAILURE DELETES THE OBJECT FIRST, THEN MARKS THE ROW
// -----------------------------------------------------------------------------
//
// In that order, always. The row is the only index of what exists in the
// bucket: a run marked `failed` while its partial object is still there is an
// orphan nothing will ever look for, billed forever. Deleting first means the
// worst case is the opposite — an object already gone when the row says
// `running`, which #282's stale sweep resolves.
//
// The delete is BEST-EFFORT and never masks the original error. The reason the
// backup failed is what the operator needs; "and also the delete failed" is a
// log line, not a replacement diagnosis.
//
// THERE IS NO AUTOMATIC RETRY. Re-running a failed multi-gigabyte dump burns
// hours of I/O on a database that is probably already unwell; the retry for a
// backup is the next scheduled run. That is now `maxAttempts: 1` on the
// handler's profile rather than the absence of a queue — see
// `handlers/db-backup-run.handler.ts`.
// =============================================================================

/**
 * How often the heartbeat writes `lastHeartbeatAt` and the live
 * `bytesWritten`.
 *
 * ⚠ THIS IS PROGRESS REPORTING, NOT THE LIVENESS SIGNAL — that changed in
 * #351 and the distinction matters when tuning it. While the dump was
 * detached, this beat was the ONLY evidence a run was still alive, and #282's
 * stale sweep was the only thing that could settle an abandoned one. The dump
 * is now a queue job, and #347's LEASE RENEWAL is what says "the executor is
 * still there": the worker renews on a ticker derived from the type's
 * `maxRuntimeMs`, and `JobStuckService` reaps a lease that stops being
 * renewed. What this beat still owns — and nothing else does — is
 * `bytesWritten`, the number the admin UI's progress bar reads.
 *
 * TWENTY SECONDS, and the number is still bounded on both sides by things
 * that already exist. `databaseBackup.runStaleMinutes` starts at 120 and its
 * minimum is 1, so the interval must stay comfortably under a minute: the
 * stale sweep remains the backstop for the `pre_restore` path, which has no
 * job and therefore no lease. At the other end each beat is one indexed
 * UPDATE by primary key, so a tighter interval would be affordable but
 * pointless: the progress bar it feeds is read by a human.
 *
 * A CONSTANT, not an environment variable. Nothing an operator could set here
 * would be a better answer than "well inside the smallest stale window", and a
 * knob whose only wrong settings are silent (too slow → false stale sweeps)
 * is a knob worth not having.
 */
export const BACKUP_HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * How many times the claim will re-attempt its INSERT when the run holding the
 * active slot settles out from under the re-read.
 *
 * BOUNDED, for the reason `ENQUEUE_MAX_ATTEMPTS` is (see `jobs.service.ts`):
 * an unbounded loop is correct in theory and a spin in practice. Three covers
 * the real race — a run finishing inside the few milliseconds between the
 * failed insert and the lookup — and turns a pathological one into an honest
 * "already running" rather than a hang.
 */
const CLAIM_MAX_ATTEMPTS = 3;

/**
 * The name of the partial unique index that enforces one active run.
 *
 * Declared in
 * `prisma/migrations/20260907120000_add_database_backup_runs/migration.sql`;
 * repeated here because a P2002 has to be attributed to *this* constraint and
 * not to some other unique constraint a fork may add to the table.
 */
/**
 * How far a worker node's reported finish time may be from this server's clock
 * before the completing write logs a warning.
 *
 * FIVE MINUTES, and it is a WARNING AND NOTHING ELSE — never a refusal. A
 * skewed clock does not make an archive less valid, and refusing a verified
 * multi-gigabyte backup over NTP would be the wrong trade by a wide margin.
 * The reason it is worth a line in the log at all is that the node's lease
 * renewal (#347) runs on the very same clock, so a node this far out is a node
 * whose next long job may lose its claim for reasons nobody will connect to
 * the time.
 */
export const NODE_CLOCK_SKEW_WARN_MS = 5 * 60 * 1000;

export const ACTIVE_RUN_INDEX_NAME = 'database_backup_runs_active_uniq_idx';

/** The physical column and the Prisma field the index is built over. */
const ACTIVE_RUN_COLUMN_NAME = 'status';

/** The statuses the index's predicate covers — "an active run". */
export const ACTIVE_RUN_STATUSES = ['pending', 'running'] as const;

/**
 * The `Job.type` a queued dump runs under (issue #351, epic #345).
 *
 * DECLARED HERE RATHER THAN IN THE HANDLER, and the direction is the reason:
 * this file ENQUEUES the job and the handler EXECUTES it, so the handler can
 * import the runner but the runner must never import the handler (that would
 * be a cycle, and a module-evaluation-order one at that). The single
 * definition therefore lives on the enqueueing side, and
 * `handlers/db-backup-run.handler.ts` imports it for its `type`.
 *
 * ⚠ PERMANENT once jobs of this type exist, exactly as
 * `JobHandler.type` says: `jobs` rows outlive the handler that produced them,
 * so renaming this string orphans every historical row and every job already
 * queued under the old name.
 */
export const BACKUP_JOB_TYPE = 'db.backup.run';

/**
 * The one dedup key EVERY backup enqueue uses.
 *
 * CONSTANT, and that is the entire single-active-backup guard at the queue
 * layer. A backup has no subject — there is one database and one archive per
 * run — so `buildDedupKey` folds the null subject pair away and every caller
 * lands on the same string. `jobs_active_dedup_uniq_idx` then makes a second
 * enqueue while one is `pending`/`running` a P2002, which is exactly what
 * BOTH callers want: the scheduler stands down, and #283's endpoint reports
 * "already running" with the winner's run id.
 *
 * Derived through `buildDedupKey` rather than written out as a literal,
 * because the index enforces uniqueness over whatever string the enqueue path
 * puts in the column — and a literal here that drifted from the builder would
 * silently stop colliding with the rows it is supposed to collide with.
 */
export const BACKUP_JOB_DEDUP_KEY = buildDedupKey(BACKUP_JOB_TYPE, null, null);

/**
 * What a `db.backup.run` job carries.
 *
 * IDENTIFIERS AND PROVENANCE ONLY, per the queue's payload rule. It exists
 * for ONE narrow case: a handler that finds no run row for its job (see
 * `runQueuedBackup`) has to create one, and `trigger` has no default —
 * a run nobody can attribute is a run nobody can explain. On the ordinary
 * path the run row already exists and this payload is never read, which is
 * why it carries nothing else: everything an operator wants about a backup
 * lives on `database_backup_runs`, not in opaque JSONB.
 */
export interface BackupJobPayload {
  trigger: DatabaseBackupTrigger;
  createdById: string | null;
}

/** What a caller may say about the backup it wants taken. */
export interface StartBackupInput {
  /** Why this run exists. No default: an unattributable run is a run nobody can explain. */
  trigger: DatabaseBackupTrigger;

  /**
   * The administrator who asked, when a person did.
   *
   * `null`/omitted for a `scheduled` run — a timer has no user, and inventing
   * one (the last admin to log in, the seeded admin) would put a name on an
   * action nobody took.
   */
  createdById?: string | null;
}

/** A queued backup: the job that will execute it, and the row it will fill in. */
export interface QueuedBackup {
  /** `pending`, with its server-chosen `storageKey` already set. */
  run: DatabaseBackupRun;
  /** The `db.backup.run` row a worker will claim. */
  job: Job;
}

/**
 * The provenance every terminal write carries — success or failure alike.
 *
 * ONE TYPE BECAUSE THERE ARE NOW TWO EXECUTORS. `executeRun` fills it from
 * this process (the API image's `pg_dump`, this server's Prisma connection);
 * `completeNodeRun` fills it from a worker node's reported result, where the
 * three dump-side facts are things ONLY the node can know. A shared type is
 * what stops the two paths from writing different subsets of the same audit
 * block — see `completeRun`.
 *
 * All four are nullable-by-nature and NONE of them may fail a backup: a run
 * that could not read the server version is still a valid archive. `appVersion`
 * is the one exception in practice — it is this process's own build and is
 * always available — and it is deliberately the API's version on BOTH paths,
 * because it records which application wrote the row, not which binary wrote
 * the file. That is what `pgDumpVersion` is for.
 */
export interface BackupRunAudit {
  dbVersion: string | null;
  appVersion: string;
  migrationName: string | null;
  pgDumpVersion: string | null;
}

/**
 * How a dump ended, as a VALUE rather than as a thrown error.
 *
 * `executeRun` records every failure it anticipates on the run row and then
 * returns one of these, because its two callers need opposite things from the
 * same code: the detached `pre_restore` path must not reject (there is nobody
 * left to tell), and the queued path MUST reject (the worker settles the job
 * from that rejection). Returning the outcome lets each caller decide, rather
 * than having the engine guess which of the two it is serving.
 */
export type BackupRunOutcome =
  | { status: 'completed' }
  | { status: 'failed'; error: Error };

/**
 * What `cancel` actually managed to do.
 *
 * A DISCRIMINATED RESULT RATHER THAN A `boolean` OR A THROW, because the
 * honest answer has three cases and two of them are not errors. Cancellation
 * works through a PROCESS-LOCAL handle — only the process that spawned the
 * child can signal it — so a run started on another replica cannot be
 * cancelled from here, and reporting that as `true` would tell an operator
 * their dump had stopped when it is still streaming.
 */
export type CancelBackupResult =
  /** The child was signalled and the upload torn down; the run will settle as `failed`. */
  | { outcome: 'signalled'; runId: string }
  /**
   * No in-process handle exists. Either the run belongs to another replica, or
   * it already settled. Either way THIS process cannot stop it, and #283 must
   * say so rather than reporting success.
   */
  | { outcome: 'not_running_here'; runId: string };

/**
 * The `pg_*` seam.
 *
 * Every child process this service starts goes through it, so the unit suite
 * can drive a dump that dies mid-stream, an archive with an empty table of
 * contents, and a blocked version pair WITH NO PostgreSQL BINARIES INSTALLED.
 * A suite that needs `pg_dump` on the runner is a suite CI skips, and a skipped
 * test guards nothing — the same argument `PgSpawnFn` makes one layer down.
 */
export interface DatabaseBackupEngine {
  /** Starts `pg_dump -Fc` against this deployment's database. */
  startDump(options: { compressionLevel: number; timeoutMs: number }): PgProcess;

  /** Counts the table-of-contents entries in an archive stream. Zero means "restores nothing". */
  readTocEntryCount(source: Readable): Promise<number>;

  /** Compares the installed client against the server it would have to dump. */
  checkClientVersion(): Promise<PgVersionCheck>;
}

/**
 * DI token for {@link DatabaseBackupEngine}.
 *
 * OPTIONAL, and DELIBERATELY NOT PROVIDED in `DbBackupModule` — exactly like
 * `JOB_CLOCK`. The application always gets {@link systemDatabaseBackupEngine};
 * only a test that constructs this service directly can substitute one, so a
 * fork cannot ship a stubbed dump engine by accident.
 */
export const DB_BACKUP_ENGINE = Symbol('DB_BACKUP_ENGINE');

/** The real engine: real binaries, real database. */
export const systemDatabaseBackupEngine: DatabaseBackupEngine = {
  startDump: ({ compressionLevel, timeoutMs }) =>
    spawnPgDump({ compressionLevel, timeoutMs }),
  readTocEntryCount: (source) => readTocEntryCount({ source }),
  checkClientVersion: () =>
    checkPgClientVersion({
      // The `pg` seam rather than a Prisma query, so the check still answers
      // while the application database is mid-swap during a Phase 7 restore.
      readServerVersionNum: () => readServerVersionNumWithPgClient(),
    }),
};

/** The heartbeat's timer seam. */
export interface BackupTimers {
  setInterval(handler: () => void, ms: number): NodeJS.Timeout;
  clearInterval(handle: NodeJS.Timeout): void;
}

/** DI token for {@link BackupTimers}. Optional and unprovided, as {@link DB_BACKUP_ENGINE} is. */
export const DB_BACKUP_TIMERS = Symbol('DB_BACKUP_TIMERS');

/**
 * The real timers, with the interval UNREF'D.
 *
 * A refed 20-second interval would hold a shutting-down process open, turning
 * a graceful deploy into an orchestrator kill for as long as a dump lasts.
 * Unref'd, the heartbeat stops mattering the moment nothing else is keeping
 * the process alive — which is correct, because at that point there is no dump
 * left to report progress for either. (The `typeof` guard is for fake-timer
 * configurations whose handle is a bare number.)
 */
export const systemBackupTimers: BackupTimers = {
  setInterval: (handler, ms) => {
    const timer = setInterval(handler, ms);

    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }

    return timer;
  },
  clearInterval: (handle) => clearInterval(handle),
};

/**
 * A run this process is actually executing, and the one way to stop it.
 *
 * PROCESS-LOCAL BY CONSTRUCTION. The map holds a live child-process handle and
 * a live stream, neither of which can be serialised, shared or reached from
 * another replica — which is precisely why {@link CancelBackupResult} has a
 * `not_running_here` case instead of pretending otherwise.
 */
interface ActiveRunHandle {
  /** Set by `cancel` before `abort` is called, so a cancel that races the spawn still lands. */
  cancelled: boolean;
  /** Tears the run down. A no-op until the child and the metering stream exist. */
  abort(error: Error): void;
}

/**
 * Whether `error` is a unique-constraint violation on the SINGLE-ACTIVE-RUN
 * index specifically — as opposed to any other P2002 this table (or a fork's
 * additions to it) might raise.
 *
 * THIS DISCRIMINATION IS LOAD-BEARING, for the same reason
 * `isActiveDedupConflict` gives in `jobs.service.ts`: treating every P2002 as
 * "already running" would report a genuine constraint bug as an ordinary busy
 * signal, and that is the exact class of error that must stay loud. Anything
 * this function does not positively recognise propagates untouched.
 *
 * Two metadata shapes are inspected because Prisma reports the violation
 * differently depending on how the client is talking to Postgres — the driver
 * adapter (`@prisma/adapter-pg`, which `PrismaService` uses) puts it under
 * `meta.driverAdapterError.cause`, the classic engine under `meta.target`. Both
 * are checked so that switching adapters degrades to "the P2002 propagates",
 * never to "an unrelated conflict is silently swallowed".
 */
export function isActiveRunConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }

  const names = new Set([ACTIVE_RUN_INDEX_NAME, ACTIVE_RUN_COLUMN_NAME]);
  const meta = (error.meta ?? {}) as Record<string, unknown>;

  // Shape 1: driver adapter.
  const adapterError = meta.driverAdapterError as { cause?: Record<string, unknown> } | undefined;
  const cause = adapterError?.cause;

  if (cause) {
    const constraint = cause.constraint as { fields?: unknown; index?: unknown } | undefined;

    if (
      Array.isArray(constraint?.fields) &&
      constraint.fields.some((field) => names.has(String(field)))
    ) {
      return true;
    }

    if (typeof constraint?.index === 'string' && constraint.index === ACTIVE_RUN_INDEX_NAME) {
      return true;
    }

    if (
      typeof cause.originalMessage === 'string' &&
      cause.originalMessage.includes(ACTIVE_RUN_INDEX_NAME)
    ) {
      return true;
    }
  }

  // Shape 2: classic query engine.
  const target = meta.target;

  if (typeof target === 'string') {
    return names.has(target);
  }

  if (Array.isArray(target)) {
    return target.some((entry) => names.has(String(entry)));
  }

  return false;
}

/** Anything thrown, as an `Error`. JavaScript lets you throw a string. */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * The trigger and actor a `db.backup.run` job carries, DEFENSIVELY.
 *
 * `Job.payload` is opaque JSONB written by an earlier process — possibly an
 * earlier BUILD of this application, possibly by hand — so it is parsed, not
 * cast. The fallback is `manual` with no actor rather than a throw: this is
 * only reached when a job has no run row at all (see `resolveRunForJob`), and
 * refusing to take a backup because its provenance is unreadable would trade
 * a missing audit field for a missing backup.
 */
function readBackupJobPayload(job: Job): StartBackupInput {
  const payload = (job.payload ?? {}) as Partial<BackupJobPayload>;

  const trigger: DatabaseBackupTrigger =
    payload.trigger === 'scheduled' || payload.trigger === 'pre_restore'
      ? payload.trigger
      : 'manual';

  return {
    trigger,
    createdById: typeof payload.createdById === 'string' ? payload.createdById : null,
  };
}

@Injectable()
export class DatabaseBackupRunnerService {
  private readonly logger = new Logger(DatabaseBackupRunnerService.name);

  private readonly engine: DatabaseBackupEngine;
  private readonly timers: BackupTimers;

  /** See {@link ActiveRunHandle}: process-local, never shared, never persisted. */
  private readonly active = new Map<string, ActiveRunHandle>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SystemSettingsService,
    // The ACTIVE provider, injected directly rather than through
    // `ObjectsService`. A backup is not a `storage_objects` row: it has its own
    // table, its own key space and its own lifecycle, and routing it through
    // the interactive object API would give every backup a user-facing object
    // record that an administrator could delete by hand.
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    // Retention is a REQUIRED collaborator, not an optional seam like the two
    // below it. A runner that could be constructed without one is a runner a
    // fork can wire up so that nothing ever deletes an archive — and that
    // failure is invisible until the bucket is full.
    // #288 (epic #254). REQUIRED, not an optional seam: a runner that could be
    // constructed without a notifier is a runner a fork can wire so that a
    // failed backup is silent, which is the failure this event exists for.
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
    // #351 (epic #345). REQUIRED, like the two above it and for the same kind
    // of reason: a runner that could be constructed without the queue is a
    // runner a fork can wire so that `queueBackup` has nothing to enqueue
    // into, and the failure would be "backups silently stop happening" — the
    // one failure mode this subsystem must not have.
    private readonly jobs: JobsService,
    @Optional() @Inject(DB_BACKUP_ENGINE) engine?: DatabaseBackupEngine,
    @Optional() @Inject(DB_BACKUP_TIMERS) timers?: BackupTimers
  ) {
    this.engine = engine ?? systemDatabaseBackupEngine;
    this.timers = timers ?? systemBackupTimers;
  }

  /**
   * Validates a `databaseBackup.storageProvider` value against the provider
   * this deployment actually has.
   *
   * Exposed on the service so #283's `PUT` config handler can call it without
   * importing storage internals, and so there is exactly ONE rule shared by
   * the write path and the run path. The rule itself is pure and lives in
   * `db-backup-storage.ts`.
   *
   * @throws {DatabaseBackupStorageProviderError} → a 400.
   */
  assertStorageProviderUsable(configured: string | null | undefined): void {
    assertUsableStorageProvider(configured, ACTIVE_STORAGE_PROVIDER_ID);
  }

  /**
   * Queues a backup: writes the `jobs` row and its `pending` run row, and
   * returns. A worker claims the job and `runQueuedBackup` takes the dump.
   *
   * THE NORMAL PATH — #283's `POST /api/admin/db-backup/runs` and #282's cron
   * both come through here. Only the `pre_restore` dump still uses
   * {@link startBackup}.
   *
   * ---------------------------------------------------------------------------
   * ⚠ BOTH INSERTS ARE ONE TRANSACTION. THIS IS THE PART TO READ.
   * ---------------------------------------------------------------------------
   *
   * The endpoint must keep answering with a real run id immediately (its 202
   * shape and `GET /runs/{id}` polling are unchanged), so the run row is
   * created at ENQUEUE time as `pending` and the handler flips it to `running`
   * when a worker actually claims it. That is strictly more honest than the
   * old behaviour, which reported `running` before anything ran. It also
   * creates two rows that must agree, and there are exactly three ways for
   * two rows written separately to disagree. All three are made
   * UNREPRESENTABLE by putting both inserts in ONE COMMIT:
   *
   *   1. A CLAIMED JOB WITH NO RUN ROW. A worker can claim within
   *      milliseconds of the enqueue. Insert the job first and there is a real
   *      window in which the handler resolves its run and finds nothing.
   *      Inside one transaction the job row is invisible to every other
   *      session — the claim's `FOR UPDATE SKIP LOCKED` included — until the
   *      same commit that publishes the run row. The window has no duration
   *      because it has no state.
   *   2. AN ORPHAN `pending` RUN ROW. Insert the run row first and a failed
   *      enqueue (or a process death between the two statements) leaves a
   *      `pending` row behind. That is not a cosmetic leak: the TIGHTENED
   *      `database_backup_runs_active_uniq_idx` admits exactly ONE active row
   *      across `pending` and `running` COMBINED, so a leaked row blocks every
   *      future backup — manual and scheduled — until somebody deletes it by
   *      hand. A rolled-back transaction leaves nothing at all.
   *   3. A RUN ROW WHOSE `job_id` WAS FILLED IN AFTERWARDS. Insert-then-UPDATE
   *      reintroduces (1) for the length of the gap. The `jobId` is written
   *      BY THE INSERT, never by a second statement.
   *
   * REJECTED: two statements with compensating deletes ("insert the run,
   * enqueue, delete the run if the enqueue throws"). The compensation is
   * itself a write that can fail, and its failure mode is precisely (2) —
   * the leak that blocks every future backup. A rollback the database
   * performs cannot fail in that way.
   *
   * REJECTED: `JobsService.enqueue` inside the transaction. Its
   * catch-the-P2002-and-re-read loop cannot run there at all — Postgres aborts
   * a transaction at the first failed statement — which is why
   * `enqueueWithin` exists and why the conflict is resolved out here, after
   * the transaction has ended.
   *
   * ⚠ THE ORDER OF THE TWO INSERTS INSIDE THE TRANSACTION IS NOT LOAD-BEARING
   * (that is the point of a transaction), but the job goes first anyway so
   * that its id can be written onto the run row by the insert rather than by
   * an update. See (3).
   *
   * @throws {DatabaseBackupAlreadyRunningError} when either guard refused —
   * the queue's dedup index (a backup job is already in flight) or the run
   * table's single-active index (a `pre_restore` dump, say) — carrying the id
   * of the run that won where one can be identified.
   * @throws {DatabaseBackupStorageProviderError} when the configured provider
   * is not the active one. Raised BEFORE anything is written, so a
   * misconfigured provider is a clean 400 at request time and not a job that
   * fails an hour later.
   */
  async queueBackup(input: StartBackupInput): Promise<QueuedBackup> {
    const policy = await this.settings.getDatabaseBackupPolicy();

    // BEFORE the transaction, exactly as it was before the claim: there is
    // nothing to record about a backup that was never allowed to start, and a
    // `failed` row (or a failed job) per attempt would bury the real history
    // under configuration noise.
    this.assertStorageProviderUsable(policy.storageProvider);

    const bucket = this.storage.getBucket();

    for (let attempt = 1; attempt <= CLAIM_MAX_ATTEMPTS; attempt += 1) {
      // Generated HERE, for the reason `claimRun` gives: the storage key
      // embeds it. The timestamp the key is built from is the ENQUEUE time
      // rather than the start time, which is only a naming detail — the uuid
      // is what makes the key unique, and a key that named a start time would
      // have to be rewritten when the worker claimed it.
      const id = randomUUID();
      const queuedAt = new Date();

      try {
        return await this.prisma.$transaction(async (tx) => {
          const job = await this.jobs.enqueueWithin(tx, {
            type: BACKUP_JOB_TYPE,
            // `backfill`, reused rather than extended — the same choice the
            // broadcast fan-out made. `JobReason` is a Prisma enum, so a
            // `backup` member would be a migration plus web-side churn for a
            // display string, and the thing it would say is already said
            // precisely by `DatabaseBackupRun.trigger`
            // (`manual`/`scheduled`/`pre_restore`).
            reason: 'backfill',
            // No subject, which is what makes the dedup key constant — see
            // BACKUP_JOB_DEDUP_KEY. Dedup is deliberately left ON.
            payload: {
              trigger: input.trigger,
              createdById: input.createdById ?? null,
            } satisfies BackupJobPayload,
          });

          const run = await tx.databaseBackupRun.create({
            data: {
              ...this.buildRunData(input, { id, bucket, at: queuedAt }),
              jobId: job.id,
              // `pending`: nothing has started. `startedAt` and
              // `lastHeartbeatAt` are deliberately left NULL — the sweep in
              // `db-backup-schedule.task.ts` ages a pending row by `createdAt`
              // precisely because a row that never started must not be able to
              // claim it did.
              status: 'pending',
            },
          });

          return { run, job };
        });
      } catch (error) {
        const winner = await this.resolveQueueConflict(error);

        if (winner !== 'retry') throw winner;

        // Whichever guard fired, the row that held the slot SETTLED between
        // the failed insert and the lookup, so nothing is active any more and
        // reporting "already running" would be false. Loop and insert again —
        // with a fresh run id and key, because the old ones were never stored.
        this.logger.debug(
          `The backup slot was released between a conflicting enqueue and the lookup ` +
            `(attempt ${attempt}/${CLAIM_MAX_ATTEMPTS}); retrying.`
        );
      }
    }

    // Every attempt collided and every lookup came back empty: something is
    // churning backups faster than this loop can insert between them. An
    // honest "not now" with no id beats a spin.
    throw new DatabaseBackupAlreadyRunningError(null);
  }

  /**
   * Classifies a failed {@link queueBackup} transaction.
   *
   * Returns the error to throw, or the literal `'retry'` when the conflict
   * has already resolved itself and the caller should insert again.
   *
   * ⚠ IT RUNS AFTER THE TRANSACTION HAS ROLLED BACK, never inside it — see
   * `JobsService.enqueueWithin` for why an aborted transaction can execute no
   * further statement. Both discriminators are the EXISTING exported ones
   * (`isActiveDedupConflict`, `isActiveRunConflict`), so anything neither
   * positively recognises propagates untouched: a genuine constraint bug must
   * stay loud rather than be reported as an ordinary busy signal.
   */
  private async resolveQueueConflict(error: unknown): Promise<Error | 'retry'> {
    if (isActiveDedupConflict(error)) {
      // The queue's guard fired: a `db.backup.run` job is already pending or
      // running. Its run row was written in the SAME commit as the job, so if
      // the job is there the run is there too — which is what lets a 409 carry
      // a real run id rather than a bare "one is already running".
      const active = await this.prisma.job.findFirst({
        where: { dedupKey: BACKUP_JOB_DEDUP_KEY, status: { in: ['pending', 'running'] } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, backupRun: { select: { id: true } } },
      });

      if (active === null) return 'retry';

      // ⚠ `?? null`, NOT a throw. The link can legitimately be absent: an
      // administrator deleting the run row (#283's `DELETE /runs/{id}`) leaves
      // the job, and `job.history.purge` deleting the job sets `job_id` back
      // to NULL on the run. "A backup is already queued, and here is no id"
      // is still a true and useful 409; inventing an error because the audit
      // link is missing would turn a survivable state into a 500.
      return new DatabaseBackupAlreadyRunningError(active.backupRun?.id ?? null);
    }

    if (isActiveRunConflict(error)) {
      // The run table's own guard fired. The commonest cause is the ONE path
      // that still creates a run outside the queue — the `pre_restore` dump —
      // and the next commonest is a `pending` row whose job was deleted from
      // under it. Either way the correct answer is the same 409 the manual
      // path has always given.
      const activeRunId = await this.findActiveRunId();

      return activeRunId === null
        ? 'retry'
        : new DatabaseBackupAlreadyRunningError(activeRunId);
    }

    return toError(error);
  }

  /**
   * Takes a backup WITHOUT a job: claims the single active slot as `running`,
   * then streams the dump into storage in the background.
   *
   * ⚠ ONE CALLER REMAINS, AND IT IS NOT A LEGACY ONE. `DatabaseRestoreService`
   * takes the `pre_restore` safety dump through here, deliberately outside the
   * queue: it runs in the middle of a restore, and making it wait for a worker
   * slot would make the safety net depend on `JOBS_WORKER_MODE`, on the queue
   * being drained, and on this process still polling seconds from now — three
   * things that are least trustworthy at exactly the moment a database is
   * being replaced. Everything else must use {@link queueBackup}.
   *
   * @returns the freshly claimed run, ALREADY `running` and with its
   * server-chosen `storageKey` set. The dump has not finished — see property 1
   * in this file's header for why it must not have.
   *
   * @throws {DatabaseBackupAlreadyRunningError} when the index refused the
   * claim, carrying the id of the run that won.
   * @throws {DatabaseBackupStorageProviderError} when the configured provider
   * is not the active one.
   */
  async startBackup(input: StartBackupInput): Promise<DatabaseBackupRun> {
    const policy = await this.settings.getDatabaseBackupPolicy();

    // BEFORE the claim, so a misconfigured provider produces a clean 400 and
    // no row at all — there is nothing to record about a backup that was never
    // allowed to start, and a `failed` row per attempt would bury the real
    // history under configuration noise.
    this.assertStorageProviderUsable(policy.storageProvider);

    const run = await this.claimRun(input);

    // ⚠ DETACHED, WITH A TERMINAL `.catch()`. `executeRun` is written not to
    // reject — every failure it anticipates is recorded on the row — so this
    // handler is the guard for the ones it does not: a Prisma outage while
    // writing the failure itself, a bug in this file. Without it such a
    // rejection is unhandled, and an unhandled rejection terminates the
    // process. `void` marks the promise as deliberately not awaited.
    void this.executeRun(run, policy).catch((error: unknown) => {
      this.logger.error(
        `Database backup run ${run.id} failed outside its own failure handling: ` +
          `${toError(error).message}`
      );
    });

    return run;
  }

  /**
   * Takes the dump a `db.backup.run` job was queued for, AWAITED.
   *
   * THE JOB'S LIFETIME IS THE DUMP'S LIFETIME — this method returns when
   * `pg_dump` has finished, the archive has been uploaded, and the stored
   * object has been read back and verified. That is the whole point of #351:
   * a handler that returned early would buy a dashboard row and nothing else
   * (no lease, no slot accounting, no timeout, no possibility of node
   * execution). `handlers/db-backup-run.handler.ts` calls exactly this and
   * does nothing else.
   *
   * ---------------------------------------------------------------------------
   * IT IS AUTHORITATIVE ABOUT THE RUN ROW, AND IT IS IDEMPOTENT
   * ---------------------------------------------------------------------------
   *
   * `job_id` is `@unique`, so "the run for this job" is a single lookup that
   * CANNOT return two rows — the resolution below is not a heuristic. What it
   * finds decides what happens:
   *
   *   - `pending` (the ordinary case) → flipped to `running` with `startedAt`
   *     and a seeded heartbeat. Only now has anything actually started, which
   *     is why the row did not claim otherwise before.
   *   - `running` → adopted with a warning. Unreachable while the profile says
   *     `maxAttempts: 1` (the reaper's give-up phase fails such a job rather
   *     than requeueing it), but a fork that raises that budget makes it
   *     reachable, and stranding the row would be worse than re-dumping to a
   *     key that is overwritten anyway.
   *   - `completed` → returns without doing anything. The queue is
   *     at-least-once; re-running a job whose work is already durable must be
   *     a no-op, not a second dump.
   *   - `failed` / `stale` → throws. Something already gave up on this run
   *     (an operator, or the stale sweep), and it is no longer holding the
   *     active slot — so re-dumping could run alongside a backup started since.
   *   - NOTHING AT ALL → creates the row, from the job's payload. `queueBackup`
   *     makes this unreachable for jobs it queued (both rows land in one
   *     commit), so it covers the paths that are not `queueBackup`: a job
   *     enqueued by hand, or a run row an administrator deleted while its job
   *     was still queued. Failing the job there would be a worse answer than
   *     taking the backup that was asked for.
   *
   * @throws whatever the dump failed with, AFTER `executeRun` has recorded it
   * on the run row. The worker turns that into `Job.lastError` and — with
   * `maxAttempts: 1` — a terminal `failed`, never a retry.
   */
  async runQueuedBackup(job: Job): Promise<void> {
    // Read FRESH rather than carried in the payload: the job may have been
    // queued hours ago (a busy worker, a paused queue), and the compression
    // level, the stale window and the storage provider are all settings an
    // administrator may have changed since. Same rule the payload comment
    // states — carry identifiers, re-read state.
    const policy = await this.settings.getDatabaseBackupPolicy();

    // Re-asserted here as well as in `queueBackup`, and not redundantly: the
    // provider can be reconfigured between the enqueue and the claim, and a
    // dump written with the wrong provider is a backup nobody can find. It
    // throws, which fails the job with a legible reason.
    this.assertStorageProviderUsable(policy.storageProvider);

    const run = await this.resolveRunForJob(job);

    // Already `completed` — see the idempotency note above.
    if (run === null) return;

    const outcome = await this.executeRun(run, policy);

    if (outcome.status === 'failed') {
      // ⚠ RETHROWN, DELIBERATELY, EVEN THOUGH THE RUN ROW ALREADY SAYS
      // `failed`. The two rows record different facts — the run says what the
      // archive is, the job says what the executor did — and a job that
      // reported `succeeded` for a dump that failed would be a row that LIES,
      // which is strictly worse than the detached behaviour it replaced. It
      // also makes `GET /api/admin/jobs` and insights tell the truth about
      // backup failures, which is half of why this type exists.
      throw outcome.error;
    }
  }

  /**
   * The run row this job owns, made ready to execute — or `null` when the work
   * is already done. See {@link runQueuedBackup} for the full decision table.
   */
  private async resolveRunForJob(job: Job): Promise<DatabaseBackupRun | null> {
    // ONE lookup on a UNIQUE column. Not a `findFirst` with an ordering, which
    // would be a way of coping with duplicates the schema makes impossible.
    const existing = await this.prisma.databaseBackupRun.findUnique({
      where: { jobId: job.id },
    });

    const startedAt = new Date();

    if (existing !== null) {
      if (existing.status === 'completed') {
        this.logger.log(
          `Job ${job.id} (${BACKUP_JOB_TYPE}) is for backup run ${existing.id}, which has ` +
            'already completed; nothing to do.'
        );

        return null;
      }

      if (existing.status !== 'pending' && existing.status !== 'running') {
        throw new Error(
          `Backup run ${existing.id} is already "${existing.status}", so job ${job.id} will ` +
            'not re-take it: the run no longer holds the single active slot, and dumping now ' +
            'could run alongside a backup started since it was abandoned.'
        );
      }

      if (existing.status === 'running') {
        this.logger.warn(
          `Backup run ${existing.id} was already "running" when job ${job.id} claimed it; ` +
            'its previous executor did not settle it. Re-taking the dump to the same key.'
        );
      }

      return this.prisma.databaseBackupRun.update({
        where: { id: existing.id },
        data: {
          status: 'running',
          // The FIRST start is the one worth keeping — see the `running`
          // branch above, which is the only way this is ever already set.
          startedAt: existing.startedAt ?? startedAt,
          // Seeded so the stale sweep has a baseline from the first moment:
          // a `running` run whose heartbeat is NULL is indistinguishable from
          // one that never started.
          lastHeartbeatAt: startedAt,
        },
      });
    }

    // No row. Create one — the run id is generated here because the storage
    // key embeds it, exactly as in `claimRun` and `queueBackup`.
    const payload = readBackupJobPayload(job);

    this.logger.warn(
      `Job ${job.id} (${BACKUP_JOB_TYPE}) has no backup run row; creating one from its ` +
        'payload. This is expected only for a job that was not queued by `queueBackup`.'
    );

    const id = randomUUID();

    return this.prisma.databaseBackupRun.create({
      data: {
        ...this.buildRunData(payload, { id, bucket: this.storage.getBucket(), at: startedAt }),
        jobId: job.id,
        status: 'running',
        startedAt,
        lastHeartbeatAt: startedAt,
      },
    });
  }

  /**
   * Stops a run THIS PROCESS is executing.
   *
   * Cancellation is not a second teardown mechanism: it destroys the metering
   * stream with a {@link DatabaseBackupCancelledError}, which tears the upload
   * down, which fails the `Promise.all`, which reaches the ORDINARY failure
   * path — partial object deleted, row marked `failed`, heartbeat cleared. A
   * bespoke "cancelled" cleanup would be a second chance to leave a
   * half-written object in the bucket.
   *
   * Reports honestly when it holds no handle; see {@link CancelBackupResult}.
   */
  cancel(runId: string): CancelBackupResult {
    const handle = this.active.get(runId);

    if (handle === undefined) {
      return { outcome: 'not_running_here', runId };
    }

    // Set BEFORE calling `abort`, because `abort` is a no-op in the window
    // between the run being registered and the child existing. `executeRun`
    // re-reads this flag right after the spawn so a cancel that landed in that
    // window still kills the process it just started.
    handle.cancelled = true;
    handle.abort(new DatabaseBackupCancelledError(runId));

    return { outcome: 'signalled', runId };
  }

  /**
   * INSERTs the run, letting the partial unique index decide the race.
   *
   * There is deliberately no `findFirst({ where: { status: 'running' } })`
   * anywhere in this path. That is a check-then-act race and it is racy
   * exactly when it matters — a scheduled tick on one replica and an admin's
   * click on another, in the same second. Only the database can make "is one
   * already active" atomic with the insert that would violate it.
   */
  private async claimRun(input: StartBackupInput): Promise<DatabaseBackupRun> {
    const bucket = this.storage.getBucket();

    for (let attempt = 1; attempt <= CLAIM_MAX_ATTEMPTS; attempt += 1) {
      // The id is generated HERE rather than left to the column default,
      // because the storage key contains it (see `buildBackupStorageKey`) and
      // the key has to be on the row the insert creates — a second UPDATE to
      // fill it in would leave a window in which a crashed process had claimed
      // the active slot with no key to clean up.
      const id = randomUUID();
      const startedAt = new Date();

      const data: Prisma.DatabaseBackupRunUncheckedCreateInput = {
        ...this.buildRunData(input, { id, bucket, at: startedAt }),
        // Claimed directly as `running`, never as `pending`: on THIS path
        // (the `pre_restore` dump) the claim and the start are one act, so a
        // separate `pending` phase would be a state nothing ever observes and
        // a second write to leave behind on a crash. `queueBackup` is the path
        // that legitimately writes `pending`, because there the claim and the
        // start are genuinely different moments — a worker sits between them.
        status: 'running',
        startedAt,
        // Seeded at the claim so the stale sweep has a baseline from the first
        // moment: a run whose heartbeat is NULL is indistinguishable from one
        // that never started.
        lastHeartbeatAt: startedAt,
      };

      try {
        return await this.prisma.databaseBackupRun.create({ data });
      } catch (error) {
        // Any conflict that is NOT this index's is somebody else's problem and
        // must stay loud.
        if (!isActiveRunConflict(error)) {
          throw error;
        }

        const activeRunId = await this.findActiveRunId();

        if (activeRunId !== null) {
          throw new DatabaseBackupAlreadyRunningError(activeRunId);
        }

        // The winner SETTLED between the failed insert and this lookup, so it
        // dropped out of the index's predicate and the slot is free again.
        // Reporting "already running" now would be false. Loop and insert
        // again — with a fresh id and key, because the old ones were never
        // stored.
        this.logger.debug(
          `The active backup slot was released between a conflicting insert and the ` +
            `lookup (attempt ${attempt}/${CLAIM_MAX_ATTEMPTS}); retrying the claim.`
        );
      }
    }

    // Every attempt collided and every lookup came back empty: something is
    // churning runs faster than this loop can insert between them. An honest
    // "not now" with no id beats a spin.
    throw new DatabaseBackupAlreadyRunningError(null);
  }

  /**
   * The columns every new run row carries, whichever path creates it.
   *
   * ONE BUILDER, THREE CALLERS (`claimRun`, `queueBackup`,
   * `resolveRunForJob`), and the reason is the storage triple: provider, key
   * and bucket are chosen by the SERVER and must be chosen the same way every
   * time, or two paths produce archives that a restore looks for in different
   * places. What it deliberately does NOT set is the lifecycle trio —
   * `status`, `startedAt`, `lastHeartbeatAt` — because that is precisely where
   * the three callers legitimately differ.
   *
   * ⚠ `Unchecked` INPUT, DELIBERATELY. `createdById` is a real relation
   * (`createdBy`), and Prisma's *Checked* create input stops accepting the raw
   * scalar the moment a scalar FK is promoted to one — it wants
   * `createdBy: { connect: { id } }` instead, which cannot express "and also
   * null". The unchecked variant takes the column as written, which is what a
   * nullable audit FK wants.
   */
  private buildRunData(
    input: StartBackupInput,
    args: { id: string; bucket: string; at: Date }
  ): Prisma.DatabaseBackupRunUncheckedCreateInput {
    return {
      id: args.id,
      trigger: input.trigger,
      storageProvider: ACTIVE_STORAGE_PROVIDER_ID,
      storageKey: buildBackupStorageKey(args.at, args.id),
      bucket: args.bucket,
      format: BACKUP_ARCHIVE_FORMAT,
      createdById: input.createdById ?? null,
    };
  }

  /** The id of whichever run currently occupies the active slot, or `null`. */
  private async findActiveRunId(): Promise<string | null> {
    const row = await this.prisma.databaseBackupRun.findFirst({
      where: { status: { in: [...ACTIVE_RUN_STATUSES] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    return row?.id ?? null;
  }

  /**
   * The dump itself. NEVER REJECTS for a failure it anticipates — it records
   * the failure on the run and REPORTS it as a {@link BackupRunOutcome},
   * because one of its two callers has nobody left to tell and the other must
   * fail a job.
   *
   * ⚠ THE RETURN VALUE IS NOT A SECOND RECORD OF THE FAILURE. The run row is
   * written first and is the durable fact; this is how the caller learns of
   * it. `startBackup` discards it (detached, nobody to tell);
   * `runQueuedBackup` rethrows `error` so the worker settles the job.
   */
  private async executeRun(
    run: DatabaseBackupRun,
    policy: SystemDatabaseBackupValue
  ): Promise<BackupRunOutcome> {
    const { id: runId, storageKey } = run;
    const handle: ActiveRunHandle = { cancelled: false, abort: () => undefined };
    this.active.set(runId, handle);

    // A holder rather than a plain `let`, so the heartbeat closure and the
    // metering transform see the same counter without either capturing a stale
    // copy.
    const progress = { bytes: 0n };

    // Best-effort provenance, gathered once and written onto whichever terminal
    // update happens — so a FAILED run carries it too. Which server, which
    // build and (most importantly) which schema produced this archive is
    // exactly what someone reading a failure at 3am needs.
    const audit: BackupRunAudit = {
      dbVersion: null,
      appVersion: resolveApiVersion(),
      migrationName: null,
      pgDumpVersion: null,
    };

    let heartbeat: NodeJS.Timeout | undefined;

    try {
      const version = await this.engine.checkClientVersion();

      if (version.status === 'blocked') {
        throw new DatabaseBackupClientVersionError(
          version.message,
          version.clientMajor,
          version.serverMajor
        );
      }

      // `unknown` is WARN AND PROCEED by design — an unreadable version string
      // must never be the reason a backup did not happen. See
      // `pg-version.util.ts`'s header.
      if (version.status === 'unknown') this.logger.warn(version.message);
      if (version.warning !== undefined) this.logger.warn(version.warning);

      // WHICH CLIENT WROTE THIS ARCHIVE (#352). On this path it is the API
      // image's own `pg_dump`, which is not news — but the node path records
      // the same column from a binary nobody here can inspect, and a column
      // that is populated on one path and empty on the other is a column
      // nobody trusts. `version.client` is the raw `--version` banner, or
      // `null` when it could not be read, which never fails a backup.
      audit.pgDumpVersion = version.client ?? null;

      audit.dbVersion = await this.readServerVersion();
      audit.migrationName = await this.readLatestMigrationName();

      const dump = this.engine.startDump({
        compressionLevel: policy.compressionLevel,
        // The operator's own stale window IS the dump's budget. Letting the
        // dump outlive the window that declares it stale would produce a run
        // marked `stale` by #282's sweep while `pg_dump` was still writing to
        // the very key the sweep is about to consider abandoned.
        timeoutMs: policy.runStaleMinutes * 60_000,
      });

      const hash = createHash('sha256');
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          progress.bytes += BigInt(chunk.length);
          // The chunk is forwarded UNCHANGED and NOT retained: this transform
          // is a tap, not a buffer. That is the whole streaming contract.
          callback(null, chunk);
        },
      });

      // ⚠ NO-OP `error` LISTENERS, AND THEY ARE NOT DECORATION. A Node stream
      // that emits `error` with nothing listening throws the error as an
      // UNCAUGHT EXCEPTION and takes the process down. Both of these streams
      // are destroyed on purpose in this file's failure paths — the meter by a
      // dead dump or by `cancel`, stdout when the child is SIGKILLed — and at
      // that moment the upload may already have stopped reading, so there is
      // genuinely no other listener. The error itself is not lost: it is
      // already travelling to the `catch` below through `Promise.all`, which is
      // where the run's `lastError` comes from.
      meter.on('error', () => undefined);
      dump.stdout.on('error', () => undefined);

      handle.abort = (error: Error) => {
        dump.kill('SIGKILL');
        meter.destroy(error);
      };

      // A cancel that arrived while the version check was still running found a
      // no-op `abort`. Re-read the flag now that there is something to kill.
      if (handle.cancelled) {
        handle.abort(new DatabaseBackupCancelledError(runId));
      }

      heartbeat = this.timers.setInterval(() => {
        void this.writeHeartbeat(runId, progress.bytes);
      }, BACKUP_HEARTBEAT_INTERVAL_MS);

      // A DEAD DUMP MUST TEAR THE UPLOAD DOWN. Without this the provider sits
      // waiting on a stream that will never end or error, and the run hangs
      // until something else kills the process. `.catch()` returns a NEW
      // promise, so `dump.done` still rejects into the `Promise.all` below.
      dump.done.catch((error: unknown) => {
        meter.destroy(toError(error));
      });

      const upload = this.storage.upload(storageKey, meter, {
        mimeType: BACKUP_CONTENT_TYPE,
        // Deliberately no `contentLength`: a streamed dump's size is unknown
        // until the last byte, which is exactly why it is streamed.

        // Provenance ON THE OBJECT as well as on the row: an operator staring
        // at a bucket with `aws s3api head-object` can find the run this file
        // came from without a database, which is the situation a restore is
        // most likely to be happening in.
        metadata: { runId, trigger: run.trigger },
      });

      // ...AND A DEAD UPLOAD MUST TEAR THE DUMP DOWN, or `pg_dump` keeps
      // reading a whole database to produce an archive nobody is storing.
      // Same `.catch()` trick: `upload` itself still rejects below.
      upload.catch(() => {
        dump.kill('SIGKILL');
      });

      dump.stdout.pipe(meter);

      // BOTH HALVES. See property 3 in this file's header for why neither one
      // alone is evidence of success.
      await Promise.all([upload, dump.done]);

      // VERIFY WHAT ARRIVED, not what we sent.
      const stored = await this.storage.download(storageKey);
      const tocEntries = await this.engine.readTocEntryCount(stored);

      if (tocEntries <= 0) {
        throw new DatabaseBackupVerificationError(storageKey, tocEntries);
      }

      // ⚠ THE COMPLETING WRITE IS A SHARED METHOD, AND THAT IS THE #352 RULE.
      // `completeNodeRun` — the path where a WORKER NODE ran the dump — calls
      // the very same `completeRun` with the numbers the node reported, so a
      // run's stored state cannot depend on which executor produced it. Inline
      // this update again and the two paths start drifting on the day somebody
      // fixes a bug in one of them. See `example-checksum.handler.ts` for the
      // same shape one level up.
      await this.completeRun({
        runId,
        storageKey,
        // `bytesWritten` and `sizeBytes` converge here and only here: one was
        // live progress, the other is the final answer.
        bytes: progress.bytes,
        checksumSha256: hash.digest('hex'),
        tocEntries,
        executor: 'server',
        audit,
        at: new Date(),
      });

      return { status: 'completed' };
    } catch (error) {
      // ORDER MATTERS. Delete first — see property 5 in the header.
      const failure = toError(error);

      await this.deletePartialObject(storageKey);
      await this.markFailed(runId, failure, progress.bytes, audit);

      // ⚠ RETURNED, NOT RETHROWN, and the `finally` below still runs either
      // way. Rethrowing here would make the detached `pre_restore` path
      // reject, which is the unhandled-rejection hazard property 1 spends a
      // paragraph on; `runQueuedBackup` is where this becomes a throw, and it
      // is a throw with a caller.
      return { status: 'failed', error: failure };
    } finally {
      // ALWAYS. A heartbeat that outlives its run would keep writing
      // `lastHeartbeatAt` to a settled row forever, which is precisely the
      // signal #282's stale sweep uses to decide a run is still alive.
      if (heartbeat !== undefined) this.timers.clearInterval(heartbeat);
      this.active.delete(runId);
    }
  }

  // ===========================================================================
  // The completing write — ONE METHOD, TWO EXECUTORS (#352, epic #345)
  // ===========================================================================

  /**
   * Marks a run `completed`: the terminal write, plus the enqueue of the
   * retention prune that may only ever follow it.
   *
   * ⚠ BOTH EXECUTION PATHS COME THROUGH HERE, AND THAT IS THE POINT.
   * `executeRun` calls it with what THIS process streamed and hashed;
   * {@link completeNodeRun} calls it with what a worker node reported and this
   * server then verified. A run's stored state therefore cannot depend on
   * which executor produced it — the same "one write, two paths" rule
   * `example-checksum.handler.ts` states for a node-eligible handler, applied
   * to the row that a restore later reads.
   *
   * ⚠ IT ASSUMES VERIFICATION HAS ALREADY HAPPENED, and takes `tocEntries` as
   * the evidence rather than the trust: both callers download the STORED
   * object and count its table of contents before calling, and `verifiedAt` is
   * written here precisely because it is unreachable without having done so.
   * Do not add a `skipVerification` parameter; the day this method can be
   * called without a server-side read-back is the day `verified_at` stops
   * meaning anything.
   *
   * The prune's ENQUEUE lives here rather than at the two call sites for the
   * reason the long comment below gives four times over: every one of its
   * ordering constraints is a property of "a run just completed", not of who
   * ran it.
   */
  private async completeRun(input: {
    runId: string;
    storageKey: string;
    bytes: bigint;
    checksumSha256: string;
    /** From `pg_restore --list` over the STORED object. Recorded in the log, not the row. */
    tocEntries: number;
    /** Which executor produced the archive. Log-only — the job row is the durable record. */
    executor: 'server' | 'node';
    audit: BackupRunAudit;
    /** The instant this run settled AND was verified. One clock, this server's. */
    at: Date;
  }): Promise<void> {
    const { runId, storageKey, bytes, executor, at } = input;

    await this.prisma.databaseBackupRun.update({
      where: { id: runId },
      data: {
        status: 'completed',
        finishedAt: at,
        lastHeartbeatAt: at,
        bytesWritten: bytes,
        sizeBytes: bytes,
        checksumSha256: input.checksumSha256,
        // ⚠ THE SERVER'S OWN READ-BACK IS WHAT SETS THIS, on both paths. A
        // node reporting `verified: true` would be the machine with the least
        // reason to be trusted attesting to the one fact this subsystem rests
        // on; see §6 of docs/specs/database-backup.md and the result
        // contract's header.
        verifiedAt: at,
        lastError: null,
        ...input.audit,
      },
    });

    this.logger.log(
      `Database backup run ${runId} completed on the ${executor}: ${bytes} bytes at ` +
        `"${storageKey}" (${input.tocEntries} archive entries verified).`
    );

    // -------------------------------------------------------------------------
    // QUEUE THE PRUNE HERE, AND NOWHERE ELSE (#353, epic #345).
    // -------------------------------------------------------------------------
    //
    // This used to `await this.retention.prune()`. It now enqueues
    // `db.backup.sweep`, whose handler does the pruning on a worker slot — the
    // last piece of long-running work in this subsystem that was still running
    // detached from the queue. ALL THREE ORDERING CONSTRAINTS THAT GOVERNED THE
    // INLINE CALL STILL GOVERN THE ENQUEUE, and they are why this statement is
    // exactly here:
    //
    // AFTER VERIFICATION, because retention deletes older archives and this one
    // is only a replacement for them once it has been proven to be a readable
    // archive. Enqueueing before the `pg_restore --list` check would let a run
    // that is about to fail verification delete the last known-good backup on
    // its way out — the single worst thing this subsystem could do.
    //
    // AFTER THE `completed` UPDATE, not before it, and the reason is an
    // off-by-one that is easy to ship: the count rule keeps the newest N
    // `completed` runs, so a prune that ran while this row still said `running`
    // would not count it, and would evict one MORE old backup than retention
    // asked for — a deployment set to keep 7 would drift to 6. A job cannot be
    // claimed before the write it was enqueued after has committed, so the
    // constraint holds across the move.
    //
    // ONLY ON SUCCESS. There is no enqueue on any failure path. A failed backup
    // is exactly when the old archives matter most; deleting one because the
    // night's dump died would be the failure mode of a backup system that makes
    // things worse under stress.
    //
    // ⚠ THE FOURTH CONSTRAINT IS NOW STRUCTURAL RATHER THAN DEFENDED BY A
    // `try`. The inline call was wrapped because this method runs INSIDE
    // `executeRun`'s `try`, whose `catch` deletes the object and marks the run
    // `failed`: a `throw` escaping retention would have DELETED THE ARCHIVE THIS
    // RUN HAD JUST PROVEN GOOD. The prune now happens in a different job, on a
    // different worker slot, after this job has settled — there is no longer any
    // code path by which retention can reach the backup's failure handler. The
    // `try` stays anyway, because the ENQUEUE is still a database write inside
    // that same `try`, and storage housekeeping must not be able to fail a
    // verified backup for any reason at all.
    try {
      await enqueueHousekeepingJob({
        jobs: this.jobs,
        prisma: this.prisma,
        logger: this.logger,
        type: DB_BACKUP_SWEEP_TYPE,
        what: 'database backup sweep',
      });
    } catch (error) {
      this.logger.warn(
        `Could not queue retention after database backup run ${runId} completed (the ` +
          `backup itself is fine; storage will be reclaimed by the scheduler's next ` +
          `tick): ${toError(error).message}`
      );
    }
  }

  // ===========================================================================
  // The node path (#352, epic #345)
  // ===========================================================================

  /**
   * Where a worker node must write this job's archive — the run's OWN key,
   * re-read by `jobId`.
   *
   * This is what `DatabaseBackupRunHandler.deriveOutputKey` delegates to, and
   * it exists because the data plane's default (`node-outputs/<jobId>/<uuid>`)
   * is exactly wrong for this artifact: `database_backup_runs.storage_key` is
   * what the retention sweep, the download endpoint and the whole restore path
   * look the archive up by, so a backup written anywhere else is a backup none
   * of them can find.
   *
   * ⚠ IDEMPOTENT BY CONSTRUCTION, NOT BY CONVENTION. A node asks for its
   * upload URL more than once as a matter of course (a timed-out transfer, a
   * lost response, a process restarted while holding the lease), and every one
   * of those calls must yield the SAME key or a retry silently writes a second
   * archive that no row points at. The key is read back from the run row, and
   * `DatabaseBackupRun.jobId` is `@unique`, so "there is at most one to find"
   * is enforced by the database rather than remembered by this method.
   *
   * ⚠ IT ALSO FLIPS `pending` → `running`, AND THAT IS DELIBERATE. This
   * request is the ONLY moment the server learns that a remote executor has
   * actually begun dumping: on the node path nothing else writes to the row
   * between the claim and the result. Leaving it `pending` would mean the
   * admin list reports "queued" for a dump that has been streaming for twenty
   * minutes, and `startedAt` — which the failure notification and every
   * duration render — would stay NULL. The flip is idempotent: a second call
   * finds `running` and only reads.
   *
   * @throws when there is no run row for this job, or when the run has already
   * settled. Both fail the upload-URL request (a 500 the node reports as a job
   * failure), which is the correct answer: there is nowhere legitimate for
   * those bytes to go, and signing a URL anyway would put an unreferenced
   * archive in the bucket.
   */
  async resolveNodeOutputKey(job: Job): Promise<string> {
    const run = await this.prisma.databaseBackupRun.findUnique({
      where: { jobId: job.id },
    });

    if (run === null) {
      throw new Error(
        `Job ${job.id} (${BACKUP_JOB_TYPE}) has no backup run row, so there is no key for a ` +
          'node to write to. Refusing to sign an upload.'
      );
    }

    if (run.status !== 'pending' && run.status !== 'running') {
      throw new Error(
        `Backup run ${run.id} is already "${run.status}", so job ${job.id} may not be handed ` +
          'an upload URL: the run no longer holds the active slot and its archive is settled.'
      );
    }

    if (run.status === 'pending') {
      const startedAt = new Date();

      await this.prisma.databaseBackupRun.update({
        where: { id: run.id },
        data: {
          status: 'running',
          startedAt,
          // Seeded so #282's stale sweep has a baseline from the first moment.
          // On this path it is never advanced again — a node has no database
          // access and cannot heartbeat — which is exactly why that sweep
          // consults the JOB's lease before giving up on a run; see
          // `DatabaseBackupScheduleTask.releaseStaleRuns`.
          lastHeartbeatAt: startedAt,
        },
      });

      this.logger.log(
        `Backup run ${run.id} is being taken by a worker node for job ${job.id}; it asked ` +
          `for its upload target, so the dump has started.`
      );
    }

    return run.storageKey;
  }

  /**
   * Writes down a backup a WORKER NODE took — after this server has read the
   * uploaded archive back and proven it is one.
   *
   * This is the whole of `DatabaseBackupRunHandler.persistNodeResult`, and the
   * order of its four steps is the design:
   *
   *   1. FIND THE RUN by `jobId` (one lookup on a UNIQUE column, which cannot
   *      return two rows).
   *   2. REFUSE A KEY WE DID NOT HAND OUT. A node may only report the key
   *      `resolveNodeOutputKey` gave it. Anything else is either a confused
   *      executor or an attempt to point this deployment's restore path at
   *      bytes of somebody else's choosing, and neither is something to
   *      "correct" by trusting the node's spelling.
   *   3. VERIFY SERVER-SIDE, ALWAYS. `download(key)` → `readTocEntryCount` →
   *      `> 0`. The node's `sha256` is recorded as THE NODE'S CLAIM about what
   *      it streamed; `verifiedAt` is set only because THIS process read the
   *      object back out of the bucket. §6 of docs/specs/database-backup.md
   *      already settled that verification means "what the bucket holds", and
   *      the cost — one download per backup — is the cost this path already
   *      pays on the server.
   *   4. WRITE THROUGH {@link completeRun}, the same method `executeRun` uses.
   *
   * ⚠ THIS IS NOT A SECOND DUMP ENGINE AND MUST NOT BECOME ONE. It does not
   * re-hash the archive, does not recompute the size, and does not "fix" a
   * digest it dislikes — `job-handler.interface.ts` states why (the moment the
   * server redoes the work, the node's answer is decorative and the reason for
   * the node plane is gone). The read-back is not a recomputation of the
   * node's result: it is the one check whose whole point is that it must not
   * be delegated.
   *
   * FAILURE GOES THROUGH THE ORDINARY FAILURE PATH — delete the partial
   * object, then mark the run `failed` — for the reason property 5 of this
   * file's header gives: a `failed` run must never leave an object behind, or
   * the bucket accumulates archives that nothing points at and retention has
   * no row to prune them by. The throw then reaches `NodesService.submitResult`,
   * which settles the JOB as failed. Both rows end up telling the truth.
   */
  async completeNodeRun(job: Job, result: DbBackupRunResult): Promise<void> {
    const run = await this.prisma.databaseBackupRun.findUnique({
      where: { jobId: job.id },
    });

    if (run === null) {
      throw new Error(
        `Job ${job.id} (${BACKUP_JOB_TYPE}) has no backup run row, so there is nothing to ` +
          'record a node-taken backup against.'
      );
    }

    // IDEMPOTENT RESUBMISSION. A node whose result reached us but whose
    // response was lost will send the identical result again; the work is done
    // and the row says so. Refusing here would fail a job whose archive is
    // sitting verified in the bucket.
    if (run.status === 'completed') {
      this.logger.log(
        `Backup run ${run.id} is already completed; job ${job.id}'s node result is a ` +
          'resubmission and was ignored.'
      );

      return;
    }

    if (run.status !== 'pending' && run.status !== 'running') {
      throw new Error(
        `Backup run ${run.id} is "${run.status}", so job ${job.id}'s node result will not be ` +
          'recorded: the run was given up on and no longer holds the active backup slot.'
      );
    }

    // ⚠ STEP 2. Compared against the row, never against a recomputed template:
    // the key was chosen once, at run creation, and the row is the only place
    // it lives.
    if (result.storageKey !== run.storageKey) {
      await this.failNodeRun(
        run,
        new Error(
          `The node reported storage key "${result.storageKey}" but backup run ${run.id} was ` +
            `assigned "${run.storageKey}". A node may only report the key the server handed ` +
            'it; nothing was recorded.'
        )
      );

      // Unreachable — `failNodeRun` always throws. Kept so the control flow is
      // readable without following the helper.
      return;
    }

    const bytes = BigInt(result.bytes);

    // ⚠ STEP 3. `readTocEntryCount` reads the STORED object, not the node's
    // report of it. An upload that was truncated by a dead transfer, an
    // archive `pg_dump` never finished writing, and a key the node uploaded
    // nothing to all fail here — which is the entire reason this step is not
    // the node's to perform.
    let tocEntries: number;

    try {
      const stored = await this.storage.download(run.storageKey);
      tocEntries = await this.engine.readTocEntryCount(stored);
    } catch (error) {
      await this.failNodeRun(run, toError(error));

      return;
    }

    if (tocEntries <= 0) {
      await this.failNodeRun(
        run,
        new DatabaseBackupVerificationError(run.storageKey, tocEntries)
      );

      return;
    }

    // The node's own view of the dump, kept in the LOG and out of the row.
    //
    // REJECTED: writing `result.startedAt`/`finishedAt` into `started_at` and
    // `finished_at`. Those two columns are this server's record of the run's
    // lifetime — the claim, and the settle that follows a verified read-back —
    // and a remote clock in them would make a run's duration depend on the
    // executor's NTP configuration, produce `finishedAt < startedAt` for a
    // node running a few seconds behind, and put a value in a column every
    // list, notification and duration render already reads on the server's
    // clock. The node's window is still worth having: it is the only measure
    // of how long the dump ITSELF took, because this process sees only the
    // claim and the settle.
    const at = new Date();
    const skewMs = Math.abs(at.getTime() - Date.parse(result.finishedAt));

    if (Number.isFinite(skewMs) && skewMs > NODE_CLOCK_SKEW_WARN_MS) {
      this.logger.warn(
        `Node-reported finish time for backup run ${run.id} is ${Math.round(skewMs / 1000)}s ` +
          `away from this server's clock. The archive is fine — the row is written on this ` +
          `server's clock — but a node whose clock is far out is worth checking, because its ` +
          `lease arithmetic runs on the same one.`
      );
    }

    await this.completeRun({
      runId: run.id,
      storageKey: run.storageKey,
      bytes,
      checksumSha256: result.sha256,
      tocEntries,
      executor: 'node',
      audit: {
        // The three facts only the executor could know...
        dbVersion: result.dbVersion,
        migrationName: result.migrationName,
        pgDumpVersion: result.pgDumpVersion,
        // ...and the one only this process can: which application build wrote
        // the row. Deliberately NOT the node's CLI version — that is a
        // property of the executor, and `Job.executor` plus the node's own id
        // already record which machine ran it.
        appVersion: resolveApiVersion(),
      },
      at,
    });

    this.logger.log(
      `Backup run ${run.id} was taken by a worker node for job ${job.id}: the node reports it ` +
        `dumped from ${result.startedAt} to ${result.finishedAt} (${bytes} bytes, sha256 ` +
        `${result.sha256.slice(0, 12)}…).`
    );
  }

  /**
   * The node path's failure path: delete, mark, throw.
   *
   * ALWAYS THROWS, and the throw is the contract — `persistNodeResult` failing
   * is how `NodesService.submitResult` learns to settle the job as failed. A
   * variant that returned quietly would leave a `failed` run row under a
   * `succeeded` job, which is precisely the pair of rows that must never
   * disagree.
   *
   * The DELETE comes first, for the reason `executeRun`'s catch does the same:
   * a `failed` run that leaves its object behind is an archive nothing points
   * at and retention has no row to prune it by.
   */
  private async failNodeRun(run: DatabaseBackupRun, error: Error): Promise<never> {
    await this.deletePartialObject(run.storageKey);
    await this.markFailed(run.id, error, run.bytesWritten, {
      dbVersion: run.dbVersion,
      appVersion: run.appVersion ?? resolveApiVersion(),
      migrationName: run.migrationName,
      pgDumpVersion: run.pgDumpVersion,
    });

    throw error;
  }

  /**
   * One heartbeat: liveness plus live progress, in one indexed UPDATE.
   *
   * SWALLOWS ITS OWN FAILURES. A transient write failure — a connection
   * recycled, a brief failover, a lock wait — is not evidence that a dump
   * streaming perfectly well should be abandoned. Aborting a two-hour backup
   * because one progress UPDATE failed would be the definition of a
   * self-inflicted outage. A sustained failure is not silent either: the
   * heartbeat stops advancing, and #282's stale sweep is exactly the mechanism
   * that notices.
   */
  private async writeHeartbeat(runId: string, bytes: bigint): Promise<void> {
    try {
      await this.prisma.databaseBackupRun.update({
        where: { id: runId },
        data: { lastHeartbeatAt: new Date(), bytesWritten: bytes },
      });
    } catch (error) {
      this.logger.warn(
        `Heartbeat for database backup run ${runId} could not be written ` +
          `(the dump continues): ${toError(error).message}`
      );
    }
  }

  /**
   * Removes the object a failed run may have partially written.
   *
   * BEST-EFFORT, AND IT NEVER MASKS THE ORIGINAL ERROR. Whatever broke the
   * backup is what the operator needs on the row; "and the cleanup also failed"
   * is a log line. Deleting a key that was never created is a no-op on every
   * provider this interface targets, so there is no need to check first.
   */
  private async deletePartialObject(storageKey: string): Promise<void> {
    try {
      await this.storage.delete(storageKey);
    } catch (error) {
      this.logger.warn(
        `Could not delete the partial backup object "${storageKey}"; it may need ` +
          `removing by hand: ${toError(error).message}`
      );
    }
  }

  /** Writes the terminal `failed` row. Never throws — it is the last thing in a failure path. */
  private async markFailed(
    runId: string,
    error: Error,
    bytes: bigint,
    audit: BackupRunAudit
  ): Promise<void> {
    this.logger.error(`Database backup run ${runId} failed: ${error.message}`);

    let failed: DatabaseBackupRun;

    try {
      failed = await this.prisma.databaseBackupRun.update({
        where: { id: runId },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          // NOT reset to zero: how far a failed dump got is the difference
          // between "the database refused the connection" and "it died at 40 GB".
          bytesWritten: bytes,
          lastError: error.message,
          ...audit,
        },
      });
    } catch (writeError) {
      // The row is now stuck in `running` with a stopped heartbeat, which is
      // exactly the shape #282's stale sweep exists to resolve. Nothing better
      // is available from here, and throwing would only reach the detached
      // `.catch()` in `startBackup`.
      this.logger.error(
        `Could not record the failure of database backup run ${runId}; the stale ` +
          `sweep will settle it: ${toError(writeError).message}`
      );

      // ⚠ NO NOTIFICATION ON THIS BRANCH, DELIBERATELY. Nothing has been
      // recorded, so the run is still `running` from the table's point of view,
      // and the stale sweep will settle it and raise the event with a `stale`
      // outcome. Raising it here as well would mail two failure notices for one
      // failure, and the second one would contradict the row.
      return;
    }

    // ⚠ AFTER THE COMMIT, AND OUTSIDE ANY TRANSACTION. The `failed` row above
    // is the fact; this is the report of it, and the report must not be able to
    // change or delay the fact. `notifyPermissionHolders` is detached and never
    // rejects, and the `void` is what says so at the call site.
    this.announceFailure(failed, 'failed');
  }

  /**
   * Raise `db_backup.backup_failed` for a settled run. Never throws.
   *
   * SHARED WITH THE STALE SWEEP in shape but not in code — the sweep
   * (`tasks/db-backup-schedule.task.ts`) writes its own rows and raises its own
   * event, because it is a different process settling a run this one never saw.
   * What IS shared is the event key, the permission and the template; the two
   * differ only in `outcome`, which is exactly the field that exists to record
   * that difference.
   */
  private announceFailure(
    run: DatabaseBackupRun,
    outcome: BackupFailedEmailData['outcome']
  ): void {
    try {
      // ANNOTATED WITH THE TEMPLATE'S TYPE: `notifyPermissionHolders` takes
      // `data: unknown`, so this is the only place the shape is checked.
      const payload: BackupFailedEmailData = {
        runId: run.id,
        outcome,
        error: run.lastError,
        startedAt: run.startedAt,
        failedAt: run.finishedAt ?? new Date(),
        trigger: run.trigger,
        appUrl: this.appUrl(),
      };

      // `db_backup:read` — the exact string `db-backup.controller.ts` enforces.
      //
      // ⚠ `.catch()` DESPITE THE DISPATCHER CONTRACTING NEVER TO REJECT: that
      // contract is `NotificationsService`'s, not this file's, and an unhandled
      // rejection on a detached backup-failure path has nobody to report it to.
      // The `try/catch` around this block cannot see a rejected promise.
      void this.notifications
        .notifyPermissionHolders(
          'db_backup.backup_failed',
          PERMISSIONS.DB_BACKUP_READ,
          payload
        )
        .catch((error: unknown) => {
          this.logger.error(
            `Dispatching 'db_backup.backup_failed' for run ${run.id} rejected, ` +
              `which the dispatcher contracts never to do: ${toError(error).message}`
          );
        });
    } catch (error) {
      this.logger.error(
        `Could not raise 'db_backup.backup_failed' for run ${run.id}; the run's ` +
          `${outcome} row is unaffected: ${toError(error).message}`
      );
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
   * The PostgreSQL server version, for the run's audit trio.
   *
   * `current_setting('server_version')` rather than `version()`, which returns
   * a whole banner including the compiler and platform — provenance we neither
   * need nor want to store per run.
   *
   * BEST-EFFORT: a failure here is `null`, never a failed backup. A run that
   * could not read the server version is still a perfectly valid archive.
   */
  private async readServerVersion(): Promise<string | null> {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ server_version: unknown }>>`
        SELECT current_setting('server_version') AS server_version
      `;
      const value = rows[0]?.server_version;

      return typeof value === 'string' && value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }

  /**
   * The newest applied migration, for the run's audit trio.
   *
   * THE MOST IMPORTANT OF THE THREE: it says which SCHEMA the archive
   * contains, so an operator can tell — before replaying it — whether the code
   * that is running will understand what comes back.
   *
   * ⚠ THE QUERY LIVES IN `migration-state.util.ts` AND IS SHARED WITH #284's
   * RESTORE PRE-FLIGHT, which compares the value recorded here against the one
   * live at restore time. Two copies of "the newest applied migration" — one
   * that excludes rolled-back rows and one that does not, say — would make that
   * comparison meaningless: the gate would block restores of compatible
   * archives, or pass an incompatible one. Best-effort, like the version above.
   */
  private async readLatestMigrationName(): Promise<string | null> {
    return readLatestAppliedMigration(this.prisma);
  }
}
