// =============================================================================
// `device-auth.code.cleanup` — expired device codes, as a queue job
// (issue #353, epic #345)
// =============================================================================
//
// The work is unchanged: `DeviceAuthService.cleanupExpiredCodes` deletes
// `device_codes` past their expiry, plus `expired` rows more than a day old.
// WHAT CHANGED IS THE EXECUTOR — until #353 the delete ran inline in a 2am
// `@Cron` that caught its own errors and logged them, which meant a failed
// cleanup was invisible in the admin job list, got no retry, and left rows an
// operator could only find by grepping.
//
// SERVER-ONLY BY DERIVATION: neither `nodeResultSchema` nor `persistNodeResult`
// (see `job-handler.interface.ts`), which is also the only correct answer for a
// job that is one `deleteMany` against this application's own database.
//
// NO PROFILE: one indexed delete is ordinary queue work, and it is idempotent,
// so the deployment-wide timeout and attempt budget are right for it. See
// `auth/handlers/token-cleanup.handler.ts` for the same argument at length.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job } from '@prisma/client';

import { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { DeviceAuthService } from '../device-auth.service';

/**
 * The handler key, and therefore the `Job.type` every device-code-cleanup row
 * carries. PERMANENT — rows outlive handlers. Exported so the scheduling task
 * asks about the same string it queues.
 */
export const DEVICE_CODE_CLEANUP_TYPE = 'device-auth.code.cleanup';

@Injectable()
export class DeviceCodeCleanupHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(DeviceCodeCleanupHandler.name);

  readonly type = DEVICE_CODE_CLEANUP_TYPE;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly deviceAuth: DeviceAuthService
  ) {}

  /** Self-registration — the only wiring a handler needs. */
  onModuleInit(): void {
    this.registry.register(this);
  }

  /**
   * Deletes expired device codes.
   *
   * THROWS TO FAIL. The old cron caught and logged; a handler must not, because
   * swallowing here would report a cleanup that did not happen as a `succeeded`
   * job — which is strictly worse than the log line it replaced.
   */
  async process(job: Job): Promise<void> {
    const count = await this.deviceAuth.cleanupExpiredCodes();

    this.logger.log(`Device code cleanup job ${job.id} removed ${count} record(s)`);
  }
}
