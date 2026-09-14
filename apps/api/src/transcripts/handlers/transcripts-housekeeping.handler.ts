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
// 2. FAILS TRANSCRIPTS WHOSE UPLOAD WAS CLEANED UP. A transcript stuck in
//    `uploading` whose backing `storage_objects` row was removed by the
//    activity-based stale-upload sweep is failed here, with a reason naming
//    the cleanup. §1.1 promises exactly this reconciliation: there is no
//    `failed` from `uploading` on the upload path itself, because an upload
//    that never completes is not the transcript's failure to record.
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

import { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import {
  TRANSCRIPT_SUBJECT_TYPE,
  TRANSCRIPTION_POLL_JOB_TYPE,
  TRANSCRIPTION_SUBMIT_JOB_TYPE,
  TRANSCRIPTS_HOUSEKEEPING_JOB_TYPE,
} from '../job-types';
import { TranscriptObjectsService } from '../transcript-objects.service';
import { TranscriptPipelineService } from '../transcript-pipeline.service';

/**
 * How long a transcript may sit in `uploading` before the sweep looks at
 * whether its upload is still alive.
 *
 * ⚠ DELIBERATELY LONGER THAN THE STORAGE SWEEP'S OWN WINDOW
 * (`STORAGE_STALE_UPLOAD_HOURS`, 72 hours by default). This sweep must react
 * to the storage cleanup having HAPPENED, not race it: a transcript failed at
 * 71 hours would be failed while its upload was still legitimately paused, and
 * "pause overnight, resume tomorrow" is a case §9.4 went out of its way to
 * make work.
 */
export const UPLOADING_GRACE_HOURS = 96;

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
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const now = new Date();
    const failures: string[] = [];

    let restarted = 0;
    let failed = 0;
    let expired = 0;

    try {
      restarted = await this.restartLostPollChains(now);
    } catch (error) {
      failures.push(`restarting lost poll chains: ${describe(error)}`);
    }

    try {
      failed = await this.failAbandonedUploads(now);
    } catch (error) {
      failures.push(`failing abandoned uploads: ${describe(error)}`);
    }

    try {
      expired = await this.expireExports(now);
    } catch (error) {
      failures.push(`expiring exports: ${describe(error)}`);
    }

    this.logger.log(
      `Transcript housekeeping (job ${job.id}): ${restarted} poll chain(s) restarted, ` +
        `${failed} abandoned upload(s) failed, ${expired} export(s) expired`,
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
  private async failAbandonedUploads(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - UPLOADING_GRACE_HOURS * 3_600_000);

    const stuck = await this.prisma.transcript.findMany({
      where: { deletedAt: null, status: 'uploading', createdAt: { lt: cutoff } },
      select: { id: true, sourceObjectId: true },
      take: HOUSEKEEPING_BATCH,
    });

    if (stuck.length === 0) return 0;

    const liveObjects = await this.prisma.storageObject.findMany({
      where: { id: { in: stuck.map((entry) => entry.sourceObjectId) } },
      select: { id: true, status: true },
    });

    const byId = new Map(liveObjects.map((entry) => [entry.id, entry.status]));
    let failed = 0;

    for (const entry of stuck) {
      const status = byId.get(entry.sourceObjectId);

      // A `ready` object with a transcript still in `uploading` is a DIFFERENT
      // bug — the upload-completed event was missed — and this sweep does not
      // pretend to fix it, because failing a transcript whose audio is present
      // and fine would destroy the one thing worth keeping. It is logged, and
      // the upload listener remains the only thing that promotes the row.
      if (status === 'ready') {
        this.logger.warn(
          `Transcript ${entry.id} is still 'uploading' but its source object is ready; ` +
            'the upload-completed event appears to have been missed',
        );

        continue;
      }

      const reason =
        status === undefined
          ? 'The upload was never completed and its storage record has since been cleaned up.'
          : `The upload was never completed (it is still '${status}').`;

      if (
        await this.pipeline.markFailed({
          transcriptId: entry.id,
          reason,
          stage: 'upload',
          retryable: false,
        })
      ) {
        failed += 1;
      }
    }

    return failed;
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
