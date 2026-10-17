import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { NotesHousekeepingEnqueuer } from './notes-housekeeping.enqueuer.js';

// =============================================================================
// The note housekeeping cron (issue #53, epic #45, docs/specs/notes.md §8.5)
// =============================================================================
//
// TEN MINUTES, matching the sweeps it sits beside. Nothing here is urgent - a preview row
// that outlives its TTL by ten minutes is ten minutes late, not wrong - and a coarse poll
// that RECOVERS a missed tick is worth more than a fine one that fires on time only while the
// process happens to be up.
//
// ⚠ IT DECIDES NOTHING AND WORKS NOTHING: the body asks the enqueuer to queue one sweep
// (the `cron-enqueue-only` conformance suite reads every `@Cron` body). The file is loaded
// only when `schedules` is not false, because `@nestjs/schedule` registers its metadata at
// import and a host without `ScheduleModule` must not load it.
// =============================================================================

/**
 * The ten-minute timer.
 *
 * @stability experimental
 */
@Injectable()
export class NotesHousekeepingTask extends NotesHousekeepingEnqueuer {
  /** Fires every ten minutes and enqueues the sweep. */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async handleCron(): Promise<void> {
    await this.enqueue();
  }
}
