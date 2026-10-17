import { Inject, Injectable, Logger } from '@nestjs/common';

import { KVOX_JOBS, type KvoxJobsPort } from '../../ports/index.js';
import { TRANSCRIPTS_HOUSEKEEPING_JOB_TYPE } from '../job-types.js';

// =============================================================================
// The housekeeping enqueue (issue #25, epic #19; split from the cron by #493)
// =============================================================================
//
// One call queues one global `transcripts.housekeeping` sweep, unless one is already
// pending or running. The `@Cron` timer (`transcripts-housekeeping.task.ts`) calls it
// every ten minutes; a host without a scheduler calls it on its own timer.
//
// The work itself is `handlers/transcripts-housekeeping.handler.ts`. This class
// enqueues. It never queries a table, touches storage or calls a provider.
// =============================================================================

/** Queue priority of a housekeeping sweep: behind interactive work (the platform's own value). */
const HOUSEKEEPING_PRIORITY = 100;

/**
 * Queues the transcript housekeeping sweep.
 *
 * @extensionPoint
 * @stability experimental
 */
@Injectable()
export class TranscriptsHousekeepingEnqueuer {
  private readonly logger = new Logger(TranscriptsHousekeepingEnqueuer.name);

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
      const active = await this.jobs.findActive({ types: [TRANSCRIPTS_HOUSEKEEPING_JOB_TYPE] });

      if (active.length > 0) {
        this.logger.warn(
          `A transcript housekeeping job is already running or pending (job ${active[0].id}); ` +
            'skipping this tick rather than queueing a second one',
        );

        return null;
      }

      // `backfill` is the closest reason: scheduled maintenance over existing rows,
      // not a response to an upload. GLOBAL: no subject, so the dedup key is constant
      // for the type and the queue itself guarantees single flight.
      const job = await this.jobs.enqueue({
        type: TRANSCRIPTS_HOUSEKEEPING_JOB_TYPE,
        reason: 'backfill',
        payload: {},
        priority: HOUSEKEEPING_PRIORITY,
      });

      this.logger.log(`Queued transcript housekeeping job ${job.id}`);

      return job.id;
    } catch (error) {
      this.logger.error(
        `Could not queue transcript housekeeping: ${error instanceof Error ? error.message : String(error)}`,
      );

      return null;
    }
  }
}
