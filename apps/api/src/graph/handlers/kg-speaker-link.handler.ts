// =============================================================================
// kg.speaker_link (#356, epic #344; docs/specs/ontology.md §8, §11)
// =============================================================================
//
// The speaker-naming write into the transcript owner's graph. Thin on purpose:
// `SpeakerLinkReconciler` holds the algorithm and runs on the transaction this
// handler opens; afterwards, outside it, `kg.embed` is enqueued for any Person
// the run created (guarded on the registry, as #355 does).
//
//   profile      { maxRuntimeMs: 2 min, maxAttempts: 3 } — retry-safe because
//                the reconcile is idempotent under its advisory lock
//   node-eligible NO. It declares no `nodeResultSchema`/`persistNodeResult`:
//                it reads several tables mid-computation and writes as it goes
//                (CLAUDE.md rule 2's stated exception)
//   throttle     none — no AI call
//   subject      transcript / transcriptId
//   payload      { transcriptId: uuid, actorUserId: uuid }
//
// ⚠ Logs carry ids and counts only, never a name.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job } from '@prisma/client';
import { z } from 'zod';

import type { JobExecutionProfile } from '../../jobs/job-execution-profile';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { JobsService } from '../../jobs/jobs.service';
import { PrismaService } from '../../prisma/prisma.service';
import { KG_EMBED_JOB_TYPE, KG_SPEAKER_LINK_JOB_TYPE, KG_SUBJECT_USER } from '../job-types';
import { SpeakerLinkReconciler, type SpeakerLinkInput } from '../speaker-link/speaker-link.reconciler';

const payloadSchema = z.object({
  transcriptId: z.uuid(),
  actorUserId: z.uuid(),
});

/** The job's payload, or `null` when it is unreadable. */
export function readSpeakerLinkPayload(payload: unknown): SpeakerLinkInput | null {
  const parsed = payloadSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

@Injectable()
export class KgSpeakerLinkHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(KgSpeakerLinkHandler.name);

  readonly type = KG_SPEAKER_LINK_JOB_TYPE;

  readonly profile: JobExecutionProfile = { maxRuntimeMs: 2 * 60_000, maxAttempts: 3 };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly reconciler: SpeakerLinkReconciler,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const input = readSpeakerLinkPayload(job.payload);
    if (!input) {
      this.logger.warn(`${KG_SPEAKER_LINK_JOB_TYPE} job ${job.id} carries an unreadable payload; nothing to do`);
      return;
    }

    const summary = await this.prisma.$transaction((tx) => this.reconciler.reconcile(tx, input), {
      timeout: 60_000,
    });

    if (summary.skipped) {
      this.logger.log(`${KG_SPEAKER_LINK_JOB_TYPE} ${input.transcriptId}: skipped (${summary.skipped})`);
      return;
    }

    this.logger.log(
      `${KG_SPEAKER_LINK_JOB_TYPE} ${input.transcriptId}: linked ${summary.linked}, ` +
        `created ${summary.created}, unlinked ${summary.unlinked}`,
    );

    if (summary.ownerId && summary.createdPersonIds.length > 0) {
      await this.enqueueEmbed(summary.ownerId, summary.createdPersonIds);
    }
  }

  /** `kg.embed` for the Persons this run created, only while its handler is registered. */
  private async enqueueEmbed(ownerId: string, ids: string[]): Promise<void> {
    if (!this.registry.get(KG_EMBED_JOB_TYPE)) return;
    try {
      await this.jobs.enqueue({
        type: KG_EMBED_JOB_TYPE,
        reason: 'rerun',
        subjectType: KG_SUBJECT_USER,
        subjectId: ownerId,
        skipDedup: true,
        payload: { userId: ownerId, subjectKind: 'entity', ids },
      });
    } catch (err) {
      // The link has committed; a failed follow-up is logged, never a job failure.
      this.logger.warn(
        `${KG_SPEAKER_LINK_JOB_TYPE}: kg.embed enqueue for ${ids.length} person(s) failed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
