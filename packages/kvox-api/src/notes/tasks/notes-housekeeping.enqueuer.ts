import { Inject, Injectable, Logger } from '@nestjs/common';

import { KVOX_JOBS, type KvoxJobsPort } from '../../ports/index.js';
import { NOTES_HOUSEKEEPING_JOB_TYPE } from '../job-types.js';

// =============================================================================
// The note housekeeping enqueuer (issue #53, epic #45, docs/specs/notes.md §8.5; the
// package form of issue #495, epic #491)
// =============================================================================
//
// ⚠ THIS FILE ENQUEUES. IT DOES NOT WORK. That is the queue rule (AGENTS.md, "Every
// Long-Running Activity Is a Queue Job"): the sweep (expired preview rows, expired exports,
// stalled purges) lives in `handlers/notes-housekeeping.handler.ts`; this class only asks
// the job port to run it, and `notes-housekeeping.task.ts` is the ten-minute timer that
// calls it. A host without `@nestjs/schedule` (`schedules: false`) calls `enqueue()` from
// its own scheduler.
//
// It skips the tick when a previous sweep is still `pending` or `running`, which keeps a
// slow sweep from being queued behind itself six times an hour.
// =============================================================================

/** Queue priority of a housekeeping sweep: behind interactive work (the platform's own value). */
const HOUSEKEEPING_PRIORITY = 100;

/**
 * Queues the note housekeeping sweep.
 *
 * @extensionPoint
 * @stability experimental
 */
@Injectable()
export class NotesHousekeepingEnqueuer {
  private readonly logger = new Logger(NotesHousekeepingEnqueuer.name);

  constructor(@Inject(KVOX_JOBS) private readonly jobs: KvoxJobsPort) {}

  /**
   * Queues one sweep, unless one is already in flight. Never throws: "already queued"
   * and "queued" are equally healthy outcomes, and a failed enqueue is retried by the
   * next tick.
   *
   * @returns the queued job id, or `null` when nothing was queued.
   */
  async enqueue(): Promise<string | null> {
    try {
      const active = await this.jobs.findActive({ types: [NOTES_HOUSEKEEPING_JOB_TYPE] });

      if (active.length > 0) {
        this.logger.warn(
          `A note housekeeping job is already running or pending (job ${active[0].id}); ` +
            'skipping this tick rather than queueing a second one',
        );

        return null;
      }

      const job = await this.jobs.enqueue({
        type: NOTES_HOUSEKEEPING_JOB_TYPE,
        reason: 'backfill',
        payload: {},
        priority: HOUSEKEEPING_PRIORITY,
      });

      this.logger.log(`Queued note housekeeping job ${job.id}`);

      return job.id;
    } catch (error) {
      this.logger.error(
        `Could not queue note housekeeping: ${error instanceof Error ? error.message : String(error)}`,
      );

      return null;
    }
  }
}
