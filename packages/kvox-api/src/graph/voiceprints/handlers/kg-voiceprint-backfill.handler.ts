// =============================================================================
// kg.voiceprint_backfill (#826, epic #820)
// =============================================================================
//
// Runs when a user turns speaker voiceprints ON: queues `kg.voiceprint_enroll` for speakers
// they had ALREADY linked to Persons, so the feature starts with the names they have given.
//
//   profile       { maxRuntimeMs: 5 min, maxAttempts: 3 }
//   node-eligible NO (like the other voiceprint jobs; no `nodeResultSchema`)
//   AI            NO
//   subject       user / ownerId
//   payload       { ownerId }
//
// `process` ONLY QUERIES AND ENQUEUES: the newest IDENTIFIED_AS links to live Persons, at most
// 3 source speakers per Person and 200 links in all, grouped per transcript into one
// enrol job each (the enrol handler re-checks consent and that each link still holds).
// =============================================================================

import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';

import { KG_SUBJECT_TRANSCRIPT, KG_VOICEPRINT_BACKFILL_JOB_TYPE, KG_VOICEPRINT_ENROLL_JOB_TYPE } from '../../job-types.js';
import {
  KVOX_JOBS,
  KVOX_PRISMA,
  type KvoxJob,
  type KvoxJobHandler,
  type KvoxJobProfile,
  type KvoxJobsPort,
} from '../../../ports/index.js';
import type { KvoxGraphDb } from '../../data/graph-db.js';
import { GraphPreferencesService } from '../../preferences/graph-preferences.service.js';

/** Most source speakers kept per Person. */
export const VOICEPRINT_BACKFILL_PER_PERSON = 3;
/** Most links queued in one backfill. */
export const VOICEPRINT_BACKFILL_MAX_LINKS = 200;
/** Most links in one enrol job (its payload limit). */
const ENROLL_LINKS_MAX = 50;

const payloadSchema = z.object({ ownerId: z.uuid() });

/** The job's payload, or `null` when it is unreadable. */
export function readVoiceprintBackfillPayload(payload: unknown): { ownerId: string } | null {
  const parsed = payloadSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

@Injectable()
export class KgVoiceprintBackfillHandler implements KvoxJobHandler, OnModuleInit {
  private readonly logger = new Logger(KgVoiceprintBackfillHandler.name);

  readonly type = KG_VOICEPRINT_BACKFILL_JOB_TYPE;

  readonly label = 'Learn voices from named speakers';

  readonly profile: KvoxJobProfile = { maxRuntimeMs: 5 * 60_000, maxAttempts: 3 };

  constructor(
    @Inject(KVOX_JOBS) private readonly jobs: KvoxJobsPort,
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxGraphDb,
    private readonly preferences: GraphPreferencesService,
  ) {}

  onModuleInit(): void {
    this.jobs.registerHandler(this);
  }

  async process(job: KvoxJob): Promise<void> {
    const input = readVoiceprintBackfillPayload(job.payload);
    if (!input) {
      this.logger.warn(`${this.type} job ${job.id} carries an unreadable payload; nothing to do`);
      return;
    }
    // Re-checked: the user may have opted out again since the enqueue.
    if (!(await this.preferences.voiceprintsEnabled(input.ownerId))) return;

    const rows = await this.prisma.$queryRaw<Array<{ transcript_id: string; speaker_id: string; entity_id: string }>>`
      SELECT transcript_id, speaker_id, entity_id FROM (
        SELECT s.transcript_id, r.from_speaker_id AS speaker_id, r.to_id AS entity_id, r.created_at,
               row_number() OVER (PARTITION BY r.to_id ORDER BY r.created_at DESC, r.id DESC) AS rn
          FROM kg_relations r
          JOIN kg_entities e ON e.id = r.to_id
          JOIN transcript_speakers s ON s.id = r.from_speaker_id
          JOIN transcripts t ON t.id = s.transcript_id
         WHERE r.owner_id = ${input.ownerId}::uuid
           AND r.type = 'IDENTIFIED_AS'
           AND r.review_status IN ('accepted', 'edited')
           AND e.owner_id = ${input.ownerId}::uuid
           AND e.type = 'Person'
           AND e.review_status IN ('accepted', 'edited')
           AND e.merged_into_id IS NULL
           AND t.owner_id = ${input.ownerId}::uuid
           AND t.deleted_at IS NULL
      ) ranked
       WHERE rn <= ${VOICEPRINT_BACKFILL_PER_PERSON}::int
       ORDER BY created_at DESC
       LIMIT ${VOICEPRINT_BACKFILL_MAX_LINKS}::int`;

    const byTranscript = new Map<string, Array<{ speakerId: string; entityId: string }>>();
    for (const row of rows) {
      const list = byTranscript.get(row.transcript_id) ?? [];
      list.push({ speakerId: row.speaker_id, entityId: row.entity_id });
      byTranscript.set(row.transcript_id, list);
    }

    let queued = 0;
    for (const [transcriptId, links] of byTranscript) {
      for (let i = 0; i < links.length; i += ENROLL_LINKS_MAX) {
        await this.jobs.enqueue({
          type: KG_VOICEPRINT_ENROLL_JOB_TYPE,
          reason: 'rerun',
          subjectType: KG_SUBJECT_TRANSCRIPT,
          subjectId: transcriptId,
          payload: { transcriptId, links: links.slice(i, i + ENROLL_LINKS_MAX) },
          skipDedup: true,
        });
        queued += 1;
      }
    }
    this.logger.log(`${this.type} ${input.ownerId}: ${rows.length} link(s) in ${queued} enrol job(s)`);
  }
}
