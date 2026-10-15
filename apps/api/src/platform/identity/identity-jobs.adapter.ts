import { Injectable } from '@nestjs/common';
import type { IdentityJobHandler, IdentityJobsPort } from '@marinoscar/platform-api/identity';
import type { Logger } from '@nestjs/common';

import { enqueueHousekeepingJob } from '../../jobs/housekeeping.enqueue';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { JobsService } from '../../jobs/jobs.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Identity's `IDENTITY_JOBS` over this app's CURRENT job queue
 * (PLATFORM-ADOPTION-SHIM(#470): #470 moves the queue into the platform and
 * changes only the binding in `identity-host.module.ts`).
 *
 * The two identity job types keep this app's type strings, because rows outlive
 * handlers and a renamed type would orphan the history:
 * `auth.token.cleanup` and `device-auth.code.cleanup`. Both are SERVER-ONLY
 * (they delete credential rows, a privilege a worker node must never hold), so
 * the handlers declare no `nodeResultSchema` / `persistNodeResult`, and this app's
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
