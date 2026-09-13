// =============================================================================
// `db.restore.run` — replacing the live database, as a queue job
// (issue #353, epic #345)
// =============================================================================
//
// The last of the two genuinely long-running detached operations in this
// application (`grep -rn "void this\." apps/api/src` found exactly two: the
// backup, moved by #351, and this). Until now `DatabaseRestoreService
// .startRestore` ended in `void this.executeRestore(...)`: a promise nothing
// owned, running for hours, absent from `GET /api/admin/jobs`, holding no
// worker slot, bounded by no timeout, and — on a process that restarted
// mid-replay — leaving nothing behind that any part of the system would ever
// come back to. It is a job now, and it gets the queue's accounting like
// everything else.
//
// -----------------------------------------------------------------------------
// ⚠ SERVER-ONLY. PERMANENTLY. THIS IS NOT A DEFAULT, IT IS A DECISION.
// -----------------------------------------------------------------------------
//
// This handler carries `process()` and NEITHER `nodeResultSchema` NOR
// `persistNodeResult`, so `JobHandlerRegistry.serverOnlyTypes()` DERIVES
// server-only and nothing anywhere has to enforce it — the same construction
// `job-handler.interface.ts` chose over a `nodeEligible: boolean` flag, and the
// reason there is no line of code in the nodes module mentioning this type.
//
// The reason it must never become node-eligible, stated once so nobody has to
// reconstruct it:
//
//   - IT RENAMES THE LIVE DATABASE. Twice, and the window between the two
//     renames is a window in which no database exists under the application's
//     name at all.
//   - IT TERMINATES EVERY POOLED CONNECTION on that database, including this
//     application's own, because a rename fails while any session is attached.
//   - IT NEEDS `CREATEDB`, and it runs its DDL over an ADMIN CONNECTION ON THE
//     `postgres` MAINTENANCE DATABASE — the most privileged credential this
//     deployment has. The node plane's founding constraint is that a node holds
//     NO credentials (`docs/specs/worker-nodes.md` §8); the secret broker (#349)
//     exists to mint a SHORT-LIVED READ-ONLY role for a `pg_dump`, and there is
//     no version of it that could mint this.
//   - IT ENDS BY EXITING THE PROCESS, so that a supervisor restarts the API with
//     a connection pool built against the promoted database. A remote executor
//     exiting ITS process would achieve nothing at all: the process that must
//     restart is this one.
//
// None of that is work a remote machine may do, and `apps/api/test/jobs/`'s
// server-only assertion pins it so a future member added to this class cannot
// quietly make it claimable.
//
// -----------------------------------------------------------------------------
// ⚠ THE PROFILE: SIX HOURS, AND EXACTLY ONE ATTEMPT
// -----------------------------------------------------------------------------
//
// `maxAttempts: 1` IS THE MOST IMPORTANT LINE IN THIS FILE. `attempts` is
// charged AT CLAIM TIME (`job-claim.service.ts`), so a restore whose executor
// dies has already spent its only attempt: the lease expires, the reaper finds
// it, and the give-up phase permanently FAILS the row instead of requeueing it.
// That is the behaviour this type must have, because A REQUEUED RESTORE WOULD
// REPLAY A RESTORE THAT MAY ALREADY HAVE SUCCEEDED — unattended, against the
// database it just promoted, from an archive that is now older than the live
// data. It is the worst outcome available anywhere in this epic, and
// `resolveMaxAttempts` reading this number on BOTH give-up paths (the terminal
// service and the reaper) is what makes "never automatically retried" a
// property the queue enforces rather than a property of nobody having written
// the retry yet.
//
// `maxRuntimeMs: 6h` matches the backup's, and for the same reason: a restore
// is a download, a `pg_restore -j` replay and a verification pass over a
// database whose size nobody here knows. It is not a target, it is the point
// past which "still replaying" stops being a credible explanation. The lease is
// DERIVED from it (`resolveJobLeaseMs`), never declared beside it, so the
// reaper's deadline is longer than the permitted runtime by construction.
//
// -----------------------------------------------------------------------------
// ⚠ `process()` DOES NOT RETURN ON THE SUCCESS PATH, AND THAT IS HANDLED
// -----------------------------------------------------------------------------
//
// The swap ends in `DatabaseRestoreSeam.exitProcess(0)`, inside `process()`. So
// on the path where everything works, this method never returns, the worker's
// `completeSucceeded` never runs, and — left alone — the `jobs` row would sit
// `running` with a live lease until the restarted process's reaper found it and,
// under `maxAttempts: 1`, marked a SUCCESSFUL restore `failed`.
//
// The terminal write is therefore performed by the restore itself, as part of
// the catalog carried across the rename: see `CarriedJob` and `CARRY_JOB_SQL` in
// `database-restore.service.ts` for the full ordering argument. In one line: the
// settled row is written into the PROMOTED database, after both renames have
// succeeded and before the exit, so it lands if and only if the restore actually
// happened. `test/db-backup/restore-job-settlement.spec.ts` pins it.
//
// A harmless consequence worth knowing about: the worker's lease-renewal ticker
// may fire between the rename and the exit, find the row already `succeeded`
// (or, for the few milliseconds of the rename window, find no database), and log
// that the lease could not be renewed. It is correct — this worker no longer
// holds the row, because the row is finished — and the process exits moments
// later.
//
// -----------------------------------------------------------------------------
// THE GATES ARE NOT RE-RUN HERE
// -----------------------------------------------------------------------------
//
// `startRestore` runs the pre-flight before it enqueues, and its VERDICT — the
// two database names and the effective rollback mode — travels in the payload.
// See `RestoreJobPayload`: re-deriving those names from a later clock would make
// the API response, the run row and the DDL name three different databases. The
// run ROW is re-read at run time, because the payload carries identifiers and
// not copies.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job } from '@prisma/client';

import { JobHandler } from '../../jobs/job-handler.interface';
import type { JobExecutionProfile } from '../../jobs/job-execution-profile';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { DatabaseRestoreService, DB_RESTORE_RUN_TYPE } from '../database-restore.service';

/**
 * The wall-clock ceiling for one restore, in milliseconds.
 *
 * SIX HOURS — the same number `BACKUP_JOB_MAX_RUNTIME_MS` uses, and chosen to be
 * uninteresting rather than tight for the same reason. ⚠ IT IS ALSO THE LEASE,
 * INDIRECTLY: `resolveJobLeaseMs` derives the claim's lease from this number, so
 * raising it lengthens how long a dead executor's claim survives before the
 * reaper reclaims it. That coupling is deliberate — see
 * `job-execution-profile.ts` for why a lease may not be declared separately.
 */
export const RESTORE_JOB_MAX_RUNTIME_MS = 6 * 60 * 60 * 1000;

@Injectable()
export class DatabaseRestoreRunHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(DatabaseRestoreRunHandler.name);

  /**
   * Imported from the service rather than written out here, because the
   * enqueueing side and the executing side must agree on it exactly and only one
   * of the two can own the definition. See `DB_RESTORE_RUN_TYPE`.
   */
  readonly type = DB_RESTORE_RUN_TYPE;

  /**
   * The two numbers this type is unlike the rest of the queue in — and there
   * will only ever be two. See the file header for the argument behind each.
   */
  readonly profile: JobExecutionProfile = {
    maxRuntimeMs: RESTORE_JOB_MAX_RUNTIME_MS,
    maxAttempts: 1,
  };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly restore: DatabaseRestoreService
  ) {}

  /** Self-registration — the only wiring a handler needs. */
  onModuleInit(): void {
    this.registry.register(this);
  }

  /**
   * Replays the archive named in the payload and swaps it into place.
   *
   * ⚠ ON SUCCESS THIS NEVER RETURNS — the process exits inside the swap, having
   * already written this job's own terminal row into the promoted database. See
   * the file header.
   *
   * On failure it throws, after `executeRestore` has recorded what happened on
   * the run's restore columns. With `maxAttempts: 1` the worker turns that into
   * a terminal `failed` and never a retry.
   */
  async process(job: Job): Promise<void> {
    this.logger.warn(
      `Executing database restore job ${job.id}. This replaces the live database; the ` +
        'process will exit when the swap completes so a supervisor can restart it.'
    );

    await this.restore.executeRestoreJob(job);
  }
}
