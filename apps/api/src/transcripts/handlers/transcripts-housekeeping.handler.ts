// =============================================================================
// `transcripts.housekeeping` (issue #25, epic #19, spec §1.5.8)
// =============================================================================
//
// The transcript-aware reconciliation sweep. It does three things the rest of
// the pipeline structurally cannot do for itself.
//
// 1. RESTARTS A LOST POLL CHAIN. A `transcription.poll` chain goes silent if
//    the process holding it dies between one poll and the `skipDedup: true`
//    re-enqueue of the next. The queue's own lease reaper recovers the JOB ROW
//    — but here there IS no job row: the link that would have created the next
//    one never ran. The reaper reasons about jobs; nothing in it reasons about
//    transcripts, and nothing could, because "a transcript in `submitted` with
//    no pending poll" is not a fact the queue can see. This sweep is the second
//    layer above the reaper's first.
//
// 2. PURGES TRANSCRIPTS WHOSE UPLOAD WAS ABANDONED (issue #322). A transcript
//    stuck in `uploading` whose source upload has been IDLE — no part-URL
//    batch, no status poll, so `storage_objects.updated_at` has not moved —
//    for longer than `transcription.abandonedUploadHours` (default 3) is
//    soft-deleted to `deleting` and handed to `transcript.purge`, which aborts
//    the multipart upload and frees the object. Measured from the upload's
//    last ACTIVITY, never from creation, so an upload being actively pushed is
//    never killed however long it takes.
//
//    PURGED, NOT FAILED. The old step failed these rows after a hardcoded 96
//    hours, which produced a permanent card nobody could retry (there is no
//    audio to retry with) and nothing but a manual delete could clear. An
//    upload that never completed never became a recording; there is nothing
//    to keep. The same step also purges the legacy rows that old behaviour
//    left behind (`failed` + `transcription_status = waiting_input` with no
//    completed audio).
//
//    This sweep is the ONLY thing that reclaims a transcript's abandoned
//    upload: the generic stale-upload sweep skips managed objects, because
//    deleting a row `transcripts.source_object_id` points at would violate its
//    `Restrict` foreign key. An upload the user CANCELS does not wait for this
//    at all — `TranscriptsUploadAbortedListener` purges it immediately.
//
// 3. EXPIRES EXPORTS. `transcript_exports` rows past their `expires_at`, and
//    the storage objects behind them. Issue #28 creates them; this sweep is
//    what keeps them from accumulating forever, and it is written now so that
//    #28 does not also have to add a sweep.
//
// -----------------------------------------------------------------------------
// IT IS A JOB, AND THE `@Cron` ONLY ENQUEUES IT
// -----------------------------------------------------------------------------
//
// CLAUDE.md rule 1, and `test/jobs/cron-enqueue-only.spec.ts` is its executable
// form: a `@Cron` may decide WHETHER work is due and enqueue it, never do it.
// Everything in this file is the work; `tasks/transcripts-housekeeping.task.ts`
// is six lines that queue it.
//
// SERVER-ONLY under rule 2's "reads/writes several tables mid-computation"
// exemption: it sweeps `transcripts`, `jobs`, `transcript_exports` and
// `storage_objects` in one pass, deciding as it goes.
//
// ⚠ NO STEP MAY THROW PAST THE OTHERS. Each of the three is wrapped, and their
// failures are collected and reported at the end. A sweep that aborted on the
// first bad row would mean one damaged transcript stops every other transcript
// from ever being reconciled — the classic failure mode of a housekeeping job
// that treats its own input as trustworthy.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job } from '@prisma/client';

import { DEFAULT_SYSTEM_SETTINGS } from '../../common/types/settings.types';
import { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { TranscriptionSettingsService } from '../../transcription/transcription-settings.service';
import {
  TRANSCRIPT_SUBJECT_TYPE,
  TRANSCRIPTION_POLL_JOB_TYPE,
  TRANSCRIPTION_SUBMIT_JOB_TYPE,
  TRANSCRIPTS_HOUSEKEEPING_JOB_TYPE,
} from '../job-types';
import { TranscriptObjectsService } from '../transcript-objects.service';
import { TranscriptPipelineService } from '../transcript-pipeline.service';

/**
 * The source-object facts step 2 decides on. One query loads them for every
 * candidate at once.
 */
export interface AbandonedUploadObject {
  status: 'pending' | 'uploading' | 'processing' | 'ready' | 'failed';
  updatedAt: Date;
}

/** What step 2 does with one candidate. */
export type AbandonedUploadDecision =
  /** Soft-delete to `deleting` and queue `transcript.purge`. */
  | 'purge'
  /** The upload is still inside the idle window — leave it alone. */
  | 'keep'
  /**
   * The audio is present (`ready`) or being post-processed (`processing`).
   * Never purged: that would destroy the one thing worth keeping.
   */
  | 'audio_present';

/**
 * Step 2's decision for one candidate, as a pure function so it can be tested
 * without a database.
 *
 * - `uploading` transcript (already older than the cutoff by creation — the
 *   query guarantees it): purge when the source object is gone, `failed`
 *   (aborted), or still `pending`/`uploading` with no activity since `cutoff`.
 * - legacy `failed` transcript (the old step 2's output): purge unless the
 *   audio is actually there. It can never be retried — there is nothing to
 *   retry with — so purging it is the only way the card ever goes away.
 * - either shape with a `ready`/`processing` object: never purged.
 */
export function decideAbandonedUpload(
  transcriptStatus: 'uploading' | 'failed',
  object: AbandonedUploadObject | undefined,
  cutoff: Date,
): AbandonedUploadDecision {
  if (!object) return 'purge';

  if (object.status === 'ready' || object.status === 'processing') {
    return 'audio_present';
  }

  if (object.status === 'failed') return 'purge';

  // `pending` / `uploading`. A legacy failed transcript's upload is dead by
  // definition — the transcript row no longer accepts it — so its activity
  // clock is irrelevant.
  if (transcriptStatus === 'failed') return 'purge';

  return object.updatedAt.getTime() < cutoff.getTime() ? 'purge' : 'keep';
}

/**
 * How long a transcript may sit `submitted`/`processing` with no poll job
 * before the chain is presumed broken.
 *
 * Comfortably above the 5-minute poll cap, so a chain that is merely between
 * two links is never mistaken for one that is gone.
 */
export const LOST_CHAIN_GRACE_MINUTES = 20;

/** Most rows any one sweep will act on, per step. */
export const HOUSEKEEPING_BATCH = 200;

@Injectable()
export class TranscriptsHousekeepingHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(TranscriptsHousekeepingHandler.name);

  readonly type = TRANSCRIPTS_HOUSEKEEPING_JOB_TYPE;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly pipeline: TranscriptPipelineService,
    private readonly objects: TranscriptObjectsService,
    private readonly transcriptionSettings: TranscriptionSettingsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const now = new Date();
    const failures: string[] = [];

    let restarted = 0;
    let purged = 0;
    let expired = 0;

    try {
      restarted = await this.restartLostPollChains(now);
    } catch (error) {
      failures.push(`restarting lost poll chains: ${describe(error)}`);
    }

    try {
      purged = await this.purgeAbandonedUploads(now);
    } catch (error) {
      failures.push(`purging abandoned uploads: ${describe(error)}`);
    }

    try {
      expired = await this.expireExports(now);
    } catch (error) {
      failures.push(`expiring exports: ${describe(error)}`);
    }

    this.logger.log(
      `Transcript housekeeping (job ${job.id}): ${restarted} poll chain(s) restarted, ` +
        `${purged} abandoned upload(s) purged, ${expired} export(s) expired`,
    );

    if (failures.length > 0) {
      // THROWN, so the sweep is retried and shows as failed in the admin job
      // list — after every step has had its turn. A sweep that reported
      // success having skipped a step is a sweep nobody ever finds out about.
      throw new Error(`Transcript housekeeping had failures: ${failures.join('; ')}`);
    }
  }

  /** Step 1 — see the file header. */
  private async restartLostPollChains(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - LOST_CHAIN_GRACE_MINUTES * 60_000);

    const candidates = await this.prisma.transcript.findMany({
      where: {
        deletedAt: null,
        status: 'processing',
        transcriptionStatus: { in: ['submitted', 'processing'] },
        providerJobId: { not: null },
        updatedAt: { lt: cutoff },
      },
      select: { id: true, durationMs: true, lastPolledAt: true },
      take: HOUSEKEEPING_BATCH,
    });

    if (candidates.length === 0) return 0;

    // ONE QUERY FOR EVERY CANDIDATE'S JOBS, not one per transcript: the
    // interesting deployments have hundreds of transcripts in flight, and a
    // per-row lookup turns a sweep into an N+1 over a table the queue is
    // already contending on.
    const liveJobs = await this.prisma.job.findMany({
      where: {
        type: TRANSCRIPTION_POLL_JOB_TYPE,
        subjectType: TRANSCRIPT_SUBJECT_TYPE,
        subjectId: { in: candidates.map((candidate) => candidate.id) },
        status: { in: ['pending', 'running'] },
      },
      select: { subjectId: true },
    });

    const covered = new Set(liveJobs.map((entry) => entry.subjectId));
    let restarted = 0;

    for (const candidate of candidates) {
      if (covered.has(candidate.id)) continue;

      this.logger.warn(
        `Transcript ${candidate.id} is waiting on the provider with no poll job; ` +
          'restarting the chain',
      );

      // The FIRST delay of a fresh chain, not a continuation of the lost one:
      // the previous chain's backoff state died with it, and starting over is
      // both correct and the cheap direction to be wrong in.
      await this.pipeline.enqueueFirstPoll(candidate.id, candidate.durationMs, 'rerun');

      restarted += 1;
    }

    return restarted;
  }

  /** Step 2 — see the file header. */
  private async purgeAbandonedUploads(now: Date): Promise<number> {
    const hours = await this.abandonedUploadHours();
    const cutoff = new Date(now.getTime() - hours * 3_600_000);

    // `createdAt < cutoff` on the `uploading` branch is only a cheap prefilter
    // — an upload cannot have been idle for longer than it has existed. The
    // real test is the source object's `updatedAt`, below.
    const candidates = await this.prisma.transcript.findMany({
      where: {
        deletedAt: null,
        OR: [
          { status: 'uploading', createdAt: { lt: cutoff } },
          // Legacy rows the old step 2 failed: no audio, never retryable.
          { status: 'failed', transcriptionStatus: 'waiting_input' },
        ],
      },
      select: { id: true, status: true, sourceObjectId: true },
      take: HOUSEKEEPING_BATCH,
    });

    if (candidates.length === 0) return 0;

    // ONE QUERY FOR EVERY CANDIDATE'S SOURCE OBJECT — same N+1 argument as
    // step 1.
    const sources = await this.prisma.storageObject.findMany({
      where: { id: { in: candidates.map((entry) => entry.sourceObjectId) } },
      select: { id: true, status: true, updatedAt: true },
    });

    const byId = new Map<string, AbandonedUploadObject>(
      sources.map((entry) => [
        entry.id,
        { status: entry.status, updatedAt: entry.updatedAt },
      ]),
    );
    let purged = 0;

    for (const entry of candidates) {
      // The query only selects these two; narrowed here for the decision.
      const status = entry.status as 'uploading' | 'failed';
      const decision = decideAbandonedUpload(status, byId.get(entry.sourceObjectId), cutoff);

      if (decision === 'keep') continue;

      if (decision === 'audio_present') {
        // A `ready`/`processing` object under an `uploading` transcript is a
        // DIFFERENT bug — the upload-completed event was missed — and this
        // sweep does not pretend to fix it, because purging a transcript whose
        // audio is present and fine would destroy the one thing worth keeping.
        // It is logged, and the upload listener remains the only thing that
        // promotes the row. (A legacy `failed` row with its audio present
        // failed for some other reason, and is silently left alone.)
        if (status === 'uploading') {
          this.logger.warn(
            `Transcript ${entry.id} is still 'uploading' but its source object is ` +
              `${byId.get(entry.sourceObjectId)?.status}; the upload-completed event appears ` +
              'to have been missed',
          );
        }

        continue;
      }

      // ⚠ CONDITIONAL ON THE STATUS THE CANDIDATE WAS READ IN, so an upload
      // that completed (or was cancelled and purged) between the read and this
      // write is left to whoever moved it. Same soft-delete shape
      // `TranscriptsService.remove` writes.
      const result = await this.prisma.transcript.updateMany({
        where: { id: entry.id, deletedAt: null, status },
        data: { status: 'deleting', deletedAt: now },
      });

      if (result.count === 0) continue;

      this.logger.log(
        `Transcript ${entry.id} (${status}) has an abandoned upload idle for over ` +
          `${hours}h; purging`,
      );

      await this.pipeline.enqueuePurge(entry.id);

      purged += 1;
    }

    return purged;
  }

  /**
   * `transcription.abandonedUploadHours`, read once per run.
   *
   * A settings read that fails falls back to the shipped default rather than
   * failing the step: the default is a perfectly good answer, and a sweep that
   * stops reconciling because a read blipped is the failure this job exists to
   * avoid.
   */
  private async abandonedUploadHours(): Promise<number> {
    try {
      const policy = await this.transcriptionSettings.get();

      return policy.abandonedUploadHours;
    } catch (error) {
      this.logger.warn(
        'Could not read transcription.abandonedUploadHours; using the default: ' +
          describe(error),
      );

      return DEFAULT_SYSTEM_SETTINGS.transcription.abandonedUploadHours;
    }
  }

  /** Step 3 — see the file header. */
  private async expireExports(now: Date): Promise<number> {
    const stale = await this.prisma.transcriptExport.findMany({
      where: { expiresAt: { lt: now } },
      select: { id: true, objectId: true },
      take: HOUSEKEEPING_BATCH,
    });

    let expired = 0;

    for (const entry of stale) {
      // ROW REFERENCE FIRST, THEN BYTES, THEN ROW. `object_id` is `Restrict`,
      // so the storage row cannot go while the export points at it.
      await this.prisma.transcriptExport.update({
        where: { id: entry.id },
        data: { objectId: null },
      });

      await this.objects.deleteIfPresent(entry.objectId);
      await this.prisma.transcriptExport.delete({ where: { id: entry.id } });

      expired += 1;
    }

    return expired;
  }
}

/** Anything thrown, as a message. JavaScript lets you throw a string. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Exported for the sweep's own spec: the job types it reasons about.
 *
 * `transcription.submit` is here rather than used above on purpose — step 1
 * restarts a POLL chain, never a submission, because a transcript with a
 * `provider_job_id` has already been submitted and re-submitting it would
 * create a second remote job for one recording. A transcript with NO provider
 * job id and no submit job is a different (and much rarer) shape that the
 * retry endpoint covers deliberately, rather than a sweep covering it by
 * accident.
 */
export const HOUSEKEEPING_RELATED_JOB_TYPES = [
  TRANSCRIPTION_POLL_JOB_TYPE,
  TRANSCRIPTION_SUBMIT_JOB_TYPE,
] as const;
