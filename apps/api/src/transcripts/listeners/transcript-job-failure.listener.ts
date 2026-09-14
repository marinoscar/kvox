// =============================================================================
// TranscriptJobFailureListener (issue #95, epic #19)
// =============================================================================
//
// A transcript whose pipeline job GAVE UP must stop saying it is working.
//
// -----------------------------------------------------------------------------
// WHY THIS EXISTS
// -----------------------------------------------------------------------------
//
// Every handler fails the transcript itself for the failures it can CLASSIFY —
// a bad key, a file the provider rejects, a terminal provider error — and
// returns normally. Anything it cannot classify is rethrown so the queue can
// retry it, which is right for a network hiccup. But nothing ran when that
// retry budget ran OUT. #95 is the live case: AssemblyAI started refusing the
// deprecated `speech_model` parameter with an HTTP 400, which `assertOk`
// (deliberately) reports as a plain retryable `Error`; `transcription.submit`
// spent its `maxAttempts: 3`, the job row went `failed` — and the transcript
// sat at `processing` / `submitting` with `failure_reason: NULL`, showing
// "Sending to the transcription service" forever, with no error anywhere the
// owner could see and no retry button because nothing had failed.
//
// Classifying more errors as terminal in the provider would not close this: the
// next unrecognised failure strands the transcript the same way. The job
// settling as `failed` is the one signal every exhausted path shares, so the
// fix listens for it.
//
// -----------------------------------------------------------------------------
// WHICH TYPES, AND WHY `media.audio.transcode` IS ONE OF THEM
// -----------------------------------------------------------------------------
//
//   • `transcription.submit`, `transcription.poll` → stage `transcription`.
//   • `transcription.ingest` → stage `ingest`, so the owner's email says
//     "Saving the transcript" rather than blaming the provider for a failure
//     that happened on our side of the result.
//   • `media.audio.transcode` → NOT a transcript failure by itself. Its handler's
//     `onTranscodeError` already records a permanent failure on the LAST
//     attempt (`playback_status: failed`, and the transcript failed only when
//     transcription was `waiting_input` on that rendition). But that method
//     runs only inside the SERVER's `process()` catch. A transcode is
//     node-eligible, so a node that exhausts the budget reports through
//     `POST /api/nodes/:id/jobs/:jobId/failure` and the server-side hook never
//     runs; neither does it for a server process killed mid-transcode (OOM,
//     timeout) whose last attempt is then settled by the reaper. Either way
//     `playback_status` stays `processing`, `transcription.submit` keeps reading
//     "a rendition is coming", and the transcript waits forever — the same
//     stranding as above. So this listener applies exactly what
//     `onTranscodeError` would have, and both writes are conditional, so the
//     server path running first makes this a no-op.
//
// Other transcript job types (`transcript.snapshot`, `.export`, `.purge`,
// housekeeping) never leave a transcript `processing`, so they are not here.
//
// -----------------------------------------------------------------------------
// A BYSTANDER TO THE QUEUE — the shape of `notifications/ops/job-failure-notifier.ts`
// -----------------------------------------------------------------------------
//
//   • `EventEmitter2` dispatches SYNCHRONOUSLY inside the worker's completion
//     path, so the handler returns synchronously and the work is a detached,
//     `.catch()`ed promise; the whole body is in try/catch too. Nothing here
//     can affect a terminal job row or a worker slot.
//   • CLAUDE.md rule 1: this is not long-running work. At most two small row
//     reads and two conditional updates (plus `markFailed`'s detached notify) —
//     no download, no spawn, no sweep.
//   • IDEMPOTENT. `markFailed` guards in its own `UPDATE` (a transcript already
//     `failed`/`deleting` is untouched and no second email is sent), the
//     playback write is conditional on `pending`/`processing`, and the status
//     read below skips anything no longer `processing`.
//   • A STALE FAILURE MUST NOT FAIL A LIVE PIPELINE. If another job for this
//     transcript is still `pending`/`running` (the owner pressed retry, or a
//     newer link of a poll chain exists), that job owns the outcome and this
//     settle event is history.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { Job } from '@prisma/client';

import {
  JOB_SETTLED_EVENT,
  type JobSettledEvent,
} from '../../jobs/events/job-settled.event';
import { PrismaService } from '../../prisma/prisma.service';
import {
  TRANSCODE_JOB_TYPE,
  TRANSCRIPT_SUBJECT_TYPE,
  TRANSCRIPTION_INGEST_JOB_TYPE,
  TRANSCRIPTION_POLL_JOB_TYPE,
  TRANSCRIPTION_SUBMIT_JOB_TYPE,
} from '../job-types';
import {
  readTranscriptId,
  TranscriptPipelineService,
  type TranscriptStage,
} from '../transcript-pipeline.service';

/** The provider-facing types whose exhaustion fails the transcript outright. */
const TRANSCRIPTION_STAGE_BY_TYPE: Readonly<Record<string, TranscriptStage>> = {
  [TRANSCRIPTION_SUBMIT_JOB_TYPE]: 'transcription',
  [TRANSCRIPTION_POLL_JOB_TYPE]: 'transcription',
  [TRANSCRIPTION_INGEST_JOB_TYPE]: 'ingest',
};

/** Every type whose exhaustion can strand a transcript in `processing`. */
const PIPELINE_JOB_TYPES = [...Object.keys(TRANSCRIPTION_STAGE_BY_TYPE), TRANSCODE_JOB_TYPE];

/** Bound on the job error quoted into `failure_reason` and the owner's email. */
export const MAX_QUOTED_JOB_ERROR_LENGTH = 500;

@Injectable()
export class TranscriptJobFailureListener {
  private readonly logger = new Logger(TranscriptJobFailureListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pipeline: TranscriptPipelineService,
  ) {}

  /**
   * A job settled. If it was a transcript pipeline job that gave up, make the
   * transcript say so.
   *
   * RETURNS SYNCHRONOUSLY IN EVERY CASE — see the file header.
   */
  @OnEvent(JOB_SETTLED_EVENT)
  handleJobSettled(event: JobSettledEvent): void {
    try {
      if (event.status !== 'failed' || !PIPELINE_JOB_TYPES.includes(event.type)) return;

      const job = event.job;

      void this.reconcile(job).catch((error: unknown) => {
        this.logger.error(
          `Could not record the exhausted ${job.type} job ${job.id} on its transcript; ` +
            `transcripts.housekeeping remains the backstop: ${describe(error)}`,
        );
      });
    } catch (error) {
      // Belt and braces over `emitSettled`'s own catch.
      this.logger.error(
        `Could not handle the settled job ${event.jobId}; the job's terminal row is ` +
          `unaffected: ${describe(error)}`,
      );
    }
  }

  /** Exposed for tests: the awaited body the detached handler runs. */
  async reconcile(job: Job): Promise<void> {
    const transcriptId = resolveTranscriptId(job);

    if (!transcriptId) return;

    const transcript = await this.prisma.transcript.findUnique({
      where: { id: transcriptId },
      select: { id: true, status: true, deletedAt: true },
    });

    // Gone, deleted, cancelled (which is `failed`), already failed, or already
    // ready: nothing is stranded.
    if (!transcript || transcript.deletedAt !== null || transcript.status !== 'processing') {
      return;
    }

    const stillActive = await this.prisma.job.count({
      where: {
        id: { not: job.id },
        type: { in: PIPELINE_JOB_TYPES },
        status: { in: ['pending', 'running'] },
        OR: [
          { subjectType: TRANSCRIPT_SUBJECT_TYPE, subjectId: transcriptId },
          { payload: { path: ['transcriptId'], equals: transcriptId } },
        ],
      },
    });

    if (stillActive > 0) {
      this.logger.log(
        `Exhausted ${job.type} job ${job.id} leaves transcript ${transcriptId} alone: ` +
          `${stillActive} newer pipeline job(s) are still active`,
      );

      return;
    }

    const error = quoteJobError(job.lastError);

    if (job.type === TRANSCODE_JOB_TYPE) {
      await this.reconcileTranscode(transcriptId, error);

      return;
    }

    const stage = TRANSCRIPTION_STAGE_BY_TYPE[job.type];

    if (!stage) return;

    await this.pipeline.markFailed({
      transcriptId,
      reason:
        (stage === 'ingest'
          ? 'The finished transcript could not be saved after several attempts.'
          : 'The transcription service could not process this recording after several attempts.') +
        ` You can retry it.${error ? ` (${error})` : ''}`,
      stage,
      retryable: true,
    });
  }

  /** Mirror of `MediaAudioTranscodeHandler.onTranscodeError`'s last-attempt branch. */
  private async reconcileTranscode(transcriptId: string, error: string | null): Promise<void> {
    await this.prisma.transcript.updateMany({
      where: { id: transcriptId, playbackStatus: { in: ['pending', 'processing'] } },
      data: { playbackStatus: 'failed' },
    });

    const current = await this.prisma.transcript.findUnique({
      where: { id: transcriptId },
      select: { transcriptionStatus: true },
    });

    // Only when transcription was waiting for THIS rendition — a transcript the
    // provider can take directly still has a pipeline, just no playback file.
    if (current?.transcriptionStatus !== 'waiting_input') return;

    await this.pipeline.markFailed({
      transcriptId,
      reason:
        'This recording could not be converted into a format the transcription provider ' +
        `accepts. The upload itself is intact and can be downloaded.${error ? ` (${error})` : ''}`,
      stage: 'transcode',
    });
  }
}

/**
 * The transcript a pipeline job is about: the payload's `transcriptId` (what
 * every handler reads, via `readTranscriptId`), else a `transcript` subject.
 * A transcode's subject is its storage object, so the payload is the only
 * source for that type.
 */
export function resolveTranscriptId(job: Pick<Job, 'payload' | 'subjectType' | 'subjectId'>): string | null {
  const fromPayload = readTranscriptId(job.payload);

  if (fromPayload) return fromPayload;

  return job.subjectType === TRANSCRIPT_SUBJECT_TYPE && job.subjectId ? job.subjectId : null;
}

/** The job's last error, whitespace-collapsed and bounded, or `null`. */
export function quoteJobError(lastError: string | null): string | null {
  const text = lastError?.replace(/\s+/g, ' ').trim();

  if (!text) return null;

  return text.length > MAX_QUOTED_JOB_ERROR_LENGTH
    ? `${text.slice(0, MAX_QUOTED_JOB_ERROR_LENGTH - 1)}…`
    : text;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
