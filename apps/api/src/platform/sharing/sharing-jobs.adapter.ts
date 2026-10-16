import { Injectable } from '@nestjs/common';
import {
  enqueueHousekeepingJob,
  JobHandlerRegistry,
  JobsService,
  type JobHandler,
} from '@marinoscar/platform-api/jobs';
import type { SharingJobHandler, SharingJobsPort } from '@marinoscar/platform-api/sharing';

import { PrismaService } from '../../prisma/prisma.service';

/**
 * The sharing slice's `SHARING_JOBS` port over the platform job queue (issue #485).
 *
 * The slice has one job type, `sharing.grants.prune` (revoked, expired and
 * dangling grants past the retention window). It is SERVER-ONLY (it declares no
 * `nodeResultSchema`: it reads every resource type's `loadOwners` mid-computation),
 * and its daily cron only enqueues (`enqueueHousekeepingJob`, root rule 1).
 */
@Injectable()
export class SharingJobsAdapter implements SharingJobsPort {
  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
  ) {}

  registerHandler(handler: SharingJobHandler): void {
    this.registry.register(handler as unknown as JobHandler);
  }

  async enqueueHousekeepingJob(options: {
    type: string;
    what: string;
    logger: { log(message: string): void; warn(message: string): void };
  }): Promise<void> {
    await enqueueHousekeepingJob({
      jobs: this.jobs,
      prisma: this.prisma,
      logger: options.logger as never,
      type: options.type,
      what: options.what,
    });
  }
}
