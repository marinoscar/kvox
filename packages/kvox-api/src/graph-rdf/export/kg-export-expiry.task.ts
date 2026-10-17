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

import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { KgExportExpiryEnqueuer } from './kg-export-expiry.enqueuer.js';

/**
 * The daily timer (03:41). A cron only enqueues; see {@link KgExportExpiryEnqueuer}.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class KgExportExpiryTask extends KgExportExpiryEnqueuer {
  /** Fires once a day and enqueues the sweep. */
  @Cron('41 3 * * *')
  async handleCron(): Promise<void> {
    await this.enqueue();
  }
}
