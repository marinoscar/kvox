// =============================================================================
// `db.backup.sweep` — the backup subsystem's housekeeping, as a queue job
// (issue #353, epic #345)
// =============================================================================
//
// TWO DUTIES, ONE JOB, AND THEY ARE ORDERED:
//
//   1. RELEASE STALE RUNS — a run whose executor went away is marked `stale`,
//      which frees the single-active-run slot the partial unique index
//      (`database_backup_runs_active_uniq_idx`) enforces.
//   2. PRUNE BY RETENTION — `DatabaseBackupRetentionService.prune` deletes the
//      archives and rows that `databaseBackup.retentionCount` (and the
//      pre-restore age rule) say are expired.
//
// Both were already written and already tested; #353 did not change either
// one\'s logic. What changed is WHO RUNS THEM, and that is the whole point of
// this file — before it, duty 1 ran inline on the ten-minute scheduler tick and
// duty 2 ran inline at the END OF EVERY SUCCESSFUL BACKUP, awaited inside
// `DatabaseBackupRunnerService.completeRun`. Neither appeared in the admin job
// list, neither held a worker slot, neither had a timeout, and a retention
// prune that deleted forty archives against a slow bucket did it on whichever
// thread had just finished a `pg_dump`.
//
// -----------------------------------------------------------------------------
// ⚠ WHY THE PRUNE MOVED HERE RATHER THAN STAYING WHERE `completeRun` PUT IT
// -----------------------------------------------------------------------------
//
// `completeRun`\'s comment gives three ordering constraints for the prune, and
// ALL THREE SURVIVE THE MOVE — read them in that order, because the third is
// the one that would have broken had this been done carelessly:
//
//   - AFTER VERIFICATION. Retention deletes older archives, and this one is
//     only a replacement for them once it has been proven readable. The enqueue
//     sits after the read-back, so the sweep cannot start before it.
//   - AFTER THE `completed` UPDATE. The count rule keeps the newest N
//     `completed` runs, so a prune racing the terminal write would not count
//     the run that just finished and would evict one MORE old backup than
//     retention asked for. The enqueue happens after that update commits, and a
//     queued job cannot be claimed before the row it was enqueued after is
//     visible.
//   - ONLY ON SUCCESS. There is no enqueue on any failure path. A failed backup
//     is exactly when the old archives matter most.
//
// And the fourth constraint that `completeRun` states — "storage housekeeping
// must not be able to reach the failure path of the backup it is housekeeping
// for" — is now STRUCTURAL rather than defended by a nested `try`. The prune
// runs in a different job, on a different worker slot, after the backup\'s own
// job has already settled. There is no longer any code path by which a
// retention failure can reach the `catch` that deletes the archive.
//
// -----------------------------------------------------------------------------
// ⚠ THE STALE RELEASE NOW COSTS ONE TICK OF LATENCY, AND THAT IS THE TRADE
// -----------------------------------------------------------------------------
//
// `DatabaseBackupScheduleTask`\'s header used to argue that the sweep must run
// BEFORE the fire in the same tick, because the sweep is what releases the slot
// the fire needs: a zombie found at 02:00 was released at 02:00 and the backup
// started in the same tick. That is no longer literally true. The tick now
// enqueues this sweep and then evaluates the boundary, so a tick that finds a
// zombie may still hit `already_running` and stand down.
//
// THE BACKUP IS DELAYED, NEVER LOST, AND BY AT MOST TEN MINUTES. The scheduler\'s
// anti-double-fire rule is stateless and recomputed from the boundary every
// tick ("a late tick still fires"), so the next tick — with the slot now free —
// takes the backup. That property was designed for a process that was down at
// 02:00; it covers this for the same reason. Ten minutes of latency on a
// nightly dump, in the rare case where the previous executor died, is the price
// of the dump\'s housekeeping being accounted for like everything else, and it
// is a price this epic decided to pay everywhere.
//
// REJECTED: keeping the release inline "because it is only an `updateMany`". It
// is not: it is a read, a per-candidate compare-and-swap, a notification per
// released row and a best-effort object DELETE against a bucket, once per
// candidate. That is exactly the shape of work this epic exists to account for.
//
// -----------------------------------------------------------------------------
// SERVER-ONLY, AND NO EXECUTION PROFILE
// -----------------------------------------------------------------------------
//
// Neither `nodeResultSchema` nor `persistNodeResult`, so
// `JobHandlerRegistry.serverOnlyTypes()` derives server-only. Both duties are
// sequences of statements against this application\'s own database plus deletes
// against its own bucket credentials; there is nothing for a machine with no
// database access to compute.
//
// No profile: both duties are idempotent — a run already `stale` is not a
// candidate, an archive already deleted is not in the retention set — so the
// deployment-wide timeout and attempt budget are right, and a retry is free.
// =============================================================================

import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DatabaseBackupStatus, DatabaseBackupTrigger, Job } from '@prisma/client';

import { PERMISSIONS } from '../../common/constants/roles.constants';
import type { SystemDatabaseBackupValue } from '../../common/schemas/settings.schema';
import type { BackupFailedEmailData } from '../../email';
import { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from '../../storage/providers/storage-provider.interface';
import { DatabaseBackupRetentionService } from '../db-backup-retention.service';

/**
 * The handler key, and therefore the `Job.type` every backup-sweep row carries.
 * PERMANENT — rows outlive handlers. Exported because three callers need the
 * same string: the scheduling task, the runner\'s post-backup enqueue, and the
 * tests that assert both.
 */
export const DB_BACKUP_SWEEP_TYPE = 'db.backup.sweep';

/** Anything thrown, as an `Error`. JavaScript lets you throw a string. */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

@Injectable()
export class DatabaseBackupSweepHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(DatabaseBackupSweepHandler.name);

  readonly type = DB_BACKUP_SWEEP_TYPE;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly settings: SystemSettingsService,
    private readonly retention: DatabaseBackupRetentionService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    private readonly config: ConfigService,
    // #288 (epic #254). `db_backup.backup_failed` is raised from BOTH give-up
    // paths — the runner\'s own `markFailed` and this sweep — because they are
    // genuinely different events: one is a run that reported an error, the
    // other is a run whose executing process went away and was never heard from
    // again. The `outcome` field on the payload is what tells them apart.
    private readonly notifications: NotificationsService
  ) {}

  /** Self-registration — the only wiring a handler needs. */
  onModuleInit(): void {
    this.registry.register(this);
  }

  /**
   * Releases stale runs, then prunes by retention.
   *
   * ⚠ THE TWO DUTIES ARE SEPARATELY WRAPPED, AND THE ORDER IS LOAD-BEARING.
   * The release goes first because it is what frees the active slot; the prune
   * goes second because it is pure storage housekeeping that nothing waits on.
   * A failure in either is recorded and the OTHER still runs — they are one job,
   * not one transaction — and the job then THROWS so the queue records a
   * `lastError` and retries. A handler that swallowed both would report a sweep
   * that did nothing as `succeeded`, which is the failure mode
   * `job-handler.interface.ts` calls far worse than a spurious retry.
   */
  async process(job: Job): Promise<void> {
    const policy = await this.settings.getDatabaseBackupPolicy();

    // ONE `now` for the whole sweep, so every candidate is judged against the
    // same instant and a test can pin it.
    const now = new Date();
    const failures: string[] = [];

    try {
      const released = await this.releaseStaleRuns(policy, now);

      if (released > 0) {
        this.logger.warn(
          `Database backup sweep ${job.id}: ${released} run(s) stopped heartbeating and ` +
            'were marked stale; the active slot is free again'
        );
      }
    } catch (error) {
      failures.push(`the stale sweep failed: ${toError(error).message}`);
    }

    try {
      const pruned = await this.retention.prune(now);

      if (pruned.prunedByCount > 0 || pruned.prunedByAge > 0) {
        this.logger.log(
          `Database backup sweep ${job.id}: retention removed ${pruned.prunedByCount} ` +
            `expired backup(s) and ${pruned.prunedByAge} expired pre-restore backup(s).`
        );
      }
    } catch (error) {
      failures.push(`the retention prune failed: ${toError(error).message}`);
    }

    if (failures.length > 0) {
      throw new Error(`Database backup sweep incomplete: ${failures.join('; ')}`);
    }
  }

  /**
   * Gives up on runs whose heartbeat stopped, freeing the active slot.
   *
   * ⚠ `stale` IS TERMINAL AND NOTHING RE-QUEUES IT. Automatically restarting a
   * multi-gigabyte dump that just OOM-killed its own process is not obviously
   * right — it burns hours of I/O on a database that is probably already
   * unwell, and it does it unattended, repeatedly, at whatever hour the first
   * attempt died. The retry for a backup is the next scheduled run, which is
   * the same answer the handler's `maxAttempts: 1` profile gives (#351).
   *
   * `stale` is also distinct from `failed` on purpose: nothing OBSERVED these
   * runs fail. The process holding them disappeared, and an operator reading
   * the list needs to be able to tell "the dump errored" from "the container
   * went away mid-dump".
   *
   * Exposed as its own method so a test can drive it directly, without going
   * through `process`.
   *
   * @returns how many rows this call actually transitioned.
   */
  async releaseStaleRuns(policy: SystemDatabaseBackupValue, now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - policy.runStaleMinutes * 60_000);

    const candidates = await this.prisma.databaseBackupRun.findMany({
      where: {
        // ⚠ THREE ARMS, AND THE THIRD IS NEW IN #351. The predicate used to
        // read `status: 'running'` with a note that "a future path that DOES
        // insert a `pending` row must extend this predicate with it, or that
        // row holds the active slot with no heartbeat that could ever age it
        // out". `queueBackup` is that path — a queued backup's run row is
        // written `pending` and stays that way until a worker claims its job —
        // so the arm is now here.
        OR: [
          // The ordinary case: it was beating and stopped.
          { status: 'running', lastHeartbeatAt: { lt: cutoff } },
          // THE ZOMBIE THAT NEVER BEAT — a process that died between the claim
          // and its first progress write. `NULL < cutoff` is NULL in SQL and
          // never true, so the first arm cannot see it, and without this arm
          // the row holds the active slot FOREVER. `startedAt` is the
          // substitute age, and the claim always sets it. Same two-armed
          // defence the queue's lease reaper uses.
          { status: 'running', lastHeartbeatAt: null, startedAt: { lt: cutoff } },
          // THE QUEUED BACKUP NOBODY EVER CLAIMED. `createdAt` is the age —
          // not `startedAt`, which is NULL by definition on a `pending` row,
          // and not `lastHeartbeatAt`, which is NULL for the same reason: this
          // row has never claimed anything started, and a sweep that inferred
          // an age from a column the row deliberately left empty would be
          // reading its own default.
          //
          // WHAT IT ACTUALLY CATCHES: a job an administrator deleted from
          // `GET /api/admin/jobs` (the FK's `SetNull` releases the link and
          // leaves this row `pending` forever), a job queued on a deployment
          // whose worker is off (`JOBS_WORKER_MODE=off`), and a job that
          // permanently failed before its handler ever ran. Each of those
          // leaves a row that HOLDS THE SINGLE ACTIVE SLOT with nothing coming
          // to settle it — which, under the tightened index, blocks every
          // backup this deployment would ever take again.
          //
          // The window is `runStaleMinutes` (120 by default), so an ordinary
          // queue delay never trips it: a backup that has sat unclaimed for two
          // hours is not a backup that is about to run.
          { status: 'pending', createdAt: { lt: cutoff } },
        ],
      },
      // `startedAt` and `trigger` join the projection for #288: they are what
      // `db_backup.backup_failed` renders, and reading them here — in the query
      // the sweep was making anyway — is cheaper and less racy than a second
      // read after the row has been rewritten. `status` joins it for #351: the
      // compare-and-swap below has to re-assert THE STATUS THIS ROW WAS READ
      // WITH, and a literal `'running'` there would silently skip every
      // `pending` candidate the arm above just found.
      select: {
        id: true,
        status: true,
        storageKey: true,
        startedAt: true,
        trigger: true,
        // #352: the run's job, so the sweep can ask whether an executor is
        // still holding it. See `withLiveExecutor` for why this is not
        // optional politeness.
        jobId: true,
      },
    });

    // ⚠ A RUN WHOSE JOB IS STILL LEASED IS NOT STALE, WHATEVER ITS HEARTBEAT
    // SAYS (#352, epic #345).
    //
    // The heartbeat above is the liveness signal of a dump running IN THIS
    // PROCESS: `executeRun` writes it every 20 seconds while `pg_dump`
    // streams. A dump running ON A WORKER NODE cannot write it at all — a node
    // has no database access, which is the entire premise of the node plane —
    // so on that path the row's `lastHeartbeatAt` is written once, when the
    // node asks for its upload target, and then never again.
    //
    // Without this filter the sweep would mark a perfectly healthy node-run
    // backup `stale` after `runStaleMinutes`, DELETE THE ARCHIVE THE NODE IS
    // STILL UPLOADING, and then refuse the node's result because the run had
    // settled — a data-losing failure that only appears on the deployments
    // slow enough to need node offload in the first place.
    //
    // The right liveness signal for a remotely executed run is the one the
    // executor is already maintaining: THE JOB'S LEASE (#347). A node renews
    // it on a ticker for exactly as long as it is working, and the queue's own
    // reaper is what handles an executor that stops. So the sweep asks the job
    // — and it asks for BOTH executors, not just nodes, because "an executor
    // still holds this work" is the same fact whoever holds it: an in-process
    // dump whose heartbeat was starved by a lock wait is equally not abandoned
    // while its worker is renewing.
    //
    // REJECTED: having the node heartbeat the run through a new endpoint. That
    // is a second liveness clock for the same fact, and two clocks disagree —
    // the node would be renewing a lease AND poking a heartbeat, and the day
    // one of them failed the other would say everything was fine.
    // REJECTED: skipping only `pending` rows with a live job. It would leave
    // the far worse case — a node that has started dumping, so the row says
    // `running` — exposed for exactly as long as the dump takes.
    const live = await this.withLiveExecutor(candidates, now);

    // ONE COPY OF THE EXPLANATION PER CASE, written to the row AND carried
    // into the notification (#288). Two copies of either would be two places
    // to reword, and the email quoting something the row does not say is worse
    // than no email.
    //
    // ⚠ TWO MESSAGES, NOT ONE, because the two states fail for genuinely
    // different reasons and an operator fixes them in different places: a
    // `running` row was executing somewhere and that somewhere went away; a
    // `pending` row was never picked up at all, which is a statement about the
    // QUEUE (no worker, a deleted job) and not about any dump. Flattening them
    // into "stopped heartbeating" would send somebody looking through
    // `pg_dump` logs for a process that never existed.
    const staleMessage = (status: DatabaseBackupStatus): string =>
      status === 'pending'
        ? `The run was queued but no worker claimed its job within ` +
          `${policy.runStaleMinutes} minute(s) (databaseBackup.runStaleMinutes), so it was ` +
          'given up on to free the single active backup slot. No dump was ever started. ' +
          'Check that a worker is running (JOBS_WORKER_MODE) and that the job was not ' +
          'deleted; the next scheduled backup is the retry.'
        : `The run stopped heartbeating for more than ${policy.runStaleMinutes} ` +
          'minute(s) (databaseBackup.runStaleMinutes) and was given up on. Nothing ' +
          'observed it fail: the process executing it went away. It is not retried ' +
          'automatically; the next scheduled backup is the retry.';

    let released = 0;

    for (const candidate of candidates) {
      if (candidate.jobId !== null && live.has(candidate.jobId)) {
        this.logger.debug(
          `Database backup run ${candidate.id} has not heartbeated, but its job ` +
            `${candidate.jobId} is still held under a live lease; leaving it alone. This is ` +
            'the ordinary shape of a backup being taken by a worker node, which cannot write ' +
            'to this database at all.'
        );

        continue;
      }

      const message = staleMessage(candidate.status);
      // ⚠ THE ROW TRANSITION HAPPENS FIRST, AND THE ROW *IS* THE GUARD.
      //
      // A conditional `updateMany` re-asserting `status: 'running'`, not an
      // `update` by id: the read above and this write are not atomic, and the
      // interesting case is the run that FINISHED in between — a dump whose
      // heartbeat was starved by a lock wait, that then completed normally two
      // seconds later. `count === 0` means exactly that, and it must NOT be
      // stomped: overwriting a `completed` row with `stale` would discard a
      // perfectly good verified backup's record, and (worse) the object
      // cleanup below would then delete the archive it points at.
      //
      // ⚠ `candidate.status`, NOT THE LITERAL `'running'` IT USED TO BE. The
      // guard's job is to re-assert the state the row was READ in, so that a
      // row which moved on since is left alone — and since #351 that state can
      // be `pending` as well. A hard-coded `'running'` here would make every
      // `pending` candidate `count === 0` and the sweep would quietly free
      // nothing, which is the failure mode that looks exactly like working.
      const { count } = await this.prisma.databaseBackupRun.updateMany({
        where: { id: candidate.id, status: candidate.status },
        data: {
          status: 'stale',
          finishedAt: now,
          lastError: message,
        },
      });

      if (count === 0) {
        this.logger.debug(
          `Database backup run ${candidate.id} settled between the stale sweep's read ` +
            'and its write; leaving it alone.'
        );

        continue;
      }

      released += 1;

      // ⚠ AFTER THE `stale` ROW HAS COMMITTED, and only on the branch where
      // THIS process is the one that transitioned it (`count === 1` — the
      // `continue` above covers the replica that lost the race). One settled run
      // raises exactly one notification however many replicas are sweeping.
      //
      // Before the object cleanup below, deliberately: the delete is
      // best-effort and may take a while against a slow bucket, and the report
      // of the failure should not wait on the tidying-up of a partial archive.
      // `notifyPermissionHolders` is detached and never rejects, so this costs
      // the sweep nothing and cannot fail it.
      this.announceStale(candidate, message, now);

      // ⚠ AND OBJECT CLEANUP FOLLOWS, NEVER PRECEDES.
      //
      // Same ordering as the runner's failure path and the retention sweep,
      // for the same reason read the other way round: if the delete went first
      // and this process died before the row was transitioned, the row would
      // still say `running` and still point at an object that no longer
      // exists — and it would keep holding the active slot. With the row
      // first, a failed delete leaves a VISIBLE `stale` row naming an orphaned
      // object an operator can find and remove, rather than an invisible
      // billable one nothing points at.
      //
      // Best-effort, and it never fails the sweep: the slot is already free,
      // which is the part that had to happen.
      try {
        await this.storage.delete(candidate.storageKey);
      } catch (error) {
        this.logger.warn(
          `Marked database backup run ${candidate.id} stale but could not delete its ` +
            `partial object "${candidate.storageKey}"; it may need removing by hand: ` +
            `${toError(error).message}`
        );
      }
    }

    return released;
  }

  /**
   * Of these candidates' jobs, the ids that an executor still holds under a
   * LIVE lease.
   *
   * ONE QUERY FOR THE WHOLE BATCH, and it reads the queue's own columns rather
   * than re-deriving anything: `status: 'running'` plus `leaseExpiresAt > now`
   * is precisely what `JobLeaseService` means by "held", and it is the same
   * predicate the queue's reaper uses to decide the opposite question. A
   * second definition of "leased" here would be a second thing to keep in
   * step with #347.
   *
   * Returns an EMPTY SET when nothing qualifies — including when no candidate
   * has a job at all, in which case there is no query to make. Every run that
   * predates #351, and every `pre_restore` dump, has `jobId === null` and is
   * swept exactly as it always was.
   */
  private async withLiveExecutor(
    candidates: readonly { jobId: string | null | undefined }[],
    now: Date
  ): Promise<Set<string>> {
    // `typeof`, not `!== null`: the column is `string | null` on a real row,
    // and this stays total for any caller passing a projection that simply has
    // not selected it — a missing job id must mean "ask nothing", never "ask
    // about undefined".
    const jobIds = candidates
      .map((candidate) => candidate.jobId)
      .filter((jobId): jobId is string => typeof jobId === 'string' && jobId.length > 0);

    if (jobIds.length === 0) return new Set();

    const held = await this.prisma.job.findMany({
      where: {
        id: { in: jobIds },
        status: 'running',
        leaseExpiresAt: { gt: now },
      },
      select: { id: true },
    });

    return new Set(held.map((job) => job.id));
  }

  /**
   * Raise `db_backup.backup_failed` for a run this sweep gave up on. Never
   * throws.
   *
   * ⚠ `outcome: 'stale'` AND NOT `'failed'`, and the distinction is the whole
   * reason the field exists. A `failed` run reported an error: something
   * observed it break and wrote down what. A `stale` run reported nothing —
   * the process executing it went away, and the sweep is inferring the failure
   * from silence. An operator chasing the two looks in completely different
   * places (a dump's stderr versus a host that disappeared), so the message
   * says which it is rather than flattening both into "backup failed".
   *
   * SYNCHRONOUS AND FIRE-AND-FORGET: `notifyPermissionHolders` schedules the
   * audience query and the sends and returns, so a ten-minute cron never waits
   * on a mail server, and the try/catch means a notifier bug cannot abort a
   * sweep that has already freed the active slot.
   */
  private announceStale(
    run: { id: string; startedAt: Date | null; trigger: DatabaseBackupTrigger },
    reason: string,
    settledAt: Date
  ): void {
    try {
      // ANNOTATED WITH THE TEMPLATE'S TYPE: `notifyPermissionHolders` takes
      // `data: unknown`, so this is the only place the shape is checked.
      const payload: BackupFailedEmailData = {
        runId: run.id,
        outcome: 'stale',
        error: reason,
        startedAt: run.startedAt,
        failedAt: settledAt,
        trigger: run.trigger,
        appUrl: this.appUrl(),
      };

      // `db_backup:read` — the exact string `db-backup.controller.ts` enforces,
      // and the same one the runner's own failure path uses.
      // ⚠ `.catch()` DESPITE THE DISPATCHER CONTRACTING NEVER TO REJECT — same
      // reason as everywhere else this event is raised: an unhandled rejection
      // inside a `@Cron` tick has no caller, and the `try/catch` around this
      // block cannot see one.
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
        `Could not raise 'db_backup.backup_failed' for run ${run.id}; the run is ` +
          `still marked stale and its slot is free: ${toError(error).message}`
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
}
