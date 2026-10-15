import { Injectable } from '@nestjs/common';
import type { IdentityJobHandler, IdentityJobsPort } from '@marinoscar/platform-api/identity';
import type { Logger } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { enqueueHousekeepingJob, JobHandlerRegistry, JobsService } from '@marinoscar/platform-api/jobs';

/**
 * Identity's `IDENTITY_JOBS` over the platform job queue (`JobsService` and
 * `JobHandlerRegistry` from `@marinoscar/platform-api/jobs`, since #468).
 *
 * The two identity job types keep this app's type strings, because rows outlive
 * handlers and a renamed type would orphan the history:
 * `auth.token.cleanup` and `device-auth.code.cleanup`. Both are SERVER-ONLY
 * (they delete credential rows, a privilege a worker node must never hold), so
 * the handlers declare no `nodeResultSchema` / `persistNodeResult`, and the platform's
 * derived node eligibility treats them as such.
 *
 * The crons that enqueue them live in the platform and ONLY enqueue (root rule
 * 1): `enqueueHousekeepingJob` skips the tick when one is already pending or
 * running.
 */
@Injectable()
export class IdentityJobsAdapter implements IdentityJobsPort {
  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
  ) {}

  async enqueueHousekeepingJob(options: {
    type: string;
    what: string;
    logger: Logger;
  }): Promise<void> {
    await enqueueHousekeepingJob({
      jobs: this.jobs,
      prisma: this.prisma,
      logger: options.logger,
      type: options.type,
      what: options.what,
    });
  }

  registerHandler(handler: IdentityJobHandler): void {
    this.registry.register(handler);
  }
}
