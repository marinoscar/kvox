// =============================================================================
// The nightly token-cleanup scheduler (issue #353, epic #345)
// =============================================================================
//
// ⚠ THIS TASK DELETES NOTHING. It enqueues a job, and
// `auth/handlers/token-cleanup.handler.ts` does the work on a worker slot —
// the shape `jobs/tasks/job-history-purge.task.ts` established and that #353
// made true of every maintenance cron in this application. The handler's header
// carries the argument for why; `jobs/housekeeping.enqueue.ts` carries the
// argument for the two guards in front of the enqueue.
//
// 3am, unchanged from before the conversion: expired tokens are already
// expired, so nothing about this is urgent to the minute, and deletes are I/O a
// deployment would rather spend when nobody is waiting on it.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { enqueueHousekeepingJob } from '../../jobs/housekeeping.enqueue';
import { JobsService } from '../../jobs/jobs.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AUTH_TOKEN_CLEANUP_TYPE } from '../handlers/token-cleanup.handler';

@Injectable()
export class TokenCleanupTask {
  private readonly logger = new Logger(TokenCleanupTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async handleCron(): Promise<void> {
    await enqueueHousekeepingJob({
      jobs: this.jobs,
      prisma: this.prisma,
      logger: this.logger,
      type: AUTH_TOKEN_CLEANUP_TYPE,
      what: 'token cleanup',
    });
  }
}
