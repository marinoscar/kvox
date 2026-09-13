// =============================================================================
// `db.backup.run` — the database dump as a queue job (issue #351, epic #345)
// =============================================================================
//
// THE CHANGE THE WHOLE EPIC EXISTS FOR. Until now "back up now" was a detached
// promise: `DatabaseBackupRunnerService.startBackup` awaited an INSERT and
// then fired `void this.executeRun(...)`. The dump had no job type, appeared
// in neither `GET /api/admin/jobs` nor insights, occupied no worker slot, had
// no timeout, and could not run anywhere but the API process. This handler is
// what ends that.
//
// -----------------------------------------------------------------------------
// THE THREE OBJECTIONS `schema.prisma` RAISED, AND WHERE EACH IS NOW ANSWERED
// -----------------------------------------------------------------------------
//
// The `### Why this is not a queue job` block in the schema was RIGHT when it
// was written, and it is worth reading what changed rather than assuming it
// was merely overcautious. It gave three reasons, and this file's two-line
// `profile` answers two of them by configuration while #347 answered the
// third by implementation:
//
//   1. "`jobs.stuckThresholdMinutes` DEFAULTS TO 30 MINUTES, so the reaper
//      would reset a running dump to `pending` and a SECOND `pg_dump` would
//      start against the same storage key." → `maxRuntimeMs: 6h`. The lease is
//      DERIVED from that ceiling (`resolveJobLeaseMs` = ceiling + grace), never
//      declared beside it, so the reaper's deadline is longer than the
//      permitted runtime BY CONSTRUCTION — the disagreement the old comment
//      described is now unrepresentable rather than merely unlikely. See
//      `job-execution-profile.ts`'s header for the full argument.
//   2. "THE IN-PROCESS WORKER HAS NO LEASE-RENEWAL PATH." → #347 gave it one.
//      `JobWorker` renews on a ticker (lease ÷ 3) for exactly as long as
//      `process()` runs, so a six-hour dump holds its claim by continuously
//      proving it is alive rather than by a lease long enough to cover the
//      worst case.
//   3. "A JOB HAS `attempts` AND A RETRY BUDGET." → `maxAttempts: 1`, below.
//
// -----------------------------------------------------------------------------
// ⚠ `maxAttempts: 1` — THE THIRD ARGUMENT, ANSWERED BY CONFIGURATION
// -----------------------------------------------------------------------------
//
// Re-running a failed multi-gigabyte dump is exactly the wrong behaviour, and
// nothing about moving onto the queue makes it less wrong: it burns hours of
// I/O on a database that is probably already unwell, unattended, at whatever
// hour the first attempt died — and it does it while the operator is asleep,
// against a server that may be failing for reasons a second full read will
// make worse. THE CORRECT RETRY FOR A BACKUP IS THE NEXT SCHEDULED ONE.
//
// What changed is not the policy but WHO ENFORCES IT. Before #351 that
// sentence was true because there was no queue to disagree with it; the dump
// simply lived outside anything that could retry it, and the guarantee rested
// on the absence of a mechanism. Now `JobStuckService`'s give-up phase reads
// this exact number through `resolveMaxAttempts` and permanently fails a
// `db.backup.run` whose attempt budget is spent, instead of requeueing it —
// so "never automatically retried" is a declared property the queue enforces
// rather than a property of not being in the queue.
//
// A useful consequence: because `attempts` is charged AT CLAIM TIME
// (`job-claim.service.ts`), a dump whose process is OOM-killed mid-run has
// already spent its only attempt. The lease expires, the reaper finds it, and
// the give-up phase fails it — it is not re-dumped by the very condition that
// killed it.
//
// -----------------------------------------------------------------------------
// WHY THIS CLASS IS FOUR LINES OF BEHAVIOUR AND NOT FOUR HUNDRED
// -----------------------------------------------------------------------------
//
// `process()` delegates to `DatabaseBackupRunnerService.runQueuedBackup` and
// does nothing else. That is not thinness for its own sake: the runner is THE
// ONE WRITER of `database_backup_runs` (`db-backup.module.ts` says so, and the
// single-active-run index is only a guarantee if that stays true), and the
// streaming contract its header spends 150 lines stating — the metering
// transform, the two-way `Promise.all`, delete-before-mark-failed, verify what
// arrived — must not acquire a second implementation here.
//
// REJECTED: a thin wrapper that calls `startBackup()` and returns. That is the
// escape hatch the old schema comment explicitly permitted ("a job handler may
// call `startBackup()` and return — but the dump's lifetime must never be a
// job's lifetime"), and it buys a dashboard row and nothing else: the job
// would settle in milliseconds while the dump ran for hours, so there would
// still be no lease, no slot accounting, no timeout and no possibility of node
// execution. `runQueuedBackup` is AWAITED, so the job's lifetime IS the dump's
// lifetime, which is the entire point.
//
// -----------------------------------------------------------------------------
// NODE-ELIGIBLE SINCE #352 — ALL THREE MEMBERS, TOGETHER
// -----------------------------------------------------------------------------
//
// `nodeResultSchema` + `persistNodeResult` + `deriveOutputKey` landed in ONE
// change, and the eligibility rule in `job-handler.interface.ts` is why: BOTH
// members or NEITHER. Exactly one of the pair means server-only by derivation
// — a schema with no persist function describes a payload nobody can store,
// and a persist function with no schema would trust an unvalidated remote
// body. `deriveOutputKey` joins them because without it the data plane would
// sign an upload to `node-outputs/<jobId>/<uuid>`, and an archive there is one
// the retention sweep, the download endpoint and the restore path cannot find:
// `database_backup_runs.storage_key` is how every one of them looks it up. A
// node-eligible backup that wrote to the wrong key would not be a feature,
// it would be a backup you cannot restore.
//
// All three delegate to `DatabaseBackupRunnerService`, which stays THE ONE
// WRITER of `database_backup_runs` (`db-backup.module.ts` says so, and the
// single-active-run index is only a guarantee while that holds). In
// particular `persistNodeResult` reaches the same private `completeRun` that
// the server path's `executeRun` uses — `example-checksum.handler.ts`'s "one
// write, two paths", applied to the row a restore reads.
//
// ⚠ WHAT `persistNodeResult` DOES NOT DO IS THE INTERESTING PART. It does not
// re-hash the archive and it does not recompute its size — that would make the
// node's work decorative, which `job-handler.interface.ts` forbids. It DOES
// download the stored object and read its table of contents, because
// VERIFICATION IS NOT PART OF THE NODE'S WORK: §6 of
// docs/specs/database-backup.md defines verification as "what the bucket
// holds", and a node attesting to its own upload is the machine with the least
// reason to be trusted vouching for the one fact this subsystem rests on.
//
// -----------------------------------------------------------------------------
// ⚠ ELIGIBLE IS NOT THE SAME AS OFFERED — THREE GATES, ALL AT CLAIM TIME
// -----------------------------------------------------------------------------
//
// This type is node-eligible permanently and structurally, because the members
// above say so. Whether a NODE IS EVER OFFERED IT is a separate, runtime
// question with three independent answers, all intersected in
// `NodesService.nodeEligibleTypes` and none of them touching the registry:
//
//   1. `nodes.jobSecretBrokerEnabled` — may the broker issue anything at all?
//   2. `nodeSecretBroker.usable()` — CAN it, on this database, right now?
//      (managed PostgreSQL denying CREATEROLE is the ordinary case)
//   3. `databaseBackup.nodeOffloadEnabled` — may THIS workload leave the
//      server? That is `nodeOffloadEnabled()` below.
//
// With any of the three saying no, the type is withheld from the claim and the
// in-process worker takes the backup — exactly what happened before #352. A
// node never sees the job, so there is no half-state where a node holds a
// backup it cannot get a credential for.
//
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Job } from '@prisma/client';

import {
  dbBackupRunResultSchema,
  type DbBackupRunResult,
} from '../../jobs/contracts/db-backup-run.contract';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';

import {
  BACKUP_JOB_TYPE,
  DatabaseBackupRunnerService,
} from '../db-backup-runner.service';
import { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import type { JobExecutionProfile } from '../../jobs/job-execution-profile';
import type { JobSecretBroker } from '../../jobs/job-secret-broker';
import { PgJobRoleBroker } from '../pg-job-role.broker';

/**
 * The wall-clock ceiling for one dump, in milliseconds.
 *
 * SIX HOURS, and the number is chosen to be uninteresting rather than tight.
 * It is not a target — a dump that takes six hours is a deployment with a
 * problem — it is the point past which "still streaming" stops being a
 * credible explanation and a wedged process is the better hypothesis. The
 * alternative to a large ceiling is not a small one, it is `0` (no ceiling at
 * all), and that trades a stuck backup slot that eventually frees itself for
 * one that never does.
 *
 * ⚠ IT IS ALSO THE LEASE, INDIRECTLY. `resolveJobLeaseMs` derives the claim's
 * lease from this number, so raising it lengthens how long a dead executor's
 * claim survives before the reaper reclaims it. That coupling is deliberate
 * (see `job-execution-profile.ts`); it is the reason a lease may not be
 * declared separately.
 */
export const BACKUP_JOB_MAX_RUNTIME_MS = 6 * 60 * 60 * 1000;

@Injectable()
export class DatabaseBackupRunHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(DatabaseBackupRunHandler.name);

  /**
   * Imported from the runner rather than written out here, because the
   * enqueueing side and the executing side must agree on it exactly and only
   * one of the two can own the definition. See `BACKUP_JOB_TYPE`.
   */
  readonly type = BACKUP_JOB_TYPE;

  /**
   * The two numbers this type is unlike the rest of the queue in — and there
   * will only ever be two (`job-execution-profile.ts` explains why a lease and
   * a renewal interval are derived rather than declared).
   *
   * See this file's header for the argument behind each: `maxRuntimeMs`
   * answers the reaper objection, `maxAttempts: 1` answers the retry
   * objection.
   */
  readonly profile: JobExecutionProfile = {
    maxRuntimeMs: BACKUP_JOB_MAX_RUNTIME_MS,
    maxAttempts: 1,
  };

  /**
   * The credential a REMOTE executor of this type needs — the first broker
   * registered anywhere in this repository (#350, epic #345).
   *
   * ⚠ PRESENCE IS THE DECLARATION, exactly as it is for `nodeResultSchema` +
   * `persistNodeResult`. There is no `requiresSecret: 'postgres'` string and no
   * switch keyed on one; hanging the implementation itself off the handler is
   * what makes "a type that names a secret nobody can mint" unrepresentable.
   * See `job-secret-broker.ts`'s header for the whole argument.
   *
   * ⚠ THIS DOES NOT MAKE THE TYPE NODE-ELIGIBLE, AND THE TWO ARE INDEPENDENT
   * FACTS. Eligibility is derived from `nodeResultSchema` + `persistNodeResult`,
   * which #352 adds; until then `JobHandlerRegistry.serverOnlyTypes()` still
   * contains this type and no node can claim it. Declaring the broker first is
   * deliberate — it is the half that needs a real PostgreSQL to review, and it
   * is inert until the other half lands.
   *
   * ⚠ NOR IS IT PERMISSION TO USE ONE. Whether a node in THIS deployment may
   * hold a credential to THIS database is an administrator's trust-boundary
   * decision: `nodes.jobSecretBrokerEnabled`, default OFF. With it off the type
   * is withheld from the claim entirely (`NodesService.nodeEligibleTypes`) and
   * the secret route refuses with a named reason.
   *
   * Injected rather than constructed here so the broker is a normal provider
   * with a substitutable cluster seam — and so that exactly one instance exists,
   * which is what makes its `CREATEROLE` probe cache mean anything.
   */
  readonly nodeSecretBroker: JobSecretBroker;

  /**
   * THE FIRST OF THE TWO MEMBERS THAT MAKE THIS TYPE NODE-ELIGIBLE (#352).
   *
   * It lives in `jobs/contracts/` rather than inline because a second reader
   * needs it: `GET /api/nodes/job-types` converts it with `z.toJSONSchema()`
   * so a worker validates against the server's own definition before it
   * submits. Its header is where the `bytes`-as-a-decimal-string argument
   * lives, which is the one field of the eight nobody should change casually.
   */
  readonly nodeResultSchema = dbBackupRunResultSchema;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly runner: DatabaseBackupRunnerService,
    private readonly settings: SystemSettingsService,
    broker: PgJobRoleBroker
  ) {
    this.nodeSecretBroker = broker;
  }

  /** Self-registration — the only wiring a handler needs. */
  onModuleInit(): void {
    this.registry.register(this);
  }

  /**
   * Takes the backup, AWAITED to completion.
   *
   * Returns when `pg_dump` has finished, the archive has been uploaded, and
   * the STORED OBJECT has been read back through `pg_restore --list` — so a
   * `succeeded` job of this type means a run that was verified, not merely one
   * that was started. Throws whatever the dump failed with, after the runner
   * has recorded it on the run row; with `maxAttempts: 1` the worker turns
   * that into a terminal `failed` and never a retry.
   */
  async process(job: Job): Promise<void> {
    this.logger.log(`Taking a database backup for job ${job.id}.`);

    await this.runner.runQueuedBackup(job);
  }

  // ===========================================================================
  // The node path (#352, epic #345)
  // ===========================================================================

  /**
   * Where a node must write this job's archive: the run's OWN key.
   *
   * Delegated whole to the runner, which re-reads the run by `jobId` (a
   * `@unique` column, so at most one row can be found) and returns the key it
   * recorded at creation. That is what makes this IDEMPOTENT — the one hard
   * requirement `JobHandler.deriveOutputKey` states, because a node asks for
   * its upload URL again after a timed-out transfer, a lost response or a
   * restart, and a derivation that minted something new each time would leave
   * a second archive that no row points at.
   *
   * Note what this is NOT: it is not the node choosing a key. The value is
   * computed in this process, from the job row, by the feature that owns the
   * artifact. A node-supplied `key` is refused with a 400 long before this
   * runs.
   */
  deriveOutputKey(job: Job): Promise<string> {
    return this.runner.resolveNodeOutputKey(job);
  }

  /**
   * THE SECOND MEMBER THAT MAKES THIS TYPE NODE-ELIGIBLE: records a backup a
   * node took, after this server has read the archive back out of the bucket.
   *
   * ⚠ IT PARSES AGAIN, DELIBERATELY, and not out of distrust for
   * `NodesService.submitResult` (which has already parsed against the same
   * schema). The interface hands this method `result: unknown` because the
   * value came from off-machine, so narrowing is the only way to touch a field
   * at all — and re-parsing rather than casting means a future caller that
   * forgets to validate cannot write an arbitrary object into
   * `database_backup_runs` through this method. The cost is one schema parse
   * of an eight-field object, once per backup.
   *
   * Everything else is the runner's, including the key check, the server-side
   * verification and the shared completing write. See
   * `DatabaseBackupRunnerService.completeNodeRun`.
   */
  async persistNodeResult(job: Job, result: unknown): Promise<void> {
    const parsed: DbBackupRunResult = this.nodeResultSchema.parse(result);

    await this.runner.completeNodeRun(job, parsed);
  }

  /**
   * May a node take this deployment's backups today?
   *
   * `databaseBackup.nodeOffloadEnabled`, default FALSE — read HERE rather than
   * in `NodesService` for the reason `JobHandler.nodeOffloadEnabled` gives: a
   * `if (type === BACKUP_JOB_TYPE)` in the nodes module would be a central
   * dispatch table keyed on job type, and it would make that module depend on
   * this feature's settings shape. The handler owns the type, so the handler
   * answers the question.
   *
   * ⚠ READ PER CLAIM, NOT CACHED AND NOT READ AT STARTUP. The value is an
   * administrator's decision, and a cached copy is how "we turned node offload
   * off" takes effect at some unspecified later time — which for this
   * particular switch means an unwanted multi-gigabyte dump on a machine
   * somebody has just decided not to trust.
   *
   * A settings read that FAILS returns `false`: withholding the type falls
   * back to the in-process worker, which is the behaviour this deployment had
   * before node offload existed and is never worse than not backing up.
   */
  async nodeOffloadEnabled(): Promise<boolean> {
    try {
      const policy = await this.settings.getDatabaseBackupPolicy();

      return policy.nodeOffloadEnabled;
    } catch (error) {
      this.logger.warn(
        `Could not read databaseBackup.nodeOffloadEnabled; withholding ${BACKUP_JOB_TYPE} ` +
          `from the node plane and leaving the backup to the in-process worker: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );

      return false;
    }
  }
}
