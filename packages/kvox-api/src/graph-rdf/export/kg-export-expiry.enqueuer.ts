// =============================================================================
// The graph export expiry cron (issue #386)
// =============================================================================
//
// ⚠ THIS FILE ENQUEUES. IT DOES NOT WORK (CLAUDE.md rule 1;
// the platform `cron-enqueue-only` conformance suite reads this body). Once a day it queues
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

import { Injectable, Logger, Inject } from '@nestjs/common';

import { KG_EXPORT_JOB_TYPE, KG_SUBJECT_EXPORT_SWEEP, subjectHousekeeping } from '../../graph/index.js';
import { KVOX_JOBS, type KvoxJobsPort } from '../../ports/index.js';

/**
 * KgExportExpiryEnqueuer: wiring the slice registers itself; a host configures it through `GraphRdfModule.forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class KgExportExpiryEnqueuer {
  private readonly logger = new Logger(KgExportExpiryEnqueuer.name);

  constructor(@Inject(KVOX_JOBS) private readonly jobs: KvoxJobsPort) {}

  /** Queues the sweep, unless one is already in flight. Never throws. */
  async enqueue(): Promise<void> {
    await subjectHousekeeping.enqueue({
      jobs: this.jobs,
      logger: this.logger,
      type: KG_EXPORT_JOB_TYPE,
      what: 'graph export expiry sweep',
      subjectType: KG_SUBJECT_EXPORT_SWEEP,
      payload: { mode: 'sweep' },
    });
  }
}
