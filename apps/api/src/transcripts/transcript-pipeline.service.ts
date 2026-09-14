// =============================================================================
// TranscriptPipelineService (issue #25, epic #19)
// =============================================================================
//
// The state transitions and the enqueues that MORE THAN ONE stage performs.
//
// Five handlers, one listener and two controller actions all need to do some
// subset of: mark a transcript failed with a reason, enqueue the next stage,
// and tell the owner. Every one of those has a rule attached to it that is
// invisible at the call site and expensive to get wrong —
//
//   • a failure has to write BOTH `transcripts.status` and the sub-pipeline
//     status that actually failed, or the pipeline stepper shows a `failed`
//     transcript still "Transcribing";
//   • the poll re-enqueue MUST pass `skipDedup: true`, and the reason is three
//     paragraphs long (see `enqueuePoll`);
//   • `notify()` must be called AFTER the triggering write has committed and
//     OUTSIDE any transaction (CLAUDE.md, "Adding a Notification");
//   • two of the six enqueues name a job type ANOTHER ISSUE registers, so they
//     have to check the registry first or they queue a row nothing can claim.
//
// Putting them in six different files means writing each rule down six times
// and having five of them go stale. This service is the one copy.
//
// ⚠ IT DOES NOT CALL THE PROVIDER. Nothing here talks to a vendor, signs a
// URL, or reads a credential — that all stays in the handlers, which are the
// things the queue can retry. This is state and scheduling only.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  Prisma,
  Transcript,
  TranscriptionStatus as TranscriptionStatusEnum,
} from '@prisma/client';

import type {
  TranscriptFailedEmailData,
  TranscriptReadyEmailData,
} from '../email';
import { JobHandlerRegistry } from '../jobs/job-handler.registry';
import { JobsService } from '../jobs/jobs.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  TRANSCODE_JOB_TYPE,
  TRANSCRIPT_PURGE_JOB_TYPE,
  TRANSCRIPT_SNAPSHOT_JOB_TYPE,
  TRANSCRIPT_SUBJECT_TYPE,
  TRANSCRIPTION_INGEST_JOB_TYPE,
  TRANSCRIPTION_POLL_JOB_TYPE,
  TRANSCRIPTION_SUBMIT_JOB_TYPE,
} from './job-types';
import { firstPollDelayMs } from './poll-schedule';

/**
 * Which part of the pipeline a failure came from, in words a reader
 * recognises. Reaches the failure email's `stage` field verbatim.
 */
export type TranscriptStage = 'upload' | 'transcode' | 'transcription' | 'ingest';

const STAGE_LABELS: Record<TranscriptStage, string> = {
  upload: 'Receiving the audio',
  transcode: 'Preparing audio',
  transcription: 'Transcribing',
  ingest: 'Saving the transcript',
};

/** What `markFailed` needs. Every field is a fact the caller already has. */
export interface MarkFailedInput {
  transcriptId: string;
  /** Rendered verbatim into the failure email. Write it for a person. */
  reason: string;
  stage: TranscriptStage;
  /**
   * Whether the owner's retry button can plausibly help.
   *
   * `false` for a file the provider will reject identically every time; `true`
   * for a deployment misconfiguration an administrator can fix, or a provider
   * that lost the job. It only changes the email's closing sentence — the
   * retry endpoint's own check is what actually decides.
   */
  retryable?: boolean;
}

@Injectable()
export class TranscriptPipelineService {
  private readonly logger = new Logger(TranscriptPipelineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly registry: JobHandlerRegistry,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  // ---------------------------------------------------------------------------
  // Failure
  // ---------------------------------------------------------------------------

  /**
   * Record a permanent failure and tell the owner.
   *
   * ⚠ IDEMPOTENT, AND THE GUARD IS IN THE `UPDATE`, NOT IN A PRIOR READ. The
   * write is conditional on the row not already being `failed`, so two stages
   * failing the same transcript concurrently — a poll hitting its deadline at
   * the same moment an ingest rejects the result — produce ONE failure and ONE
   * notification rather than two of each. A `findFirst` before the update
   * cannot close that race; `updateMany` with the status in its `where` can,
   * and `count` reports which caller won.
   *
   * Returns `true` when THIS call was the one that failed the transcript.
   */
  async markFailed(input: MarkFailedInput): Promise<boolean> {
    const { transcriptId, reason, stage, retryable = true } = input;

    const transcriptionStatus: TranscriptionStatusEnum | undefined =
      stage === 'transcription' || stage === 'ingest' ? 'failed' : undefined;

    const result = await this.prisma.transcript.updateMany({
      where: {
        id: transcriptId,
        deletedAt: null,
        // `deleting` is excluded as well as `failed`: an owner who asked for
        // the transcript to be removed does not get it resurrected as a
        // failure by a job that was still in flight when they clicked.
        status: { notIn: ['failed', 'deleting'] },
      },
      data: {
        status: 'failed',
        failureReason: reason,
        ...(transcriptionStatus ? { transcriptionStatus } : {}),
      },
    });

    if (result.count === 0) {
      this.logger.debug(
        `Transcript ${transcriptId} was already terminal; "${reason}" changed nothing`,
      );

      return false;
    }

    this.logger.warn(`Transcript ${transcriptId} failed at ${stage}: ${reason}`);

    // AFTER the write, OUTSIDE any transaction — `notify` is detached and
    // never rejects, so this cannot turn a recorded failure into a thrown one.
    const transcript = await this.prisma.transcript.findUnique({
      where: { id: transcriptId },
      select: { id: true, ownerId: true, title: true },
    });

    if (transcript) {
      const payload: TranscriptFailedEmailData = {
        transcriptId: transcript.id,
        title: transcript.title,
        reason,
        stage: STAGE_LABELS[stage],
        retryable,
        appUrl: this.appUrl(),
      };

      await this.notifications.notify(
        'transcripts.transcript_failed',
        transcript.ownerId,
        payload,
      );
    }

    return true;
  }

  /**
   * Tell the owner their transcript is ready.
   *
   * Separate from the write that made it ready, because that write is a
   * TRANSACTION and a notification must not be inside one: a dispatch that
   * joined the transaction would hold it open across an SMTP round trip, and a
   * rollback after the send would mail somebody about a transcript that does
   * not exist.
   */
  async notifyReady(
    transcript: Pick<
      Transcript,
      'id' | 'ownerId' | 'title' | 'durationMs' | 'speakerCount' | 'wordCount'
    >,
    providerLabel: string,
  ): Promise<void> {
    const payload: TranscriptReadyEmailData = {
      transcriptId: transcript.id,
      title: transcript.title,
      durationMs: transcript.durationMs,
      speakerCount: transcript.speakerCount,
      wordCount: transcript.wordCount,
      providerLabel,
      appUrl: this.appUrl(),
    };

    await this.notifications.notify(
      'transcripts.transcript_ready',
      transcript.ownerId,
      payload,
    );
  }

  // ---------------------------------------------------------------------------
  // Enqueues
  // ---------------------------------------------------------------------------

  /**
   * Queue the playback transcode, if this build has a handler for it.
   *
   * ⚠ GUARDED UNTIL #26. `media.audio.transcode` is registered by issue #26;
   * in a build without it, enqueueing would create a `pending` row no worker
   * can ever claim, which sits in the admin job list forever as a backlog of
   * one and never resolves. Checking the registry turns "not implemented yet"
   * into "nothing queued", which is the honest state.
   *
   * ⚠ `subjectType: 'storage_object'`, NOT `'transcript'`. That is spec §1.5.1
   * and it is load-bearing: it makes the job reuse the node data plane's
   * existing `resolveStorageObjectInput` unchanged. The transcript id travels
   * in the payload instead.
   */
  async enqueueTranscode(transcript: Transcript): Promise<boolean> {
    if (!this.registry.get(TRANSCODE_JOB_TYPE)) {
      this.logger.debug(
        `No handler is registered for ${TRANSCODE_JOB_TYPE} in this build; ` +
          `transcript ${transcript.id} gets no playback rendition`,
      );

      return false;
    }

    await this.jobs.enqueue({
      type: TRANSCODE_JOB_TYPE,
      reason: 'upload',
      subjectType: 'storage_object',
      subjectId: transcript.sourceObjectId,
      payload: { transcriptId: transcript.id },
    });

    await this.prisma.transcript.updateMany({
      where: { id: transcript.id, playbackStatus: 'pending' },
      data: { playbackStatus: 'processing' },
    });

    return true;
  }

  /** Queue the provider submission, and record that transcription is waiting on it. */
  async enqueueSubmit(transcriptId: string, reason: 'upload' | 'rerun' = 'upload'): Promise<void> {
    await this.prisma.transcript.update({
      where: { id: transcriptId },
      data: { transcriptionStatus: 'queued', failureReason: null },
    });

    await this.jobs.enqueue({
      type: TRANSCRIPTION_SUBMIT_JOB_TYPE,
      reason,
      subjectType: TRANSCRIPT_SUBJECT_TYPE,
      subjectId: transcriptId,
      payload: { transcriptId },
    });
  }

  /**
   * Queue the next status check.
   *
   * ⚠ `skipDedup: true` IS REQUIRED FOR CORRECTNESS, NOT AN OPTIMISATION.
   *
   * The active-dedup index is keyed on `(type, subject)` with the predicate
   * `status IN ('pending','running')`. The job calling this method is a
   * `transcription.poll` row for this exact transcript, and it is `running`
   * right now — so it MATCHES THAT KEY ITSELF.
   *
   * Without `skipDedup`, `enqueue()` would collide with the currently-running
   * row and return it, and the caller cannot tell a dedup hit from a fresh
   * insert. The newly computed backoff delay would be silently discarded, the
   * running job would finish moments later with nothing scheduled to check
   * again, and the transcript would sit in `submitted` forever with no error
   * anywhere to explain it. A NULL `dedup_key` never collides, so the row is
   * inserted unconditionally — which is exactly what a self-scheduling chain
   * needs.
   *
   * `delayMs` travels in the payload rather than being re-derived, because
   * each link of the chain has to know what the previous delay was in order to
   * multiply it.
   */
  async enqueuePoll(
    transcriptId: string,
    delayMs: number,
    reason: 'upload' | 'rerun' = 'upload',
  ): Promise<void> {
    await this.jobs.enqueue({
      type: TRANSCRIPTION_POLL_JOB_TYPE,
      reason,
      subjectType: TRANSCRIPT_SUBJECT_TYPE,
      subjectId: transcriptId,
      payload: { transcriptId, delayMs },
      scheduledFor: new Date(Date.now() + delayMs),
      // See the paragraphs above. Do not remove this.
      skipDedup: true,
    });
  }

  /** The first poll of a chain, with the duration-proportional opening delay. */
  async enqueueFirstPoll(
    transcriptId: string,
    durationMs: number | null,
    reason: 'upload' | 'rerun' = 'upload',
  ): Promise<void> {
    await this.enqueuePoll(transcriptId, firstPollDelayMs(durationMs), reason);
  }

  /** Queue the result copy. Deduped normally — two ingests of one job is waste. */
  async enqueueIngest(transcriptId: string): Promise<void> {
    await this.jobs.enqueue({
      type: TRANSCRIPTION_INGEST_JOB_TYPE,
      reason: 'upload',
      subjectType: TRANSCRIPT_SUBJECT_TYPE,
      subjectId: transcriptId,
      payload: { transcriptId },
    });
  }

  /**
   * Queue a version snapshot, if this build has a handler for it.
   *
   * ⚠ GUARDED UNTIL #27, for the same reason `enqueueTranscode` is guarded
   * until #26 — see that method.
   */
  async enqueueSnapshot(transcriptId: string, version: number): Promise<boolean> {
    if (!this.registry.get(TRANSCRIPT_SNAPSHOT_JOB_TYPE)) {
      this.logger.debug(
        `No handler is registered for ${TRANSCRIPT_SNAPSHOT_JOB_TYPE} in this build; ` +
          `transcript ${transcriptId} v${version} is not snapshotted`,
      );

      return false;
    }

    await this.jobs.enqueue({
      type: TRANSCRIPT_SNAPSHOT_JOB_TYPE,
      reason: 'upload',
      subjectType: TRANSCRIPT_SUBJECT_TYPE,
      subjectId: transcriptId,
      payload: { transcriptId, version },
    });

    return true;
  }

  /** Queue the purge of a soft-deleted transcript. */
  async enqueuePurge(transcriptId: string): Promise<void> {
    await this.jobs.enqueue({
      type: TRANSCRIPT_PURGE_JOB_TYPE,
      reason: 'rerun',
      subjectType: TRANSCRIPT_SUBJECT_TYPE,
      subjectId: transcriptId,
      payload: { transcriptId },
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** The transcript this job is about, or `null` if it is gone or deleted. */
  async loadForJob(payload: Prisma.JsonValue | null): Promise<Transcript | null> {
    const transcriptId = readTranscriptId(payload);

    if (!transcriptId) return null;

    const transcript = await this.prisma.transcript.findUnique({
      where: { id: transcriptId },
    });

    if (!transcript || transcript.deletedAt !== null) return null;

    return transcript;
  }

  /**
   * Absolute application root for an email CTA, or `undefined`.
   *
   * Same shape as `UsersService.appUrl()`; `undefined` makes the template omit
   * its button rather than render one that goes nowhere.
   */
  private appUrl(): string | undefined {
    const appUrl = this.config.get<string>('appUrl');

    return appUrl ? appUrl.replace(/\/+$/, '') : undefined;
  }
}

/**
 * The transcript id inside a job payload, or `null`.
 *
 * TOTAL OVER GARBAGE. A payload is JSONB written by an earlier process and
 * possibly an earlier build: it can be null, a string, an array, or an object
 * with the wrong field. Every one of those is "this job is about nothing",
 * which a handler answers by returning successfully rather than by throwing
 * three times before the queue gives up.
 */
export function readTranscriptId(payload: Prisma.JsonValue | null): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null;
  }

  const value = (payload as Record<string, unknown>).transcriptId;

  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The previous poll delay inside a `transcription.poll` payload, or `null`. */
export function readPollDelayMs(payload: Prisma.JsonValue | null): number | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null;
  }

  const value = (payload as Record<string, unknown>).delayMs;

  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}
