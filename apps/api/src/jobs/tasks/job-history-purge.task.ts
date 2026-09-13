import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { JOB_HISTORY_PURGE_TYPE } from '../handlers/job-history-purge.handler';
import { JobsService } from '../jobs.service';

// =============================================================================
// The nightly history-purge scheduler (issue #263, epic #254)
// =============================================================================
//
// ⚠ THIS TASK DELETES NOTHING. It enqueues a job, and the handler
// (`handlers/job-history-purge.handler.ts`) does the work on a worker slot.
// That indirection is the point. It was, when this file was written, what made
// this task different from the three older cleanup crons (`TokenCleanupTask`,
// `DeviceCodeCleanupTask`, `StorageCleanupTask`), each of which did its own
// deleting inline — and #353 (epic #345) then made every maintenance cron in
// this application look like this one, using the four arguments below as the
// case for doing it. See docs/specs/job-queue.md §7.10 for the general rule,
// its three permanent exemptions, and what it deliberately does not cover.
//
//   - IT IS OBSERVABLE. A purge that ran is a `jobs` row with a status, a
//     duration, an attempt count and a `lastError` — visible in the admin job
//     list like any other work. An inline cron leaves one log line, if the
//     process that emitted it is still around to be asked.
//   - IT RETRIES ON THE QUEUE'S OWN BUDGET. A purge that fails half way
//     through gets `JOBS_MAX_ATTEMPTS` and exponential backoff for free. An
//     inline cron gets "wait 24 hours".
//   - IT RUNS WHERE THE WORK BELONGS. The purge competes for a worker slot
//     with other background work instead of running on the scheduler's thread
//     regardless of how loaded the process already is.
//   - IT IS THE DOGFOOD. This template's headline promise is that background
//     work costs one handler class. The first real use of the queue is the
//     queue's own housekeeping, wired exactly the way `handlers/README.md`
//     tells a fork to wire theirs.
//
// MIDNIGHT, because deleting a large chunk of a live table is I/O a
// deployment would rather spend when nobody is waiting on it, and retention is
// measured in days — nothing about this is urgent to the minute.
//
// -----------------------------------------------------------------------------
// TWO GUARDS BEFORE THE ENQUEUE, AND NEITHER IS REDUNDANT
// -----------------------------------------------------------------------------
//
//   1. `purgeEnabled` — asked here so a disabled deployment never creates a
//      row at all. The handler asks again (see its `process`), because a purge
//      row can also arrive from an admin control or a rerun, and the setting
//      is a statement about deleting history rather than about scheduling it.
//   2. "is one already pending or running?" — a cheap indexed lookup that
//      keeps the log honest. The active-dedup unique index ALREADY guarantees
//      at most one active purge (this job type is global, so its dedup key is
//      constant), and `JobsService.enqueue` would quietly collapse a second
//      call onto the row already in flight. Without this check, a purge that
//      legitimately runs past midnight would produce a "queued" line every
//      night that did not queue anything. With it, the skip says what actually
//      happened — and a purge still running 24 hours later is a fact worth
//      seeing in a log.
//
// Registered in `JobsModule`'s providers; `ScheduleModule.forRoot()` in
// `app.module.ts` is what makes `@Cron` fire.
// =============================================================================

/**
 * The purge's queue priority.
 *
 * ⚠ ASCENDING IS MORE URGENT — the `Job` model's own comment and the claim's
 * `ORDER BY priority ASC, created_at ASC` both say so — so 100 is LOW
 * priority, not high. That is deliberate: housekeeping must never be claimed
 * ahead of a user-facing job. Every ordinary job takes the column default
 * (`0`) and therefore outranks this one; nothing in the queue is starved by a
 * purge, and a purge waits for a quiet moment by construction rather than by
 * being scheduled for one.
 */
const PURGE_PRIORITY = 100;

@Injectable()
export class JobHistoryPurgeTask {
  private readonly logger = new Logger(JobHistoryPurgeTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
    private readonly jobs: JobsService
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleCron(): Promise<void> {
    try {
      const policy = await this.systemSettings.getJobsPolicy();

      if (!policy.history.purgeEnabled) {
        this.logger.debug(
          'Job history purge is disabled (jobs.history.purgeEnabled); nothing queued'
        );

        return;
      }

      const active = await this.prisma.job.findFirst({
        where: { type: JOB_HISTORY_PURGE_TYPE, status: { in: ['pending', 'running'] } },
        select: { id: true, status: true },
      });

      if (active) {
        this.logger.warn(
          `A job history purge is already ${active.status} (job ${active.id}); ` +
            'skipping tonight rather than queueing a second one'
        );

        return;
      }

      const job = await this.jobs.enqueue({
        type: JOB_HISTORY_PURGE_TYPE,
        // `backfill` is the closest of the three reasons: this is scheduled
        // maintenance over existing rows, not a response to an upload and not
        // a human asking for something to be run again.
        reason: 'backfill',
        // Global — no subject. Both nulls are what makes the dedup key
        // constant for this type; see the handler's header.
        priority: PURGE_PRIORITY,
      });

      this.logger.log(
        `Queued job history purge ${job.id} (retention ${policy.history.retentionDays} day(s))`
      );
    } catch (error) {
      // SWALLOWED, like every other scheduled task here: a throw out of a
      // `@Cron` handler is an unhandled rejection, and tomorrow's tick would
      // have run anyway.
      this.logger.error(
        `Could not queue the job history purge: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
