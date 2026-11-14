// =============================================================================
// VoiceprintsService (#826, epic #820)
// =============================================================================
//
// The routes behind speaker-name suggestions and the voiceprint controls. Every read and
// write is scoped to the CALLER's rows; a row that is not theirs is a 404, never a 403.
//
// BIOMETRIC: nothing here selects or returns the `embedding` column, and no audit payload
// carries more than ids and counts.
//
// Naming goes through `TranscriptEditingService.applyOperations`, the path the UI's rename
// uses, so the speaker-identified event -> `kg.speaker_link` -> (opted in)
// `kg.voiceprint_enroll` chain runs unchanged; enrolment closes the suggestion too, and
// `accept` sets the status itself so the answer does not depend on the job.
// =============================================================================

import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  DeleteAllVoiceprintsResponse,
  PersonVoiceprint,
  SpeakerSuggestion,
  SpeakerSuggestionDecision,
  VoiceprintsSummary,
} from '@marinoscar/kvox-contract/graph';

import { KVOX_AUDIT, KVOX_PRISMA, type KvoxAuditPort } from '../../ports/index.js';
import { OP_TYPES, TranscriptAccessService, TranscriptEditingService, type TranscriptsActor } from '../../transcripts/index.js';
import { GraphAccessService } from '../access/graph-access.service.js';
import type { KvoxGraphDb } from '../data/graph-db.js';
import type { GraphActor } from '../graph-actor.js';
import { KG_SUBJECT_ENTITY } from '../job-types.js';
import { GraphPreferencesService } from '../preferences/graph-preferences.service.js';
import { effectiveSpeakerNames } from '../speaker-link/speaker-link.reconciler.js';

/** Audit action: one person's voiceprints were deleted. */
export const VOICEPRINT_FORGOTTEN_ACTION = 'graph.voiceprint_forgotten';
/** Audit action: all of a user's voiceprints were deleted. */
export const VOICEPRINTS_DELETED_ALL_ACTION = 'graph.voiceprints_deleted_all';

/** `details.reason` of the 409 when the speaker was named in the meantime. */
export const SPEAKER_SUGGESTION_SPEAKER_NAMED_CODE = 'SPEAKER_ALREADY_NAMED';

interface SuggestionRow {
  id: string;
  speakerId: string;
  transcriptId: string;
  entityId: string;
  status: string;
  decidedAt: Date | null;
}

@Injectable()
export class VoiceprintsService {
  private readonly logger = new Logger(VoiceprintsService.name);

  constructor(
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxGraphDb,
    @Inject(KVOX_AUDIT) private readonly auditPort: KvoxAuditPort,
    private readonly graphAccess: GraphAccessService,
    private readonly transcriptAccess: TranscriptAccessService,
    private readonly editing: TranscriptEditingService,
    private readonly preferences: GraphPreferencesService,
  ) {}

  /** Pending suggestions for one transcript of the caller's: unnamed speaker, live Person. */
  async listForTranscript(transcriptId: string, user: GraphActor): Promise<SpeakerSuggestion[]> {
    const { transcript } = await this.transcriptAccess.require(user.id, transcriptId, 'view', user.permissions);
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; speaker_id: string; entity_id: string; label: string; score: number; margin: number | null; created_at: Date }>
    >`
      SELECT s.id, s.speaker_id, s.entity_id, e.label, s.score, s.margin, s.created_at
        FROM kg_speaker_suggestions s
        JOIN kg_entities e ON e.id = s.entity_id
       WHERE s.owner_id = ${user.id}::uuid
         AND s.transcript_id = ${transcript.id}::uuid
         AND s.status = 'pending'
         AND e.owner_id = ${user.id}::uuid
         AND e.type = 'Person'
         AND e.review_status IN ('accepted', 'edited')
         AND e.merged_into_id IS NULL
       ORDER BY s.score DESC, s.created_at ASC`;
    if (rows.length === 0) return [];

    const unnamed = await this.unnamedSpeakerIds(transcript.id, transcript.speakerIdentities);
    return rows
      .filter((r) => unnamed.has(r.speaker_id))
      .map((r) => ({
        id: r.id,
        speakerId: r.speaker_id,
        entityId: r.entity_id,
        entityName: r.label,
        score: r.score,
        margin: r.margin,
        createdAt: r.created_at.toISOString(),
      }));
  }

  /** Names the speaker with the Person's canonical name and closes the suggestion. */
  async accept(id: string, user: GraphActor): Promise<SpeakerSuggestionDecision> {
    const row = await this.requireSuggestion(id, user.id, ['pending', 'accepted']);
    if (row.status === 'accepted') return this.decision(row, 'accepted');

    const { transcript } = await this.transcriptAccess.require(user.id, row.transcriptId, 'edit', user.permissions);

    const person = await this.prisma.$queryRaw<Array<{ label: string }>>`
      SELECT label FROM kg_entities
       WHERE id = ${row.entityId}::uuid AND owner_id = ${user.id}::uuid AND type = 'Person'
         AND review_status IN ('accepted', 'edited') AND merged_into_id IS NULL`;
    if (person.length === 0) throw new NotFoundException('Speaker suggestion not found');

    const speakers = (await this.prisma.transcriptSpeaker.findMany({
      where: { transcriptId: transcript.id },
      select: { id: true, label: true, displayName: true, rev: true },
    })) as Array<{ id: string; label: string | null; displayName: string; rev: number }>;
    const speaker = speakers.find((s) => s.id === row.speakerId);
    if (!speaker) throw new NotFoundException('Speaker suggestion not found');
    const named = effectiveSpeakerNames(speakers, transcript.speakerIdentities);
    if (named.has(speaker.id)) {
      throw new ConflictException({
        message: 'This speaker has already been named.',
        details: { reason: SPEAKER_SUGGESTION_SPEAKER_NAMED_CODE },
      });
    }

    const actor: TranscriptsActor = { id: user.id, permissions: user.permissions };
    await this.editing.applyOperations(
      transcript.id,
      {
        baseVersion: transcript.currentVersion,
        clientBatchId: `voice-suggestion-${randomUUID()}`,
        ops: [{ op: OP_TYPES.RENAME_SPEAKER, speakerId: speaker.id, rev: speaker.rev, displayName: person[0]!.label }],
      },
      actor,
    );

    return this.close(row, 'accepted', user.id);
  }

  /** Dismisses the suggestion; `kg.voice_match` never re-suggests the pair. */
  async dismiss(id: string, user: GraphActor): Promise<SpeakerSuggestionDecision> {
    const row = await this.requireSuggestion(id, user.id, ['pending', 'dismissed']);
    if (row.status === 'dismissed') return this.decision(row, 'dismissed');
    await this.transcriptAccess.require(user.id, row.transcriptId, 'edit', user.permissions);
    return this.close(row, 'dismissed', user.id);
  }

  /** What is stored about one Person's voice. Person only. */
  async personVoiceprint(entityId: string, user: GraphActor): Promise<PersonVoiceprint> {
    await this.requirePerson(entityId, user, 'view');
    const rows = await this.prisma.$queryRaw<
      Array<{ samples: number; speech_ms: number; last_updated: Date | null; model_id: string | null }>
    >`
      SELECT count(*)::int AS samples,
             COALESCE(sum(speech_ms), 0)::int AS speech_ms,
             max(created_at) AS last_updated,
             (array_agg(model_id ORDER BY created_at DESC))[1] AS model_id
        FROM kg_person_voiceprints
       WHERE owner_id = ${user.id}::uuid AND entity_id = ${entityId}::uuid`;
    const r = rows[0];
    const samples = r?.samples ?? 0;
    return {
      enrolled: samples > 0,
      samples,
      speechMs: r?.speech_ms ?? 0,
      lastUpdatedAt: r?.last_updated ? r.last_updated.toISOString() : null,
      modelId: samples > 0 ? (r?.model_id ?? null) : null,
    };
  }

  /** Deletes the caller's samples of one Person and the pending suggestions pointing at them. */
  async forgetPerson(entityId: string, user: GraphActor): Promise<void> {
    await this.requirePerson(entityId, user, 'edit');
    const [samples] = await this.prisma.$transaction(async (tx) => {
      const deleted = await tx.$executeRaw`
        DELETE FROM kg_person_voiceprints WHERE owner_id = ${user.id}::uuid AND entity_id = ${entityId}::uuid`;
      const pending = await tx.$executeRaw`
        DELETE FROM kg_speaker_suggestions
         WHERE owner_id = ${user.id}::uuid AND entity_id = ${entityId}::uuid AND status = 'pending'`;
      return [Number(deleted), Number(pending)] as const;
    });
    await this.audit(user.id, VOICEPRINT_FORGOTTEN_ACTION, KG_SUBJECT_ENTITY, entityId, { entityId, samples });
  }

  /** Deletes every voiceprint and pending suggestion of the caller's. */
  async deleteAll(user: GraphActor): Promise<DeleteAllVoiceprintsResponse> {
    const [deletedSamples, deletedSuggestions] = await this.prisma.$transaction(async (tx) => {
      const samples = await tx.$executeRaw`DELETE FROM kg_person_voiceprints WHERE owner_id = ${user.id}::uuid`;
      const pending = await tx.$executeRaw`
        DELETE FROM kg_speaker_suggestions WHERE owner_id = ${user.id}::uuid AND status = 'pending'`;
      return [Number(samples), Number(pending)] as const;
    });
    await this.audit(user.id, VOICEPRINTS_DELETED_ALL_ACTION, 'user', user.id, { deletedSamples, deletedSuggestions });
    return { deletedSamples, deletedSuggestions };
  }

  /** The settings section's numbers. */
  async summary(user: GraphActor): Promise<VoiceprintsSummary> {
    const prefs = await this.preferences.get(user.id);
    const rows = await this.prisma.$queryRaw<Array<{ people: number; samples: number }>>`
      SELECT count(DISTINCT entity_id)::int AS people, count(*)::int AS samples
        FROM kg_person_voiceprints WHERE owner_id = ${user.id}::uuid`;
    return {
      enabled: prefs.voiceprints.enabled,
      consentAt: prefs.voiceprints.consentAt,
      people: rows[0]?.people ?? 0,
      samples: rows[0]?.samples ?? 0,
    };
  }

  // ---------------------------------------------------------------------------

  private async requirePerson(entityId: string, user: GraphActor, level: 'view' | 'edit'): Promise<void> {
    const entity = await this.graphAccess.require(user.id, 'entity', entityId, level, user.permissions);
    if (entity.type !== 'Person') throw new NotFoundException('Entity not found');
  }

  private async requireSuggestion(id: string, ownerId: string, statuses: string[]): Promise<SuggestionRow> {
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; speaker_id: string; transcript_id: string; entity_id: string; status: string; decided_at: Date | null }>
    >`
      SELECT id, speaker_id, transcript_id, entity_id, status, decided_at
        FROM kg_speaker_suggestions
       WHERE id = ${isUuid(id) ? id : '00000000-0000-0000-0000-000000000000'}::uuid AND owner_id = ${ownerId}::uuid`;
    const r = rows[0];
    if (!r || !statuses.includes(r.status)) throw new NotFoundException('Speaker suggestion not found');
    return {
      id: r.id,
      speakerId: r.speaker_id,
      transcriptId: r.transcript_id,
      entityId: r.entity_id,
      status: r.status,
      decidedAt: r.decided_at,
    };
  }

  private async close(row: SuggestionRow, status: 'accepted' | 'dismissed', ownerId: string): Promise<SpeakerSuggestionDecision> {
    const rows = await this.prisma.$queryRaw<Array<{ decided_at: Date }>>`
      UPDATE kg_speaker_suggestions
         SET status = ${status}, decided_at = COALESCE(decided_at, now())
       WHERE id = ${row.id}::uuid AND owner_id = ${ownerId}::uuid
   RETURNING decided_at`;
    return { id: row.id, status, decidedAt: (rows[0]?.decided_at ?? new Date()).toISOString() };
  }

  private decision(row: SuggestionRow, status: 'accepted' | 'dismissed'): SpeakerSuggestionDecision {
    return { id: row.id, status, decidedAt: (row.decidedAt ?? new Date()).toISOString() };
  }

  private async unnamedSpeakerIds(transcriptId: string, identities: unknown): Promise<Set<string>> {
    const speakers = (await this.prisma.transcriptSpeaker.findMany({
      where: { transcriptId },
      select: { id: true, label: true, displayName: true },
    })) as Array<{ id: string; label: string | null; displayName: string }>;
    const named = effectiveSpeakerNames(speakers, identities);
    return new Set(speakers.filter((s) => !named.has(s.id)).map((s) => s.id));
  }

  private async audit(
    userId: string,
    action: string,
    targetType: string,
    targetId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.auditPort.record({ actorUserId: userId, action, targetType, targetId, meta });
    } catch (error) {
      this.logger.error(`could not record ${action}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: string): boolean {
  return UUID.test(value);
}
