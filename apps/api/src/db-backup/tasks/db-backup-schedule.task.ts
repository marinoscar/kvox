import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';

import { enqueueHousekeepingJob } from '../../jobs/housekeeping.enqueue';
import { JobsService } from '../../jobs/jobs.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import type { SystemDatabaseBackupValue } from '../../common/schemas/settings.schema';
import { DB_BACKUP_SWEEP_TYPE } from '../handlers/db-backup-sweep.handler';
import { DB_RESTORE_OLD_DB_DROP_TYPE } from '../handlers/db-restore-old-db-drop.handler';
import { DatabaseBackupRunnerService } from '../db-backup-runner.service';
import { DatabaseBackupAlreadyRunningError } from '../db-backup.errors';
import {
  backupScheduleToCron,
  InvalidTimezoneError,
  previousFireBoundary,
} from '../schedule.util';

// =============================================================================
// The backup scheduler (issue #282, converted by #353, epic #345)
// =============================================================================
//
// #281 shipped an engine with no caller. This is the caller. Every ten minutes
// it does exactly three things, in this order:
//
//   1. QUEUE THE HOUSEKEEPING SWEEP — `db.backup.sweep`, which releases runs
//      whose executor went away and then prunes by retention.
//   2. FIRE A DUE BACKUP — if the schedule says one should have started and
//      none has, queue one.
//   3. QUEUE THE RETAINED-DATABASE DROP — `db.restore.old-db-drop`, for
//      `<live>_old_<ts>` databases a restore displaced (#285), past
//      `databaseBackup.oldDatabaseRetentionHours`.
//
// ⚠ ONLY DUTY 2 STILL DECIDES ANYTHING HERE. Duties 1 and 3 used to run INLINE
// in this tick and now only enqueue: the work moved to
// `handlers/db-backup-sweep.handler.ts` and
// `handlers/db-restore-old-db-drop.handler.ts` respectively, which is #353's
// rule ("the cron decides whether work is due; a handler does the work")
// applied to the last two inline duties in this subsystem. Each handler's
// header carries its own argument; do not move that code back here.
//
// -----------------------------------------------------------------------------
// ⚠ THE SWEEP NO LONGER FREES THE SLOT *WITHIN* THIS TICK
// -----------------------------------------------------------------------------
//
// This header used to argue that the sweep must run FIRST because it is what
// RELEASES the slot the fire needs: `database_backup_runs_active_uniq_idx`
// permits one active run, so a row abandoned by a container that vanished
// mid-dump holds the slot until something transitions it, and a fire that ran
// first would collide with that zombie and log "already running".
//
// That argument still holds, and the ordering below still honours it as far as
// it now can — the sweep is enqueued before the boundary is evaluated, so a
// worker may well have released the slot by the time the fire runs. But it is
// no longer GUARANTEED within the tick, and pretending otherwise would be the
// kind of comment that quietly stops being true. THE BACKUP IS DELAYED, NEVER
// LOST, AND BY AT MOST TEN MINUTES: the anti-double-fire rule below is
// stateless and recomputed from the boundary every tick, so the next tick — with
// the slot now free — takes the backup. "A late tick still fires" was designed
// for a process that was down at 02:00; it covers this for the same reason.
//
// Duty 3 goes LAST because it is the only one nothing else depends on, exactly
// as it did when it ran inline.
//
// -----------------------------------------------------------------------------
// GATED ON `DB_BACKUP_SCHEDULE_ENABLED`, AND NEVER ON `JOBS_WORKER_MODE`
// -----------------------------------------------------------------------------
//
// The line that is not in this file matters as much as the ones that are:
// there is no `if (workerMode === 'off') return`. This is not a queue worker,
// and #351 did not make it one — what this tick does is DECIDE a backup is due
// and ENQUEUE it; a worker takes the dump. `JOBS_WORKER_MODE=off` says "this
// process executes no queued jobs"; it does not say "this deployment's
// database does not need backing up". A pure control plane in front of an
// external node fleet is still the only process with a database connection at
// all, so gating the schedule on its willingness to run jobs would mean that
// deployment silently never even QUEUES a backup. That is the same precedent
// `JOBS_REAPER_ENABLED` and `NODE_STALE_OFFLINE_ENABLED` already set: an
// always-on maintenance cron with a switch of its own.
//
// ⚠ THE HONEST CAVEAT SINCE #351: with `JOBS_WORKER_MODE=off` this tick queues
// backups that nothing will execute. `system` mode does execute them
// (`db.backup.run` is server-only by derivation, so that mode claims it); only
// `off` does not. Those unclaimed `pending` run rows would hold the single
// active backup slot forever, which is precisely the third arm
// `DatabaseBackupSweepHandler.releaseStaleRuns` carries — and which, in an
// `off` deployment, nothing would run either. `off` means "this process
// executes no queued jobs", and since #353 that includes this subsystem's
// housekeeping.
//
// The switch DEFAULTS TO ON and only the literal `false` turns it off, for the
// reason every kill switch here fails open: a deployment whose backups
// silently stopped because of a typo in an env file looks exactly like a
// deployment that is being backed up.
//
// -----------------------------------------------------------------------------
// TEN MINUTES, AND WHY THAT IS NOT SLOPPY
// -----------------------------------------------------------------------------
//
// A backup scheduled for 02:00 starts somewhere in [02:00, 02:10). The
// alternative — `@Cron` on the operator's own expression — would need the
// timer re-registered every time an administrator edits the schedule, and a
// missed tick (a deploy at 01:59, a process restart, a paused container)
// would silently skip the night entirely with nothing left behind to notice
// it. A coarse poll plus the boundary check below RECOVERS a missed window
// instead of losing it, which is the property that matters for something that
// runs once a day. Ten minutes also matches the two sweeps this sits beside.
//
// -----------------------------------------------------------------------------
// THE ANTI-DOUBLE-FIRE RULE IS STATELESS, AND THAT IS THE WHOLE DESIGN
// -----------------------------------------------------------------------------
//
//     boundary = previousFireBoundary(expr, now, timezone)
//     latest   = the run with the greatest startedAt
//     fire only if latest.startedAt < boundary
//
// "Has a run already started since the moment this schedule last came due?"
// The answer is computed from the settings and the table, and from nothing
// else. That buys three properties at once:
//
//   - EXACTLY ONE RUN PER BOUNDARY. Six ticks fall inside a one-hour window
//     and five of them find a run whose `startedAt` is at or after the
//     boundary.
//   - A LATE TICK STILL FIRES. If the process was down from 01:55 to 02:40,
//     the 02:40 tick computes the same 02:00 boundary, sees no run since it,
//     and takes the backup 40 minutes late instead of not at all.
//   - RESTARTS ARE FREE. There is no in-memory "last fired" to lose and no
//     column to keep current, so a fresh process reaches the same verdict as
//     the one it replaced.
//
// REJECTED: a `lastRunAt` column (or a settings field) stamped after each
// fire. It is the obvious design and it is strictly worse in three ways. It
// DRIFTS — the value written is when the run actually started, so a fire ten
// minutes late moves the next comparison ten minutes later, and a "daily"
// backup walks forward through the day. It NEEDS A WRITE OF ITS OWN, which
// can fail after the backup started, producing a second fire on the next
// tick — two `pg_dump`s for one night, arbitrated only by the active index.
// And it CANNOT BE RECOMPUTED: if it is ever wrong (a restored settings blob,
// a hand-edited row, a clock jump) nothing can repair it, whereas a boundary
// is derived fresh from the schedule every ten minutes.
//
// REJECTED: "did we fire in the last N minutes". It answers a question nobody
// asked. Two ticks in one window both see "no run in the last 10 minutes"
// after a run that started 11 minutes ago, and a weekly schedule would need N
// to be a week — at which point a manual backup on Tuesday suppresses
// Sunday's scheduled one.
//
// ⚠ `startedAt` IS COMPARED, AND EVERY TRIGGER COUNTS. A `manual` backup taken
// at 02:05 satisfies the 02:00 boundary and the scheduler stands down. That is
// deliberate: the schedule's promise is "a backup exists for this window", not
// "a backup with the `scheduled` label exists", and taking a second full dump
// of the same database five minutes after an administrator took one is pure
// I/O for no additional safety.
//
// -----------------------------------------------------------------------------
// THE TIMEZONE IS PASSED EXPLICITLY, AND A BAD ONE STANDS THE SCHEDULER DOWN
// -----------------------------------------------------------------------------
//
// `previousFireBoundary(expr, now, policy.timezone)` — never a two-argument
// call. Omitting the zone would evaluate "02:00" in the SERVER's zone, which
// in a container is UTC, which is not what an operator in Denver typed. The
// symptom would be a backup running at the wrong hour with nothing anywhere
// reporting a problem.
//
// A zone this runtime does not know throws `InvalidTimezoneError` (#280 made
// it a throw rather than a `null` precisely so this file can tell it from
// "nothing due"). The response is to STAND DOWN, not to guess: firing in UTC
// instead would put a nightly dump in the middle of the working day, and
// because the boundary would then be wrong the "already fired" check would be
// wrong with it.
//
// ⚠ IT LOGS ONCE. Standing down happens on EVERY tick — 144 a day — and the
// error is evaluated before the due check, so an unlatched log would bury its
// own diagnosis under 144 identical copies daily until someone fixed a setting
// they could no longer find the message about. The latch is KEYED ON THE ZONE,
// so correcting the setting (or breaking it differently) logs again, and a
// zone that starts working clears the latch so a later regression is loud.
// =============================================================================

/** What one `fireDueBackup` decided. Exposed so a test can assert the verdict directly. */
export type BackupFireOutcome =
  /** A run was claimed and is streaming. */
  | 'fired'
  /** `databaseBackup.enabled` is false. */
  | 'disabled'
  /** Nothing is due, or a run already covers this boundary. */
  | 'not_due'
  /** Something already holds the active slot — the guard did its job. */
  | 'already_running'
  /** `databaseBackup.timezone` is not a zone this runtime knows. */
  | 'bad_timezone';

/** Anything thrown, as an `Error`. JavaScript lets you throw a string. */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

@Injectable()
export class DatabaseBackupScheduleTask {
  private readonly logger = new Logger(DatabaseBackupScheduleTask.name);

  /**
   * The in-process overlap guard.
   *
   * Not a lock and not pretending to be one — cross-replica exclusion is the
   * partial unique index's job, and the sweep's `updateMany` re-asserts its
   * own predicate so two replicas racing produce one winner and one no-op.
   * This exists for the single-process case the sweep cannot absorb: a tick
   * that is still waiting on a slow database when the next one fires would
   * otherwise run the boundary check twice against the same unchanged table.
   */
  private ticking = false;

  /**
   * The timezone whose failure has already been reported, or `null`.
   *
   * KEYED ON THE VALUE, not a boolean: a boolean would mean an operator who
   * fixed one typo and made another never hears about the second. Cleared the
   * moment a boundary computes successfully, so a zone that breaks again later
   * — a runtime downgrade, an ICU build without full data — is loud again.
   */
  private reportedBadTimezone: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SystemSettingsService,
    private readonly runner: DatabaseBackupRunnerService,
    private readonly config: ConfigService,
    // #353 (epic #345). The only new collaborator: this tick queues the two
    // housekeeping jobs it used to perform. The storage provider, the restore
    // service and the notifier all left with the duties that needed them —
    // which is the clearest possible statement that this class no longer
    // deletes objects, drops databases or reports failures.
    private readonly jobs: JobsService
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async handleCron(): Promise<void> {
    if (!this.enabled()) {
      this.logger.debug(
        'The database backup scheduler is disabled (DB_BACKUP_SCHEDULE_ENABLED); skipping'
      );

      return;
    }

    if (this.ticking) {
      this.logger.warn(
        'The previous database backup tick has not finished; skipping this one rather ' +
          'than running two boundary checks against the same table'
      );

      return;
    }

    this.ticking = true;

    try {
      const policy = await this.settings.getDatabaseBackupPolicy();

      // ONE `now` for the whole tick, so the schedule boundary is judged
      // against a single instant — and so a test can pin it without touching
      // the wall clock.
      const now = new Date();

      // SWEEP FIRST — see the header. The enqueue never throws, so no `try` of
      // its own is needed any more: `enqueueHousekeepingJob` swallows and logs,
      // which is what the wrapper around the inline sweep used to do by hand.
      await enqueueHousekeepingJob({
        jobs: this.jobs,
        prisma: this.prisma,
        logger: this.logger,
        type: DB_BACKUP_SWEEP_TYPE,
        what: 'database backup sweep',
      });

      await this.fireDueBackup(policy, now);

      // LAST, because nothing waits on it — the same position it held when it
      // ran inline, and for the same reason.
      await enqueueHousekeepingJob({
        jobs: this.jobs,
        prisma: this.prisma,
        logger: this.logger,
        type: DB_RESTORE_OLD_DB_DROP_TYPE,
        what: 'retained-database sweep',
      });
    } catch (error) {
      // SWALLOWED, like every other scheduled task here. A throw out of a
      // `@Cron` handler is an unhandled rejection, and an unhandled rejection
      // terminates the process by default: a database blip must not be able to
      // take the API down, and it must not stop the scheduler permanently
      // either — the next tick would have run anyway.
      this.logger.error(
        `The database backup scheduler tick failed: ${toError(error).message}`
      );
    } finally {
      // ALWAYS. A guard left set by a throw would stop the scheduler forever,
      // which is the one failure this whole file exists to not have.
      this.ticking = false;
    }
  }

  /**
   * Starts a backup if the schedule says one is due and none has covered this
   * boundary.
   *
   * Exposed as its own method so a test can pin `now` — which is what makes
   * the DST and late-tick criteria testable at all — without going through the
   * kill switch and the swallowing `catch`.
   */
  async fireDueBackup(
    policy: SystemDatabaseBackupValue,
    now: Date
  ): Promise<BackupFireOutcome> {
    if (!policy.enabled) {
      // ⚠ ONLY THE FIRING IS GATED. The sweep above runs whatever this says,
      // and that asymmetry is deliberate: a run orphaned BEFORE an
      // administrator switched scheduled backups off still holds the single
      // active slot, and leaving it there would make every later MANUAL backup
      // (#283) fail with "already running" for a schedule nobody is using. The
      // setting is a statement about taking backups automatically, not about
      // cleaning up after ones that were already taken.
      this.logger.debug(
        'Scheduled database backups are disabled (databaseBackup.enabled); not firing'
      );

      return 'disabled';
    }

    const expression = backupScheduleToCron(policy);
    let boundary: Date | null;

    try {
      // THE ZONE IS ALWAYS PASSED. Omitting it evaluates the operator's
      // "02:00" in the server's zone, which in a container is UTC.
      boundary = previousFireBoundary(expression, now, policy.timezone);
    } catch (error) {
      if (error instanceof InvalidTimezoneError) {
        this.reportBadTimezone(error);

        return 'bad_timezone';
      }

      // Anything else (an expression outside the supported subset) is a bug in
      // `backupScheduleToCron`, not a configuration mistake, and must stay
      // loud: it reaches the tick's `catch` and is logged as an error.
      throw error;
    }

    // The zone works. Clear the latch so a LATER failure of the same zone is
    // reported again rather than swallowed by a stale one.
    this.reportedBadTimezone = null;

    if (boundary === null) {
      // Nothing due inside `SCHEDULE_SEARCH_LIMIT_DAYS`. Not reachable from
      // any expression `backupScheduleToCron` emits (every one of them fires
      // at least monthly), so this is the honest answer to a case that should
      // not happen rather than a case worth logging about.
      return 'not_due';
    }

    // "Has anything started since this schedule last came due?" — the whole
    // anti-double-fire rule, in one indexed query against `startedAt DESC`.
    // `startedAt: { not: null }` because a row that never started says nothing
    // about whether a window was covered.
    //
    // ⚠ #351 MADE `startedAt` NULL FOR A WHILE, AND THIS QUERY IS DELIBERATELY
    // UNCHANGED. A queued backup's run row is created `pending` with no
    // `startedAt`, and stays that way until a worker claims the job — so
    // between the enqueue and the claim this query cannot see it, and a tick
    // in that window will decide the boundary is still uncovered and fire
    // again. That is safe, and fixing it here would be worse than the problem:
    // the second fire is collapsed by the queue's CONSTANT dedup key (the
    // enqueue returns the job already in flight, `queueBackup` raises
    // `DatabaseBackupAlreadyRunningError`, and the branch below stands down at
    // debug level). Widening this predicate to count `pending` rows would mean
    // a run row that never gets claimed — a job deleted by an administrator,
    // say — could silently suppress every scheduled backup that came after it,
    // which is the failure this subsystem must not have. A row that never
    // started still says nothing about whether a window was covered.
    const latest = await this.prisma.databaseBackupRun.findFirst({
      where: { startedAt: { not: null } },
      orderBy: { startedAt: 'desc' },
      select: { id: true, startedAt: true },
    });

    if (latest?.startedAt != null && latest.startedAt >= boundary) {
      this.logger.debug(
        `A database backup already covers the ${boundary.toISOString()} boundary ` +
          `(run ${latest.id} started ${latest.startedAt.toISOString()}); not firing.`
      );

      return 'not_due';
    }

    try {
      const { run, job } = await this.runner.queueBackup({
        trigger: 'scheduled',
        // No `createdById`. A timer has no user, and attributing this to the
        // last administrator who logged in would put a name on an action
        // nobody took.
      });

      this.logger.log(
        `Queued scheduled database backup ${run.id} (job ${job.id}) for the ` +
          `${boundary.toISOString()} boundary (${expression} in ${policy.timezone}).`
      );

      return 'fired';
    } catch (error) {
      if (error instanceof DatabaseBackupAlreadyRunningError) {
        // DEBUG, NOT ERROR. The single-active-run index refused a second dump,
        // which is precisely what it is for: another replica's tick got there
        // first, or a long dump from the previous window is still streaming.
        // Nothing is wrong, and logging it as an error would train an operator
        // to ignore this subsystem's errors.
        this.logger.debug(
          `A database backup is already running; the scheduler stood down: ${error.message}`
        );

        return 'already_running';
      }

      // A misconfigured storage provider, or anything else: loud, and it
      // recurs until an operator fixes it. That repetition is correct for a
      // subsystem whose failure mode is silence — no row is created when the
      // claim is refused before it happens, so this log line is the only
      // evidence that backups are not being taken.
      throw error;
    }
  }

  /**
   * Logs an unusable timezone ONCE per offending value.
   *
   * The message names the setting and what the scheduler did about it, because
   * the reader of this line has a deployment that is silently not being backed
   * up and needs both facts in one place.
   */
  private reportBadTimezone(error: InvalidTimezoneError): void {
    if (this.reportedBadTimezone === error.timezone) return;

    this.reportedBadTimezone = error.timezone;

    this.logger.error(
      `Scheduled database backups are standing down: ${error.message} Fix ` +
        'databaseBackup.timezone in system settings; nothing will be backed up on a ' +
        'schedule until it names a zone this runtime knows. (Logged once per value.)'
    );
  }

  /**
   * Whether this process schedules backups at all.
   *
   * DEFAULTS TO ON, and only the literal `false` turns it off (see
   * `configuration.ts`) — the same fail-open direction `JOBS_REAPER_ENABLED`
   * and `NODE_STALE_OFFLINE_ENABLED` take, for the same reason stated more
   * sharply here: a deployment whose backups silently stopped because of a
   * typo in an env file is indistinguishable from one that is being backed up,
   * right up until somebody needs a restore.
   *
   * It exists for the one legitimate case: several API replicas sharing one
   * database where an operator wants exactly one of them scheduling. Running
   * it everywhere is safe anyway — the active index makes the second claim a
   * no-op and the sweep re-asserts its own predicate — the switch just saves
   * the duplicated queries.
   */
  private enabled(): boolean {
    return this.config.get<boolean>('dbBackup.scheduleEnabled') !== false;
  }
}
