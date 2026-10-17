// =============================================================================
// The transcript housekeeping cron (issue #25, epic #19, spec §1.5.8)
// =============================================================================
//
// ⚠ THIS FILE ENQUEUES. IT DOES NOT WORK. That is the queue rule 1, and the
// `cron-enqueue-only` conformance suite reads the body of every `@Cron` method and
// fails the build if one of them queries, updates, deletes, or touches a storage
// provider. The work lives in
// `handlers/transcripts-housekeeping.handler.ts`; this is the timer.
//
// TEN MINUTES, matching the three sweeps it sits beside (the database backup
// scheduler, the fleet sweep, the node secret sweep). Nothing here is urgent —
// a lost poll chain restarted ten minutes late is ten minutes late, not lost —
// and a coarse poll that RECOVERS a missed tick is worth more than a fine one
// that fires on time only while the process happens to be up.
//
// `enqueue()` is the web edition's `enqueueHousekeepingJob` over the jobs port: it
// skips the tick when a previous sweep is still `pending` or `running`, which is
// what keeps a slow sweep from being queued behind itself six times an hour.
//
// THE CRON IS OPTIONAL (`TranscriptsModule.forRoot({ schedules })`). With
// `schedules: false` this module registers no `@nestjs/schedule` task, and a host
// without `ScheduleModule` (Desktop) calls `TranscriptsHousekeepingEnqueuer.enqueue()`
// on its own timer. The `@Cron` decorator lives only in this file, which the module
// loads only when schedules are on, because `@nestjs/schedule` registers its
// metadata at import.
// =============================================================================

import { Cron, CronExpression } from '@nestjs/schedule';

import { Injectable } from '@nestjs/common';
import { TranscriptsHousekeepingEnqueuer } from './transcripts-housekeeping.enqueuer.js';

/**
 * The ten-minute timer. Decides nothing and works nothing: it asks the enqueuer to
 * queue one sweep.
 *
 * @stability experimental
 */
@Injectable()
export class TranscriptsHousekeepingTask extends TranscriptsHousekeepingEnqueuer {
  /** Fires every ten minutes and enqueues the sweep. */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async handleCron(): Promise<void> {
    await this.enqueue();
  }
}
