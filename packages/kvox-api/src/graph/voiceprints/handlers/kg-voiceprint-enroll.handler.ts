// =============================================================================
// kg.voiceprint_enroll (#825, epic #820; docs/specs/ontology.md §8)
// =============================================================================
//
// Learns what a just-named person sounds like. `kg.speaker_link` enqueues one
// per run, after its commit, for the (speaker, Person) pairs it linked, when the
// transcript's owner opted in to voiceprints.
//
//   profile       { maxRuntimeMs: 5 min, maxAttempts: 3 } — idempotent: the
//                 sample of one (Person, speaker) is replaced, never duplicated
//   node-eligible NO. No node executor ships the voiceprint model yet, so the
//                 type declares neither `nodeResultSchema` nor
//                 `persistNodeResult`. `process` is already split into a pure
//                 compute step (`VoiceprintAudioService`) and a persist step,
//                 so a node executor is a follow-up, not a rewrite.
//   AI            NO. No provider key, no network after the model download
//                 (which happens inside this job on first use); `usesAi` unset.
//   subject       transcript / transcriptId
//   payload       { transcriptId, links: [{ speakerId, entityId }] }
//
// ⚠ BIOMETRIC. Logs and audit rows carry ids and a duration, never a vector.
// =============================================================================

import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { KG_VOICEPRINT_ENROLL_JOB_TYPE } from '../../job-types.js';
import {
  KVOX_AUDIT,
  KVOX_JOBS,
  KVOX_PRISMA,
  KVOX_VOICEPRINTS,
  type KvoxAuditPort,
  type KvoxJob,
  type KvoxJobHandler,
  type KvoxJobProfile,
  type KvoxJobsPort,
  type KvoxVoiceprintsPort,
} from '../../../ports/index.js';
import type { KvoxGraphDb } from '../../data/graph-db.js';
import { GraphPreferencesService } from '../../preferences/graph-preferences.service.js';
import { VoiceprintAudioService, toVectorLiteral, type SpeakerVoice } from '../voiceprint-audio.service.js';

/** The audit action of a stored voiceprint. */
export const VOICEPRINT_ENROLLED_ACTION = 'graph.voiceprint_enrolled';

const payloadSchema = z.object({
  transcriptId: z.uuid(),
  links: z.array(z.object({ speakerId: z.uuid(), entityId: z.uuid() })).min(1).max(50),
});

export type VoiceprintEnrollPayload = z.infer<typeof payloadSchema>;

/** The job's payload, or `null` when it is unreadable. */
export function readVoiceprintEnrollPayload(payload: unknown): VoiceprintEnrollPayload | null {
  const parsed = payloadSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

@Injectable()
export class KgVoiceprintEnrollHandler implements KvoxJobHandler, OnModuleInit {
  private readonly logger = new Logger(KgVoiceprintEnrollHandler.name);

  readonly type = KG_VOICEPRINT_ENROLL_JOB_TYPE;

  readonly label = "Learn a person's voice";

  readonly profile: KvoxJobProfile = { maxRuntimeMs: 5 * 60_000, maxAttempts: 3 };

  constructor(
    @Inject(KVOX_JOBS) private readonly jobs: KvoxJobsPort,
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxGraphDb,
    @Inject(KVOX_VOICEPRINTS) private readonly voiceprints: KvoxVoiceprintsPort,
    @Inject(KVOX_AUDIT) private readonly auditPort: KvoxAuditPort,
    private readonly preferences: GraphPreferencesService,
    private readonly audio: VoiceprintAudioService,
  ) {}

  onModuleInit(): void {
    this.jobs.registerHandler(this);
  }

  async process(job: KvoxJob): Promise<void> {
    const input = readVoiceprintEnrollPayload(job.payload);
    if (!input) {
      this.logger.warn(`${this.type} job ${job.id} carries an unreadable payload; nothing to do`);
      return;
    }

    const transcript = await this.prisma.transcript.findFirst({
      where: { id: input.transcriptId, deletedAt: null },
      select: { ownerId: true },
    });
    if (!transcript) return;
    const ownerId = transcript.ownerId;

    // Re-checked here: the user may have opted out since the enqueue.
    if (!(await this.preferences.voiceprintsEnabled(ownerId))) return;

    // Only links that still hold: the naming may have changed since.
    const links = await this.liveLinks(ownerId, input.links);
    if (links.length === 0) return;

    // COMPUTE (pure: no writes).
    const result = await this.audio.computeSpeakerVoices({
      transcriptId: input.transcriptId,
      ownerId,
      speakerIds: [...new Set(links.map((l) => l.speakerId))],
    });
    if (result.skipped) {
      this.logger.log(`${this.type} ${input.transcriptId}: skipped (${result.skipped})`);
      return;
    }
    const bySpeaker = new Map(result.speakers.map((s) => [s.speakerId, s]));

    // PERSIST.
    let stored = 0;
    for (const link of links) {
      const voice = bySpeaker.get(link.speakerId);
      if (!voice) continue;
      await this.persist(ownerId, input.transcriptId, link, voice);
      stored += 1;
      try {
        await this.auditPort.record({
          actorUserId: ownerId,
          action: VOICEPRINT_ENROLLED_ACTION,
          targetType: 'kg_entity',
          targetId: link.entityId,
          meta: {
            entityId: link.entityId,
            transcriptId: input.transcriptId,
            speakerId: link.speakerId,
            speechMs: voice.speechMs,
          },
        });
      } catch (error) {
        this.logger.error(
          `${this.type}: could not record ${VOICEPRINT_ENROLLED_ACTION}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    this.logger.log(`${this.type} ${input.transcriptId}: stored ${stored} voiceprint(s)`);
  }

  /** The (speaker, Person) pairs whose IDENTIFIED_AS edge still exists and whose Person is live. */
  private async liveLinks(
    ownerId: string,
    links: VoiceprintEnrollPayload['links'],
  ): Promise<VoiceprintEnrollPayload['links']> {
    const live: VoiceprintEnrollPayload['links'] = [];
    for (const link of links) {
      const rows = await this.prisma.$queryRaw<Array<{ ok: number }>>`
        SELECT 1 AS ok
          FROM kg_relations r
          JOIN kg_entities e ON e.id = r.to_id
         WHERE r.owner_id = ${ownerId}::uuid
           AND r.type = 'IDENTIFIED_AS'
           AND r.from_speaker_id = ${link.speakerId}::uuid
           AND r.to_id = ${link.entityId}::uuid
           AND r.review_status IN ('accepted', 'edited')
           AND e.review_status IN ('accepted', 'edited')
           AND e.merged_into_id IS NULL
         LIMIT 1`;
      if (rows.length > 0) live.push(link);
    }
    return live;
  }

  private async persist(
    ownerId: string,
    transcriptId: string,
    link: { speakerId: string; entityId: string },
    voice: SpeakerVoice,
  ): Promise<void> {
    const vector = toVectorLiteral(voice.embedding);
    const keep = Math.max(1, this.voiceprints.maxSamplesPerPerson);
    await this.prisma.$transaction(async (tx) => {
      // One sample per (Person, speaker): a retry or a re-naming replaces it.
      await tx.$executeRaw`
        DELETE FROM kg_person_voiceprints
         WHERE owner_id = ${ownerId}::uuid AND entity_id = ${link.entityId}::uuid
           AND source_speaker_id = ${link.speakerId}::uuid`;
      await tx.$executeRaw`
        INSERT INTO kg_person_voiceprints
          (id, owner_id, entity_id, source_transcript_id, source_speaker_id, embedding, model_id, speech_ms)
        VALUES
          (${randomUUID()}::uuid, ${ownerId}::uuid, ${link.entityId}::uuid, ${transcriptId}::uuid,
           ${link.speakerId}::uuid, ${vector}::vector, ${this.voiceprints.modelId}, ${voice.speechMs}::int)`;
      // Keep the newest `keep` per Person.
      await tx.$executeRaw`
        DELETE FROM kg_person_voiceprints
         WHERE id IN (
           SELECT id FROM kg_person_voiceprints
            WHERE owner_id = ${ownerId}::uuid AND entity_id = ${link.entityId}::uuid
            ORDER BY created_at DESC, id DESC
           OFFSET ${keep}::int)`;
      // The person confirmed this voice: close a pending suggestion for the pair.
      await tx.$executeRaw`
        UPDATE kg_speaker_suggestions
           SET status = 'accepted', decided_at = now()
         WHERE owner_id = ${ownerId}::uuid AND speaker_id = ${link.speakerId}::uuid
           AND entity_id = ${link.entityId}::uuid AND status = 'pending'`;
    });
  }
}
