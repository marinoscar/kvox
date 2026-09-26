// =============================================================================
// The graph export expiry cron (issue #386)
// =============================================================================
//
// ⚠ THIS FILE ENQUEUES. IT DOES NOT WORK (CLAUDE.md rule 1;
// `test/jobs/cron-enqueue-only.spec.ts` reads this body). Once a day it queues
// ONE `kg.export` job in sweep mode — `subjectType: 'kg_export_sweep'`,
// `subjectId: null`, payload `{ mode: 'sweep' }` — and the handler deletes up
// to 500 expired exports and their files. No new job type: the export's own
// handler owns the export's own cleanup. No new exemption either: a queue too
// wedged to run this sweep is a queue that was not rendering exports anyway.
//
// DAILY at 03:41 (process time — UTC in the containers): an export lives
// 7 days, so a file outliving its expiry by up to a day is late, not wrong — `GET /api/graph/exports(/:id)` already
// stops showing a row the moment `expires_at` passes.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { enqueueHousekeepingJob } from '../../jobs/housekeeping.enqueue';
import { JobsService } from '../../jobs/jobs.service';
import { PrismaService } from '../../prisma/prisma.service';
import { KG_EXPORT_JOB_TYPE, KG_SUBJECT_EXPORT_SWEEP } from '../job-types';

@Injectable()
export class KgExportExpiryTask {
  private readonly logger = new Logger(KgExportExpiryTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron('41 3 * * *')
  async handleCron(): Promise<void> {
    await enqueueHousekeepingJob({
      jobs: this.jobs,
      prisma: this.prisma,
      logger: this.logger,
      type: KG_EXPORT_JOB_TYPE,
      what: 'graph export expiry sweep',
      subjectType: KG_SUBJECT_EXPORT_SWEEP,
      payload: { mode: 'sweep' },
    });
  }
}
