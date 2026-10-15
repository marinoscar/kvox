// =============================================================================
// Housekeeping enqueue for a job that has a subject
// =============================================================================
//
// PLATFORM-ADOPTION-SHIM(#468)
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
// system job (`orgId: null`), never throw. It is an object with an `enqueue`
// method so a `@Cron` body reads `.enqueue(` and the cron-enqueue-only suite
// recognises the body as queueing its work.
//
// Removed when the package helper accepts a subject and a payload (see
// docs/platform-adoption/local-exceptions.md).
// =============================================================================

import type { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { HOUSEKEEPING_PRIORITY, type Job, type JobsService } from '@marinoscar/platform-api/jobs';

import type { PrismaService } from '../prisma/prisma.service';

export interface SubjectHousekeepingEnqueueOptions {
  jobs: JobsService;
  prisma: PrismaService;
  /** The caller's own logger, so the line is attributed to the task. */
  logger: Logger;
  /** The `JobHandler.type` to queue. */
  type: string;
  /** A human phrase for the log line. Lower case. */
  what: string;
  /**
   * The subject. TYPE only scopes the in-flight check and the dedup key to a
   * global sweep; TYPE and ID scope them to one subject.
   */
  subjectType: string;
  subjectId?: string;
  /** Handler input. Identifiers only. */
  payload?: Prisma.InputJsonValue;
}

export const subjectHousekeeping = {
  /** Queues one housekeeping job for the subject unless one is already pending or running. Never throws. */
  async enqueue(options: SubjectHousekeepingEnqueueOptions): Promise<Job | null> {
    const { jobs, prisma, logger, type, what, subjectType, subjectId, payload } = options;
    try {
      const active = await prisma.job.findFirst({
        where: { type, status: { in: ['pending', 'running'] }, subjectType, subjectId: subjectId ?? null },
        select: { id: true, status: true },
      });
      if (active) {
        logger.warn(
          `A ${what} job is already ${active.status} (job ${active.id}); skipping this ` +
            'tick rather than queueing a second one',
        );
        return null;
      }

      const job = await jobs.enqueue({
        type,
        reason: 'backfill',
        subjectType,
        subjectId: subjectId ?? null,
        ...(payload !== undefined ? { payload } : {}),
        priority: HOUSEKEEPING_PRIORITY,
        orgId: null,
      });
      logger.log(`Queued ${what} job ${job.id}`);
      return job;
    } catch (error) {
      logger.error(`Could not queue the ${what} job: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  },
};
