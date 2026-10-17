// =============================================================================
// Housekeeping enqueue for a job that has a subject
// =============================================================================
//
// The platform's `enqueueHousekeepingJob` (`@marinoscar/platform-api/jobs`)
// queues a GLOBAL job: it takes no subject and no payload, and its "already in
// flight?" check looks at the type alone. Two graph crons need more:
//
//   - `kg.migrate` queues one job per owner (`user`/<ownerId>), so the check and
//     the dedup key are scoped to (type, subjectType, subjectId) and the payload
//     carries the target version.
//   - `kg.export`'s expiry sweep shares its type with the render jobs, so the
//     check is scoped to the subject TYPE (`kg_export_sweep`, null id) and a
//     pending render never suppresses the sweep; the payload is `{ mode: 'sweep' }`.
//
// It is the former in-repo helper's subject handling, kept as a single function with
// the same shape: look for an active job, enqueue at housekeeping priority as a
// system job, never throw. It is an object with an `enqueue`
// method so a `@Cron` body reads `.enqueue(` and the cron-enqueue-only suite
// recognises the body as queueing its work.
//
// =============================================================================

import type { Logger } from '@nestjs/common';

import type { KvoxJobsPort } from '../ports/index.js';

/** Queue priority of a housekeeping sweep: behind interactive work (the platform's own value). */
const HOUSEKEEPING_PRIORITY = 100;

/**
 * The job a housekeeping enqueue queued.
 *
 * @stability experimental
 */
export interface HousekeepingJobRef {
  /** The queued job's id. */
  id: string;
}

/**
 * What `subjectHousekeeping.enqueue` needs.
 *
 * @stability experimental
 */
export interface SubjectHousekeepingEnqueueOptions {
  /** The host's job port. */
  jobs: KvoxJobsPort;
  /** The caller's own logger, so the line is attributed to the task. */
  logger: Logger;
  /** The `KvoxJobHandler.type` to queue. */
  type: string;
  /** A human phrase for the log line. Lower case. */
  what: string;
  /**
   * The subject. TYPE only scopes the in-flight check and the dedup key to a
   * global sweep; TYPE and ID scope them to one subject.
   */
  subjectType: string;
  /** Which subject, or absent for a sweep. */
  subjectId?: string;
  /** Handler input. Identifiers only. */
  payload?: Record<string, unknown>;
}

/**
 * The subject-scoped housekeeping enqueue.
 *
 * @stability experimental
 */
export const subjectHousekeeping = {
  /** Queues one housekeeping job for the subject unless one is already pending or running. Never throws. */
  async enqueue(options: SubjectHousekeepingEnqueueOptions): Promise<HousekeepingJobRef | null> {
    const { jobs, logger, type, what, subjectType, subjectId, payload } = options;
    try {
      const active = (await jobs.findActive({ types: [type] })).find(
        (job) => job.subjectType === subjectType && job.subjectId === (subjectId ?? null),
      );
      if (active) {
        logger.warn(
          `A ${what} job is already pending or running (job ${active.id}); skipping this ` +
            'tick rather than queueing a second one',
        );
        return null;
      }

      const job = await jobs.enqueue({
        type,
        reason: 'backfill',
        subjectType,
        ...(subjectId !== undefined ? { subjectId } : {}),
        payload: payload ?? {},
        priority: HOUSEKEEPING_PRIORITY,
      });
      logger.log(`Queued ${what} job ${job.id}`);
      return job;
    } catch (error) {
      logger.error(`Could not queue the ${what} job: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  },
};
