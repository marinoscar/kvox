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

import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { z } from 'zod';

import { KG_EMBED_JOB_TYPE, KG_SPEAKER_LINK_JOB_TYPE, KG_SUBJECT_USER } from '../job-types.js';
import { SpeakerLinkReconciler, type SpeakerLinkInput } from '../speaker-link/speaker-link.reconciler.js';
import {
  KVOX_AUDIT,
  KVOX_JOBS,
  KVOX_PRISMA,
  type KvoxAuditPort,
  type KvoxJob,
  type KvoxJobHandler,
  type KvoxJobProfile,
  type KvoxJobsPort,
} from '../../ports/index.js';
import type { KvoxGraphDb } from '../data/graph-db.js';

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
export class KgSpeakerLinkHandler implements KvoxJobHandler, OnModuleInit {
  private readonly logger = new Logger(KgSpeakerLinkHandler.name);

  readonly type = KG_SPEAKER_LINK_JOB_TYPE;

  readonly label = 'Link named speakers to people';

  readonly profile: KvoxJobProfile = { maxRuntimeMs: 2 * 60_000, maxAttempts: 3 };

  constructor(
    @Inject(KVOX_JOBS) private readonly jobs: KvoxJobsPort,
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxGraphDb,
    private readonly reconciler: SpeakerLinkReconciler,
    @Inject(KVOX_AUDIT) private readonly auditPort: KvoxAuditPort,
  ) {}

  onModuleInit(): void {
    this.jobs.registerHandler(this);
  }

  async process(job: KvoxJob): Promise<void> {
    const input = readSpeakerLinkPayload(job.payload);
    if (!input) {
      this.logger.warn(`${KG_SPEAKER_LINK_JOB_TYPE} job ${job.id} carries an unreadable payload; nothing to do`);
      return;
    }

    const summary = await this.prisma.$transaction((tx) => this.reconciler.reconcile(tx, input), {
      timeout: 60_000,
    });

    for (const event of summary.audit) {
      try {
        await this.auditPort.record(event);
      } catch (error) {
        // The links committed; a lost audit row is logged loudly, never a reason to run again.
        this.logger.error(
          `${KG_SPEAKER_LINK_JOB_TYPE}: could not record ${event.action}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

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
    if (!this.jobs.isRegistered(KG_EMBED_JOB_TYPE)) return;
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
