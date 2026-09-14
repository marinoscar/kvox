// =============================================================================
// `transcription.ingest` (issue #25, epic #19, spec §1.5.4)
// =============================================================================
//
// Copies the finished result out of the provider and into this application's
// own tables, and is the moment a transcript becomes `ready`.
//
// -----------------------------------------------------------------------------
// ONE TRANSACTION, AND WHAT IS DELIBERATELY OUTSIDE IT
// -----------------------------------------------------------------------------
//
// INSIDE: `transcript_speakers`, `transcript_segments`, the
// `transcript_versions` v1 row, and `transcripts.status = 'ready'`. Those four
// writes are one fact — "this transcript exists now" — and a crash between any
// two of them would leave a readable transcript with no version, or a version
// naming segments that were never written. There is no partial success worth
// keeping.
//
// OUTSIDE, AND AFTER: the gzipped raw result (an upload to object storage —
// slow, external, and not something to hold a database transaction open
// across), the `transcript.snapshot` enqueue, `provider.deleteRemote`, and the
// owner's notification. Every one of those is retriable on its own and none of
// them should be able to roll back a transcript that is genuinely ingested.
//
// -----------------------------------------------------------------------------
// IDEMPOTENT ON "DOES VERSION 1 EXIST"
// -----------------------------------------------------------------------------
//
// The same shape `submit` uses for `provider_job_id`. A retry after the
// transaction committed but before `deleteRemote` ran must not write a second
// set of segments; `transcript_versions` has a unique `(transcript_id,
// version)`, so the re-entry check and the database constraint agree.
//
// SERVER-ONLY under rule 2's "reads/writes several tables mid-computation"
// exemption AND rule 3 (`deleteRemote` needs the same account-level API key).
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job, Prisma } from '@prisma/client';
import { gzipSync } from 'node:zlib';

import { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import type { JobExecutionProfile } from '../../jobs/job-execution-profile';
import { ProviderThrottleService } from '../../jobs/provider-throttle.service';
import { PrismaService } from '../../prisma/prisma.service';
import { isTerminalProviderError, ProviderAuthError } from '../../transcription/errors';
import type { NormalizedTranscript } from '../../transcription/normalized-transcript';
import {
  TRANSCRIPTION_INGEST_JOB_TYPE,
  TRANSCRIPTION_THROTTLE_KEY,
} from '../job-types';
import { TranscriptObjectsService } from '../transcript-objects.service';
import { TranscriptPipelineService } from '../transcript-pipeline.service';
import { TranscriptionRuntimeService } from '../transcription-runtime.service';

/**
 * Fifteen minutes.
 *
 * Long enough for a ten-hour recording's result — tens of megabytes of JSON,
 * hundreds of thousands of segment and word rows — to be fetched, gzipped,
 * uploaded and written; short enough that a wedged ingest frees its slot the
 * same working day.
 */
export const INGEST_MAX_RUNTIME_MS = 15 * 60 * 1000;

/**
 * The gap between consecutive segment ordinals.
 *
 * 1000, 2000, 3000, … so a later `segment.split` (#28) only needs the midpoint
 * between two neighbours and touches no other row. See spec §3.4 for why a
 * dense integer sequence would make every split an `UPDATE` whose cost grows
 * with how far into the transcript it happened.
 */
export const ORDINAL_GAP = 1000;

@Injectable()
export class TranscriptionIngestHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(TranscriptionIngestHandler.name);

  readonly type = TRANSCRIPTION_INGEST_JOB_TYPE;

  readonly profile: JobExecutionProfile = {
    maxRuntimeMs: INGEST_MAX_RUNTIME_MS,
    maxAttempts: 3,
  };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly runtime: TranscriptionRuntimeService,
    private readonly pipeline: TranscriptPipelineService,
    private readonly objects: TranscriptObjectsService,
    private readonly throttle: ProviderThrottleService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    this.throttle.registerProviderKey(this.type, TRANSCRIPTION_THROTTLE_KEY);
  }

  async process(job: Job): Promise<void> {
    const transcript = await this.pipeline.loadForJob(job.payload);

    if (!transcript) {
      this.logger.log(`Ingest job ${job.id} names no live transcript; nothing to do`);

      return;
    }

    if (transcript.status === 'deleting' || transcript.transcriptionStatus === 'cancelled') {
      this.logger.log(
        `Transcript ${transcript.id} is ${transcript.status}/` +
          `${transcript.transcriptionStatus}; ingest job ${job.id} is a no-op`,
      );

      return;
    }

    // ------------------------------------------------------------------------
    // Re-entry check. See the file header.
    // ------------------------------------------------------------------------
    const existing = await this.prisma.transcriptVersion.findUnique({
      where: { transcriptId_version: { transcriptId: transcript.id, version: 1 } },
      select: { id: true },
    });

    if (existing) {
      this.logger.log(
        `Transcript ${transcript.id} already has version 1; ingest job ${job.id} is a no-op`,
      );

      return;
    }

    if (!transcript.providerJobId) {
      await this.pipeline.markFailed({
        transcriptId: transcript.id,
        reason:
          'There is no provider job to fetch a result from. The submission may never have ' +
          'been accepted.',
        stage: 'ingest',
      });

      return;
    }

    let resolved;

    try {
      resolved = await this.runtime.resolve();
    } catch (error) {
      if (error instanceof ProviderAuthError || isTerminalProviderError(error)) {
        await this.pipeline.markFailed({
          transcriptId: transcript.id,
          reason: (error as Error).message,
          stage: 'ingest',
        });

        return;
      }

      throw error;
    }

    const { provider, ctx, policy } = resolved;

    let result;

    try {
      result = await provider.fetchResult(ctx, transcript.providerJobId);
    } catch (error) {
      if (isTerminalProviderError(error) || error instanceof ProviderAuthError) {
        await this.pipeline.markFailed({
          transcriptId: transcript.id,
          reason: (error as Error).message,
          stage: 'ingest',
          retryable: error instanceof ProviderAuthError,
        });

        return;
      }

      throw error;
    }

    const normalized = result.normalized;

    // ------------------------------------------------------------------------
    // Provenance, BEFORE the transaction (see the header).
    // ------------------------------------------------------------------------
    //
    // Gzipped because a ten-hour recording's provider JSON is tens of
    // megabytes of extremely repetitive structure, and stored because a
    // normalization bug found next year must be repairable from data already
    // paid for rather than by transcribing the audio a second time.
    //
    // ⚠ A FAILURE HERE MUST NOT FAIL THE INGEST. Provenance is insurance, not
    // the product: a transcript the user can read is worth more than a raw
    // blob nobody has asked for, and object storage being briefly unavailable
    // is not a reason to leave a completed transcription unsaved.
    let rawObjectId: string | null = null;

    try {
      const raw = await this.objects.put({
        storageKey: `transcripts/${transcript.id}/raw/${transcript.providerJobId}.json.gz`,
        name: `${transcript.id}-provider-result.json.gz`,
        mimeType: 'application/gzip',
        body: gzipSync(Buffer.from(JSON.stringify(result.raw ?? null), 'utf8')),
        ownerId: transcript.ownerId,
        metadata: { transcriptId: transcript.id, provider: provider.id, kind: 'raw-result' },
      });

      rawObjectId = raw.id;
    } catch (error) {
      this.logger.error(
        `Could not store the raw provider result for transcript ${transcript.id}: ` +
          `${error instanceof Error ? error.message : String(error)}. Ingesting anyway.`,
      );
    }

    // ------------------------------------------------------------------------
    // The one transaction.
    // ------------------------------------------------------------------------
    const speakerRows = buildSpeakers(normalized);
    const wordCount = countWords(normalized);

    await this.prisma.$transaction(async (tx) => {
      const speakerIds = new Map<string, string>();

      for (const speaker of speakerRows) {
        const created = await tx.transcriptSpeaker.create({
          data: {
            transcriptId: transcript.id,
            label: speaker.label,
            displayName: speaker.displayName,
            colorIndex: speaker.colorIndex,
          },
          select: { id: true },
        });

        speakerIds.set(speaker.label, created.id);
      }

      // `createMany` rather than a create per segment: a six-hour recording is
      // thousands of rows, and one statement is the difference between a
      // transaction measured in milliseconds and one measured in minutes —
      // which matters because everything else waits behind it.
      const segments: Prisma.TranscriptSegmentCreateManyInput[] = normalized.segments.map(
        (segment, index) => ({
          transcriptId: transcript.id,
          speakerId: speakerIds.get(segment.speakerLabel) as string,
          startMs: Math.max(0, Math.round(segment.startMs)),
          endMs: Math.max(0, Math.round(segment.endMs)),
          ordinal: (index + 1) * ORDINAL_GAP,
          text: segment.text,
          words: segment.words.map((word) => ({
            t: word.text,
            s: Math.round(word.startMs),
            e: Math.round(word.endMs),
            c: word.confidence,
          })) as unknown as Prisma.InputJsonValue,
          // A freshly ingested segment's timings are the provider's own,
          // untouched — which is what `exact` means (spec §3.5).
          wordsAlignment: 'exact',
          confidence: segment.confidence,
          origin: 'ai',
        }),
      );

      if (segments.length > 0) {
        await tx.transcriptSegment.createMany({ data: segments });
      }

      await tx.transcriptVersion.create({
        data: {
          transcriptId: transcript.id,
          version: 1,
          kind: 'ai_original',
          // ⚠ `authorId: null` MEANS "THE AI", and that is the schema's own
          // convention (spec §4.5) rather than a missing value. A version
          // attributed to a user is one a user made.
          authorId: null,
          summary: `Transcribed by ${provider.label}`,
          ops: [] as unknown as Prisma.InputJsonValue,
        },
      });

      await tx.transcript.update({
        where: { id: transcript.id },
        data: {
          status: 'ready',
          transcriptionStatus: 'completed',
          currentVersion: 1,
          completedAt: new Date(),
          speakerCount: speakerRows.length,
          wordCount,
          durationMs: normalized.durationMs > 0 ? Math.round(normalized.durationMs) : transcript.durationMs,
          language: normalized.language ?? transcript.language,
          failureReason: null,
          ...(rawObjectId ? { rawResultObjectId: rawObjectId } : {}),
        },
      });
    });

    this.logger.log(
      `Transcript ${transcript.id} ingested: ${speakerRows.length} speaker(s), ` +
        `${normalized.segments.length} segment(s), ${wordCount} word(s)`,
    );

    // ------------------------------------------------------------------------
    // After the commit. None of these may roll the transcript back.
    // ------------------------------------------------------------------------
    await this.pipeline.enqueueSnapshot(transcript.id, 1);

    if (policy.deleteRemoteAfterIngest) {
      // ⚠ NO CAPABILITY BRANCH. `deleteRemote` is MANDATORY on every provider
      // (spec §2.1) precisely so this call site never has to ask whether the
      // vendor supports it; a provider that cannot delete implements an
      // explicit, documented refusal rather than being absent.
      try {
        await provider.deleteRemote(ctx, transcript.providerJobId);

        await this.prisma.transcript.update({
          where: { id: transcript.id },
          data: { remoteDeletedAt: new Date() },
        });

        this.logger.log(
          `Provider copy ${transcript.providerJobId} deleted for transcript ${transcript.id}`,
        );
      } catch (error) {
        // NOT A FAILURE OF THE INGEST. The transcript is saved and readable;
        // the provider still holding a copy is a privacy debt this deployment
        // should clear, not a reason to tell the owner their transcription
        // failed. `transcripts.housekeeping` and `transcript.purge` both try
        // again later.
        this.logger.error(
          `Could not delete the provider's copy of transcript ${transcript.id} ` +
            `(${transcript.providerJobId}): ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const fresh = await this.prisma.transcript.findUnique({
      where: { id: transcript.id },
      select: {
        id: true,
        ownerId: true,
        title: true,
        durationMs: true,
        speakerCount: true,
        wordCount: true,
      },
    });

    if (fresh) {
      await this.pipeline.notifyReady(fresh, provider.label);
    }
  }
}

/** One `transcript_speakers` row per distinct label the provider reported. */
export function buildSpeakers(
  normalized: NormalizedTranscript,
): Array<{ label: string; displayName: string; colorIndex: number }> {
  const labels = normalized.speakers.length
    ? normalized.speakers.map((speaker) => speaker.label)
    : [...new Set(normalized.segments.map((segment) => segment.speakerLabel))];

  return labels.map((label, index) => ({
    label,
    // "Speaker A" rather than "A": the provider's label is an identifier, and
    // a transcript whose speaker column reads "A / B / C" is one a reader has
    // to decode. Renaming it is #28's job; this is the starting point.
    displayName: `Speaker ${label}`,
    colorIndex: index,
  }));
}

/**
 * Words in the transcript.
 *
 * Counted from the word arrays when the provider emitted timings, and from
 * whitespace-separated tokens when it did not — a provider that diarizes
 * without word timings is a real configuration (spec §2.2), and reporting
 * `wordCount: 0` for a transcript full of text would be wrong in the one field
 * a list view puts in front of everybody.
 */
export function countWords(normalized: NormalizedTranscript): number {
  return normalized.segments.reduce((total, segment) => {
    if (segment.words.length > 0) return total + segment.words.length;

    const tokens = segment.text.trim().split(/\s+/).filter(Boolean);

    return total + tokens.length;
  }, 0);
}
