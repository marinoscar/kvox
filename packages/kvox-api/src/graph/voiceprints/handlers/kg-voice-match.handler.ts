// =============================================================================
// kg.voice_match (#825, epic #820; docs/specs/ontology.md §8)
// =============================================================================
//
// Suggests a name for each still-unnamed speaker of a new transcript by comparing
// its voice with the voiceprints of people the owner already named. A suggestion
// is a row in `kg_speaker_suggestions`; it NEVER names a speaker or touches the
// graph: a person accepts it (which is the ordinary naming path).
//
//   profile       { maxRuntimeMs: 10 min, maxAttempts: 3 }
//   node-eligible NO. No node executor ships the voiceprint model yet, so the
//                 type declares neither `nodeResultSchema` nor
//                 `persistNodeResult`. `process` is split into the pure compute
//                 step (`VoiceprintAudioService`) and a persist step, so adding
//                 a node executor later is a follow-up, not a rewrite.
//   AI            NO. No key, no network after the one-time model download.
//   subject       transcript / transcriptId
//   payload       { transcriptId }
//
// ⚠ BIOMETRIC. Logs carry ids and counts, never a vector or a score table.
// =============================================================================

import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { KG_VOICE_MATCH_JOB_TYPE } from '../../job-types.js';
import {
  KVOX_JOBS,
  KVOX_PRISMA,
  KVOX_VOICEPRINTS,
  type KvoxJob,
  type KvoxJobHandler,
  type KvoxJobProfile,
  type KvoxJobsPort,
  type KvoxVoiceprintsPort,
} from '../../../ports/index.js';
import type { KvoxGraphDb } from '../../data/graph-db.js';
import { GraphPreferencesService } from '../../preferences/graph-preferences.service.js';
import { effectiveSpeakerNames } from '../../speaker-link/speaker-link.reconciler.js';
import { VoiceprintAudioService, toVectorLiteral } from '../voiceprint-audio.service.js';

const payloadSchema = z.object({ transcriptId: z.uuid() });

/** The job's payload, or `null` when it is unreadable. */
export function readVoiceMatchPayload(payload: unknown): { transcriptId: string } | null {
  const parsed = payloadSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

/** How many nearest people one speaker is compared against. */
const CANDIDATE_LIMIT = 5;

@Injectable()
export class KgVoiceMatchHandler implements KvoxJobHandler, OnModuleInit {
  private readonly logger = new Logger(KgVoiceMatchHandler.name);

  readonly type = KG_VOICE_MATCH_JOB_TYPE;

  readonly label = 'Suggest speaker names from voices';

  readonly profile: KvoxJobProfile = { maxRuntimeMs: 10 * 60_000, maxAttempts: 3 };

  constructor(
    @Inject(KVOX_JOBS) private readonly jobs: KvoxJobsPort,
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxGraphDb,
    @Inject(KVOX_VOICEPRINTS) private readonly voiceprints: KvoxVoiceprintsPort,
    private readonly preferences: GraphPreferencesService,
    private readonly audio: VoiceprintAudioService,
  ) {}

  onModuleInit(): void {
    this.jobs.registerHandler(this);
  }

  async process(job: KvoxJob): Promise<void> {
    const input = readVoiceMatchPayload(job.payload);
    if (!input) {
      this.logger.warn(`${this.type} job ${job.id} carries an unreadable payload; nothing to do`);
      return;
    }

    const transcript = await this.prisma.transcript.findFirst({
      where: { id: input.transcriptId, deletedAt: null },
      select: { ownerId: true, speakerIdentities: true },
    });
    if (!transcript) return;
    const ownerId = transcript.ownerId;
    if (!(await this.preferences.voiceprintsEnabled(ownerId))) return;

    // Placeholder speakers only: the effective-name map lists the NAMED ones.
    const speakers = (await this.prisma.transcriptSpeaker.findMany({
      where: { transcriptId: input.transcriptId },
      select: { id: true, label: true, displayName: true },
    })) as Array<{ id: string; label: string | null; displayName: string }>;
    const named = effectiveSpeakerNames(speakers, transcript.speakerIdentities);
    const unnamed = speakers.filter((s) => !named.has(s.id)).map((s) => s.id);
    if (unnamed.length === 0) return;

    if (!(await this.hasVoiceprints(ownerId))) return;

    // COMPUTE (pure).
    const result = await this.audio.computeSpeakerVoices({ transcriptId: input.transcriptId, ownerId, speakerIds: unnamed });
    if (result.skipped) {
      this.logger.log(`${this.type} ${input.transcriptId}: skipped (${result.skipped})`);
      return;
    }

    // People already linked to a speaker of this transcript cannot be a second speaker here.
    const taken = await this.linkedPeople(ownerId, speakers.map((s) => s.id));

    // PERSIST.
    let suggested = 0;
    for (const voice of result.speakers) {
      const candidates = await this.nearest(ownerId, voice.embedding);
      const decision = this.voiceprints.decide(candidates.filter((c) => !taken.has(c.entityId)));
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          DELETE FROM kg_speaker_suggestions
           WHERE owner_id = ${ownerId}::uuid AND speaker_id = ${voice.speakerId}::uuid AND status = 'pending'`;
        if (!decision) return;
        // A row for the pair that is no longer pending (dismissed, accepted) is respected.
        await tx.$executeRaw`
          INSERT INTO kg_speaker_suggestions
            (id, owner_id, speaker_id, transcript_id, entity_id, score, margin, model_id, status)
          VALUES
            (${randomUUID()}::uuid, ${ownerId}::uuid, ${voice.speakerId}::uuid, ${input.transcriptId}::uuid,
             ${decision.entityId}::uuid, ${decision.score}::float8, ${decision.margin}::float8,
             ${this.voiceprints.modelId}, 'pending')
          ON CONFLICT (speaker_id, entity_id) DO NOTHING`;
      });
      if (decision) suggested += 1;
    }
    this.logger.log(`${this.type} ${input.transcriptId}: ${suggested} suggestion(s) for ${result.speakers.length} speaker(s)`);
  }

  private async hasVoiceprints(ownerId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ ok: number }>>`
      SELECT 1 AS ok FROM kg_person_voiceprints
       WHERE owner_id = ${ownerId}::uuid AND model_id = ${this.voiceprints.modelId} LIMIT 1`;
    return rows.length > 0;
  }

  private async linkedPeople(ownerId: string, speakerIds: string[]): Promise<Set<string>> {
    if (speakerIds.length === 0) return new Set();
    const rows = await this.prisma.$queryRaw<Array<{ entity_id: string }>>`
      SELECT r.to_id::text AS entity_id
        FROM kg_relations r
       WHERE r.owner_id = ${ownerId}::uuid
         AND r.type = 'IDENTIFIED_AS'
         AND r.review_status IN ('accepted', 'edited')
         AND r.from_speaker_id = ANY(${speakerIds}::uuid[])`;
    return new Set(rows.map((r) => r.entity_id));
  }

  /** The live people nearest a voice, best of their voiceprints, highest score first. */
  private async nearest(ownerId: string, embedding: number[]): Promise<Array<{ entityId: string; score: number }>> {
    const vector = toVectorLiteral(embedding);
    const rows = await this.prisma.$queryRaw<Array<{ entity_id: string; score: number }>>`
      SELECT v.entity_id::text AS entity_id,
             MAX(1 - (v.embedding <=> ${vector}::vector))::double precision AS score
        FROM kg_person_voiceprints v
        JOIN kg_entities e ON e.id = v.entity_id
       WHERE v.owner_id = ${ownerId}::uuid
         AND v.model_id = ${this.voiceprints.modelId}
         AND e.type = 'Person'
         AND e.review_status IN ('accepted', 'edited')
         AND e.merged_into_id IS NULL
       GROUP BY v.entity_id
       ORDER BY score DESC
       LIMIT ${CANDIDATE_LIMIT}::int`;
    return rows.map((r) => ({ entityId: r.entity_id, score: Number(r.score) }));
  }
}
