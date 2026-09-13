// =============================================================================
// The nightly device-code cleanup scheduler (issue #353, epic #345)
// =============================================================================
//
// ⚠ THIS TASK DELETES NOTHING. It enqueues a job, and
// `device-auth/handlers/device-code-cleanup.handler.ts` does the work on a
// worker slot. See that handler's header for why, and
// `jobs/housekeeping.enqueue.ts` for the two guards in front of the enqueue.
//
// 2am, unchanged from before the conversion.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { enqueueHousekeepingJob } from '../../jobs/housekeeping.enqueue';
import { JobsService } from '../../jobs/jobs.service';
import { PrismaService } from '../../prisma/prisma.service';
import { DEVICE_CODE_CLEANUP_TYPE } from '../handlers/device-code-cleanup.handler';

@Injectable()
export class DeviceCodeCleanupTask {
  private readonly logger = new Logger(DeviceCodeCleanupTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async handleCleanup(): Promise<void> {
    await enqueueHousekeepingJob({
      jobs: this.jobs,
      prisma: this.prisma,
      logger: this.logger,
      type: DEVICE_CODE_CLEANUP_TYPE,
      what: 'device code cleanup',
    });
  }
}
