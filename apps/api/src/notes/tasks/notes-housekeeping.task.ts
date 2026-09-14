// =============================================================================
// The note housekeeping cron (issue #53, epic #45, docs/specs/notes.md §8.5)
// =============================================================================
//
// ⚠ THIS FILE ENQUEUES. IT DOES NOT WORK. That is CLAUDE.md rule 1, and
// `test/jobs/cron-enqueue-only.spec.ts` reads the body of every `@Cron` method
// under `apps/api/src` and fails the build if one of them queries, updates,
// deletes, or touches a storage provider. The work lives in
// `handlers/notes-housekeeping.handler.ts`; this is the timer.
//
// ⚠ AND IT NEEDS NO NEW EXEMPTION from that test. The three exemptions on its
// list are all cases where the work must not depend on the queue — the lease
// reaper (recovery that depends on the thing it recovers is not recovery), the
// temp-file janitor (this process's own disk) and the node secret sweep (a
// wedged queue must not leak live credentials). Nothing about expiring a
// preview row, an export file or a stalled purge belongs in that company: a
// queue too wedged to run this sweep is a queue whose stalled purges were not
// going to run either.
//
// TEN MINUTES, matching the four sweeps it sits beside (transcript
// housekeeping, the database backup scheduler, the fleet sweep, the node secret
// sweep). Nothing here is urgent — a preview row that outlives its TTL by ten
// minutes is ten minutes late, not wrong — and a coarse poll that RECOVERS a
// missed tick is worth more than a fine one that fires on time only while the
// process happens to be up.
//
// `enqueueHousekeepingJob` is the shared helper #353 introduced so that "the
// cron decides whether work is due and enqueues it" costs six lines rather than
// sixty. It also skips the tick when a previous sweep is still `pending` or
// `running`, which is what keeps a slow sweep from being queued behind itself
// six times an hour.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { enqueueHousekeepingJob } from '../../jobs/housekeeping.enqueue';
import { JobsService } from '../../jobs/jobs.service';
import { PrismaService } from '../../prisma/prisma.service';
import { NOTES_HOUSEKEEPING_JOB_TYPE } from '../job-types';

@Injectable()
export class NotesHousekeepingTask {
  private readonly logger = new Logger(NotesHousekeepingTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async handleCron(): Promise<void> {
    await enqueueHousekeepingJob({
      jobs: this.jobs,
      prisma: this.prisma,
      logger: this.logger,
      type: NOTES_HOUSEKEEPING_JOB_TYPE,
      what: 'note housekeeping',
    });
  }
}
