// =============================================================================
// VoiceprintReadyListener (#825, epic #820)
// =============================================================================
//
// "A transcript became readable" -> `kg.voice_match`. It ONLY ENQUEUES (root rule
// 1: an `@OnEvent` body never downloads, decodes or embeds), and only when the
// owner opted in, the voiceprint port can run, the owner has at least one
// voiceprint and the handler is registered. Contained: a failure is logged and
// swallowed; a transcript becoming ready must never depend on this.
// =============================================================================

import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { TRANSCRIPT_READY_BUS_EVENT, type TranscriptReadyBusEvent } from '../../transcripts/index.js';
import { KG_SUBJECT_TRANSCRIPT, KG_VOICE_MATCH_JOB_TYPE } from '../job-types.js';
import {
  KVOX_EVENTS,
  KVOX_JOBS,
  KVOX_PRISMA,
  KVOX_VOICEPRINTS,
  type KvoxEventsPort,
  type KvoxJobsPort,
  type KvoxVoiceprintsPort,
} from '../../ports/index.js';
import type { KvoxGraphDb } from '../data/graph-db.js';
import { GraphPreferencesService } from '../preferences/graph-preferences.service.js';

@Injectable()
export class VoiceprintReadyListener implements OnModuleInit {
  private readonly logger = new Logger(VoiceprintReadyListener.name);

  constructor(
    @Inject(KVOX_JOBS) private readonly jobs: KvoxJobsPort,
    @Inject(KVOX_EVENTS) private readonly events: KvoxEventsPort,
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxGraphDb,
    @Inject(KVOX_VOICEPRINTS) private readonly voiceprints: KvoxVoiceprintsPort,
    private readonly preferences: GraphPreferencesService,
  ) {}

  onModuleInit(): void {
    this.events.subscribe(TRANSCRIPT_READY_BUS_EVENT, (payload) => this.handleReady(payload as TranscriptReadyBusEvent));
  }

  async handleReady(event: TranscriptReadyBusEvent): Promise<void> {
    try {
      if (!this.jobs.isRegistered(KG_VOICE_MATCH_JOB_TYPE)) return;
      if (!(await this.preferences.voiceprintsEnabled(event.ownerId))) return;
      // `available()` can be false before the model is installed; the port cannot answer that
      // without a download, so the job (not this listener) is where the model is fetched. The
      // listener only skips when the port is the no-op default (modelId 'none').
      if (this.voiceprints.dimensions === 0) return;
      const rows = await this.prisma.$queryRaw<Array<{ ok: number }>>`
        SELECT 1 AS ok FROM kg_person_voiceprints
         WHERE owner_id = ${event.ownerId}::uuid AND model_id = ${this.voiceprints.modelId} LIMIT 1`;
      if (rows.length === 0) return;
      await this.jobs.enqueue({
        type: KG_VOICE_MATCH_JOB_TYPE,
        reason: 'rerun',
        subjectType: KG_SUBJECT_TRANSCRIPT,
        subjectId: event.transcriptId,
        payload: { transcriptId: event.transcriptId },
      });
    } catch (error) {
      this.logger.warn(
        `Could not enqueue ${KG_VOICE_MATCH_JOB_TYPE} for transcript ${event.transcriptId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
