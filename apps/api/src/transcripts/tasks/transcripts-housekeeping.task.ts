// =============================================================================
// The transcript housekeeping cron (issue #25, epic #19, spec §1.5.8)
// =============================================================================
//
// ⚠ THIS FILE ENQUEUES. IT DOES NOT WORK. That is CLAUDE.md rule 1, and
// `test/jobs/cron-enqueue-only.spec.ts` reads the body of every `@Cron` method
// under `apps/api/src` and fails the build if one of them queries, updates,
// deletes, or touches a storage provider. The work lives in
// `handlers/transcripts-housekeeping.handler.ts`; this is the timer.
//
// TEN MINUTES, matching the three sweeps it sits beside (the database backup
// scheduler, the fleet sweep, the node secret sweep). Nothing here is urgent —
// a lost poll chain restarted ten minutes late is ten minutes late, not lost —
// and a coarse poll that RECOVERS a missed tick is worth more than a fine one
// that fires on time only while the process happens to be up.
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
import { TRANSCRIPTS_HOUSEKEEPING_JOB_TYPE } from '../job-types';

@Injectable()
export class TranscriptsHousekeepingTask {
  private readonly logger = new Logger(TranscriptsHousekeepingTask.name);

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
      type: TRANSCRIPTS_HOUSEKEEPING_JOB_TYPE,
      what: 'transcript housekeeping',
    });
  }
}
