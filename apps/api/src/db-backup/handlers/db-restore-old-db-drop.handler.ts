// =============================================================================
// `db.restore.old-db-drop` — dropping databases a restore displaced, as a queue
// job (issue #353, epic #345)
// =============================================================================
//
// A retained database is a FULL SECOND COPY of the production database, kept so
// that rolling a restore back costs one rename instead of a multi-hour replay
// (#285). Something has to drop it when `databaseBackup.oldDatabaseRetentionHours`
// closes, and until #353 that something was the third duty of
// `DatabaseBackupScheduleTask`'s ten-minute tick, inline.
//
// It is a job now for the reason every other conversion in #353 is: `DROP
// DATABASE` against a copy of a production database is not a statement whose
// duration nobody should have to account for. It can block for as long as one
// session somebody left open, it can fail for reasons an operator needs to see,
// and "did the displaced database get cleaned up?" deserves a better answer
// than a log grep on whichever replica held the timer. As a job it has a
// duration, a `lastError` and a retry budget.
//
// -----------------------------------------------------------------------------
// THE WORK ITSELF DID NOT MOVE, AND MUST NOT
// -----------------------------------------------------------------------------
//
// `DatabaseRestoreService.dropExpiredOldDatabases` stays where it is and this
// handler calls it, exactly as the cron did. The restore service owns the admin
// connection, the identifier rules, the live-database guard and the seam, and a
// second place that issues `DROP DATABASE` is a second place to get the guard
// wrong. Read that method's header for why the sweep is ROW-DRIVEN rather than
// name-driven — it is the reason this job will never drop a database an
// operator created by hand from the runbook's guided command block.
//
// -----------------------------------------------------------------------------
// SERVER-ONLY, PERMANENTLY, FOR THE SAME REASON THE RESTORE IS
// -----------------------------------------------------------------------------
//
// Neither `nodeResultSchema` nor `persistNodeResult`, so
// `JobHandlerRegistry.serverOnlyTypes()` derives server-only and nothing has to
// enforce it. It runs an ADMIN CONNECTION ON THE `postgres` MAINTENANCE
// DATABASE and drops databases with it. That is the most privileged credential
// this application ever holds, and the node plane's founding constraint is that
// a node holds none (`docs/specs/worker-nodes.md` §8). There is no version of
// this work that belongs on a remote machine.
//
// NO PROFILE: the sweep is idempotent (a database already dropped is skipped by
// the `databaseExists` check) and per-row failures are already swallowed inside
// the service, so the deployment-wide timeout and attempt budget are right.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job } from '@prisma/client';

import { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { DatabaseRestoreService } from '../database-restore.service';

/**
 * The handler key, and therefore the `Job.type` every old-database-drop row
 * carries. PERMANENT — rows outlive handlers. Exported so the scheduling task
 * asks about the same string it queues.
 */
export const DB_RESTORE_OLD_DB_DROP_TYPE = 'db.restore.old-db-drop';

@Injectable()
export class DatabaseRestoreOldDbDropHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(DatabaseRestoreOldDbDropHandler.name);

  readonly type = DB_RESTORE_OLD_DB_DROP_TYPE;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly settings: SystemSettingsService,
    private readonly restore: DatabaseRestoreService
  ) {}

  /** Self-registration — the only wiring a handler needs. */
  onModuleInit(): void {
    this.registry.register(this);
  }

  /**
   * Drops every `<live>_old_<ts>` database past its retention window.
   *
   * THROWS TO FAIL. The cron this replaced caught and logged, because a throw
   * out of a `@Cron` handler is an unhandled rejection; here the worker above
   * turns a rejection into `lastError` plus a retry, and swallowing would report
   * a sweep that never ran as `succeeded`. Note that a SINGLE database that
   * could not be dropped is not a failure — the service swallows those per row
   * and the next sweep retries them — so a throw out of here means the settings
   * read or the admin connection failed, which is exactly what an operator
   * should see.
   */
  async process(job: Job): Promise<void> {
    const policy = await this.settings.getDatabaseBackupPolicy();
    const dropped = await this.restore.dropExpiredOldDatabases(policy, new Date());

    if (dropped > 0) {
      this.logger.warn(
        `Retained-database sweep ${job.id}: dropped ${dropped} database(s) displaced by a ` +
          `restore and past ${policy.oldDatabaseRetentionHours}h; rolling those restores ` +
          'back now means restoring an archive rather than renaming a database'
      );
    } else {
      this.logger.debug(
        `Retained-database sweep ${job.id}: no displaced database is past its retention`
      );
    }
  }
}
