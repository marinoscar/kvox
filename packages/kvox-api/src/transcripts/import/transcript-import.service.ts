import { randomUUID } from 'node:crypto';

import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';

import {
  KVOX_AUDIT,
  KVOX_EVENTS,
  KVOX_PRISMA,
  type KvoxAuditPort,
  type KvoxEventsPort,
} from '../../ports/index.js';
import type { InputJsonValue } from '../data/prisma.js';
import type { KvoxTranscriptsDb } from '../data/transcripts-db.js';
import {
  TRANSCRIPT_SPEAKERS_IDENTIFIED_EVENT,
  TranscriptSpeakersIdentifiedEvent,
} from '../events/transcript-speakers-identified.event.js';
import { writeOriginalVersion } from '../original-version.js';
import { TranscriptObjectsService } from '../transcript-objects.service.js';
import { TranscriptPipelineService } from '../transcript-pipeline.service.js';
import { resolveOrgId, type TranscriptsActor } from '../transcripts-actor.js';
import {
  TRANSCRIPT_IMPORT_PROVIDER,
  parseTranscriptImport,
  planTranscriptImport,
  type TranscriptImportFailure,
} from './transcript-import.js';

// =============================================================================
// TranscriptImportService (issue #571; docs/specs/transcription.md §8.2)
// =============================================================================
//
// `POST /api/transcripts/imports`: a `kvox.transcript/v1` file becomes a `ready`
// transcript with no audio and no transcription job, which notes, search and the
// graph then treat like any other.
//
// SYNCHRONOUS, AND THAT IS THE QUEUE RULE KEPT, NOT BROKEN. The work is bounded by
// `maxImportBytes` (the multipart read stops there): one parse, one small object
// put and one transaction, all inside the request. Nothing here outlives it;
// what does (the v1 snapshot, the search index) is enqueued, as ingest enqueues it.
//
// THE ORDER, and why:
//   1. Parse and plan (pure). A bad file is a typed 400 before anything is written.
//   2. Store the file itself as the transcript's source object. `source_object_id`
//      is NOT NULL and `Restrict`, so a transcript needs an object; the file it was
//      made from is the honest one, `managed_by: transcripts` under the transcript's
//      own prefix, so `transcript.purge` frees it as it frees any source audio. Put
//      BEFORE the transaction (never hold a transaction across storage) and deleted
//      again if the transaction fails.
//   3. One transaction: the transcript row (`ready`, `completed`, `not_needed`),
//      version 1 through the same writer ingest uses, and the speaker identities.
//   4. After the commit, never able to roll it back: the audit row, the v1
//      snapshot and search-index enqueues, and the speaker-naming event the graph's
//      speaker link listens for. No "ready" notification: the caller is looking at
//      the answer.
// =============================================================================

/** The version-1 summary of an imported transcript. */
const IMPORT_SUMMARY = 'Imported from a kvox.transcript/v1 file';

/**
 * The uploaded file, as the route read it.
 *
 * @stability experimental
 */
export interface TranscriptImportFile {
  /** The filename the client sent (display only; the storage key is random). */
  filename: string;
  /** The bytes. */
  body: Buffer;
}

/**
 * The 400 a refused file answers: `details.reason`, plus the issues or the foreign
 * `schema` value when there are any.
 *
 * @param failure - what {@link parseTranscriptImport} refused.
 * @returns the exception to throw.
 * @stability experimental
 */
export function transcriptImportException(failure: TranscriptImportFailure): BadRequestException {
  return new BadRequestException({
    message: failure.message,
    details: {
      reason: failure.reason,
      ...(failure.issues !== undefined ? { issues: failure.issues } : {}),
      ...(failure.schema !== undefined ? { schema: failure.schema } : {}),
    },
  });
}

/**
 * TranscriptImportService: wiring the slice registers itself; a host configures it through
 * `TranscriptsModule.forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class TranscriptImportService {
  private readonly logger = new Logger(TranscriptImportService.name);

  constructor(
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxTranscriptsDb,
    @Inject(KVOX_EVENTS) private readonly events: KvoxEventsPort,
    @Inject(KVOX_AUDIT) private readonly auditPort: KvoxAuditPort,
    private readonly objects: TranscriptObjectsService,
    private readonly pipeline: TranscriptPipelineService,
  ) {}

  /**
   * Creates a transcript from a `kvox.transcript/v1` file, owned by the caller.
   *
   * @param user - the caller.
   * @param file - the uploaded file.
   * @returns the new transcript's id.
   * @throws BadRequestException with `details.reason` when the file is refused.
   */
  async importFile(user: TranscriptsActor, file: TranscriptImportFile): Promise<{ transcriptId: string }> {
    const now = new Date();
    const parsed = parseTranscriptImport(file.body, { now });

    if (!parsed.ok) throw transcriptImportException(parsed);

    const plan = planTranscriptImport(parsed.document);
    const orgId = await resolveOrgId(this.prisma, user.activeOrgId ?? null, `transcript import for ${user.id}`);

    // The id is chosen here so the source object can live under the transcript's own
    // prefix (`transcripts/<id>/...`) before the row exists.
    const transcriptId = randomUUID();
    const source = await this.objects.put({
      storageKey: `transcripts/${transcriptId}/source/${randomUUID()}.json`,
      name: sourceName(file.filename),
      mimeType: 'application/json',
      body: file.body,
      ownerId: user.id,
      metadata: { transcriptId, kind: 'import-source' },
    });

    let identified: string[];

    try {
      identified = await this.prisma.$transaction(
        async (tx) => {
          await tx.transcript.create({
            data: {
              id: transcriptId,
              ownerId: user.id,
              orgId,
              createdAt: now,
              recordedAt: plan.recordedAt,
              title: plan.title,
              language: plan.language,
              status: 'ready',
              transcriptionStatus: 'completed',
              // There is no audio, so there is no rendition to make.
              playbackStatus: 'not_needed',
              sourceObjectId: source.id,
              provider: TRANSCRIPT_IMPORT_PROVIDER,
              providerOptions: {
                speakersExpected: null,
                language: plan.language,
                keyterms: [],
                importedFrom: plan.importedFrom,
              } as unknown as InputJsonValue,
              completedAt: now,
              durationMs: plan.durationMs,
              speakerCount: plan.speakerCount,
              wordCount: plan.wordCount,
              currentVersion: 1,
            },
          });

          const speakerIds = await writeOriginalVersion(tx, {
            transcriptId,
            speakers: plan.speakers,
            segments: plan.segments,
            summary: IMPORT_SUMMARY,
          });

          // The state naming each speaker through the API leaves (spec §4.6): the
          // live display name is the person, and `speaker_identities` says so.
          const identities: Record<string, string> = {};

          for (const speaker of plan.speakers) {
            const id = speakerIds.get(speaker.key);

            if (speaker.identity !== null && id !== undefined) identities[id] = speaker.identity;
          }

          if (Object.keys(identities).length > 0) {
            await tx.transcript.update({
              where: { id: transcriptId },
              data: { speakerIdentities: identities as InputJsonValue },
            });
          }

          return Object.keys(identities);
        },
        { timeout: 60_000 },
      );
    } catch (error) {
      // The object is the transaction's only side effect outside it; take it back.
      await this.objects.deleteIfPresent(source.id);

      throw error;
    }

    this.logger.log(
      `Transcript ${transcriptId} imported for user ${user.id}: ${plan.speakerCount} speaker(s), ` +
        `${plan.segments.length} segment(s), ${plan.wordCount} word(s)`,
    );

    await this.afterCommit(user, transcriptId, identified, plan.segments.length, file.body.byteLength);

    return { transcriptId };
  }

  /** Everything after the commit. None of it may fail the import. */
  private async afterCommit(
    user: TranscriptsActor,
    transcriptId: string,
    identified: string[],
    segments: number,
    bytes: number,
  ): Promise<void> {
    await this.contained(`audit transcript ${transcriptId}`, () =>
      this.auditPort.record({
        actorUserId: user.id,
        action: 'transcript:import',
        targetType: 'transcript',
        targetId: transcriptId,
        meta: { segments, sourceSize: String(bytes) },
      }),
    );

    // Version 1's snapshot is what makes its history reachable (spec §4.3), exactly as
    // after an ingest; the search index is the first content event (ingest's too).
    await this.contained(`queue the v1 snapshot of ${transcriptId}`, () =>
      this.pipeline.enqueueSnapshot(transcriptId, 1),
    );
    await this.pipeline.enqueueSearchIndex(transcriptId);

    // The graph links named speakers to people on this event (`kg.speaker_link`);
    // a note's extraction then turns those people into ATTENDED relations.
    if (identified.length > 0) {
      await this.contained(`emit ${TRANSCRIPT_SPEAKERS_IDENTIFIED_EVENT} for ${transcriptId}`, async () => {
        this.events.emit(
          TRANSCRIPT_SPEAKERS_IDENTIFIED_EVENT,
          new TranscriptSpeakersIdentifiedEvent(transcriptId, user.id, identified),
        );
      });
    }
  }

  private async contained(what: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.logger.warn(`Could not ${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** The display name of the stored file: the client's basename, bounded, or a default. */
function sourceName(filename: string): string {
  const base = filename.split(/[\\/]/).pop()?.trim() ?? '';

  return base.length > 0 ? base.slice(0, 255) : 'transcript.json';
}
