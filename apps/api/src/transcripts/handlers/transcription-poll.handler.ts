// =============================================================================
// `transcription.poll` (issue #25, epic #19, spec §1.5.3)
// =============================================================================
//
// Asks the provider whether it is finished, and RE-ENQUEUES ITSELF until it
// is. It is the one job type in this epic that schedules its own successor,
// and everything unusual about it follows from that.
//
// -----------------------------------------------------------------------------
// ⚠ THE `skipDedup: true` ON THE RE-ENQUEUE IS LOAD-BEARING
// -----------------------------------------------------------------------------
//
// It lives in `TranscriptPipelineService.enqueuePoll`, where the full argument
// is written out. The summary: the job calling it is ITSELF a `running`
// `transcription.poll` row for this exact subject, so it matches the
// active-dedup key, and an enqueue without `skipDedup` would be silently
// merged into the row that is running right now — discarding the newly
// computed delay, finishing moments later with nothing left scheduled, and
// stranding the transcript in `submitted` forever with no error anywhere.
//
// -----------------------------------------------------------------------------
// A CHAIN OF SHORT JOBS, NOT ONE LONG ONE
// -----------------------------------------------------------------------------
//
// `maxRuntimeMs: 2m` is deliberately tiny: one poll is one HTTP round trip.
// The alternative — a single job that loops until the provider is done —
// holds a worker slot for the recording's entire transcription time and
// fights the lease machinery the moment it outlives `maxRuntimeMs`. A chain
// holds a slot for milliseconds at a time and is trivially observable as a
// sequence of rows in the admin job list.
//
// `maxAttempts: 5` is higher than submit's 3 because a poll is cheap and
// idempotent — re-asking "are you done?" costs one request and changes
// nothing — so there is no reason to be stingy with a transient network
// failure at the one point in the pipeline where giving up strands work the
// provider has already been paid for.
//
// SERVER-ONLY under rule 3: the same account-level API key, needed again on
// every poll. See `transcription-submit.handler.ts`'s header for the argument.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job } from '@prisma/client';

import { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import type { JobExecutionProfile } from '../../jobs/job-execution-profile';
import { ProviderThrottleService } from '../../jobs/provider-throttle.service';
import { PrismaService } from '../../prisma/prisma.service';
import { isTerminalProviderError, ProviderAuthError } from '../../transcription/errors';
import {
  TRANSCRIPTION_POLL_JOB_TYPE,
  TRANSCRIPTION_THROTTLE_KEY,
} from '../job-types';
import { isPastPollDeadline, nextPollDelayMs, pollDeadline } from '../poll-schedule';
import {
  readPollDelayMs,
  TranscriptPipelineService,
} from '../transcript-pipeline.service';
import { TranscriptionRuntimeService } from '../transcription-runtime.service';

/** Two minutes. One poll is one HTTP round trip; see the file header. */
export const POLL_MAX_RUNTIME_MS = 2 * 60 * 1000;

@Injectable()
export class TranscriptionPollHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(TranscriptionPollHandler.name);

  readonly type = TRANSCRIPTION_POLL_JOB_TYPE;

  readonly profile: JobExecutionProfile = {
    maxRuntimeMs: POLL_MAX_RUNTIME_MS,
    maxAttempts: 5,
  };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly runtime: TranscriptionRuntimeService,
    private readonly pipeline: TranscriptPipelineService,
    private readonly throttle: ProviderThrottleService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    this.throttle.registerProviderKey(this.type, TRANSCRIPTION_THROTTLE_KEY);
  }

  async process(job: Job): Promise<void> {
    const transcript = await this.pipeline.loadForJob(job.payload);

    if (!transcript) {
      this.logger.log(`Poll job ${job.id} names no live transcript; the chain ends here`);

      return;
    }

    // THE CHAIN STOPS ON EVERY TERMINAL STATE, and stopping means RETURNING
    // rather than throwing: a cancelled or already-failed transcript is not a
    // job that went wrong, it is a chain whose reason to exist has gone.
    if (
      transcript.status === 'failed' ||
      transcript.status === 'deleting' ||
      transcript.status === 'ready' ||
      transcript.transcriptionStatus === 'cancelled' ||
      transcript.transcriptionStatus === 'failed' ||
      transcript.transcriptionStatus === 'completed'
    ) {
      this.logger.log(
        `Transcript ${transcript.id} is ${transcript.status}/` +
          `${transcript.transcriptionStatus}; poll chain ends at job ${job.id}`,
      );

      return;
    }

    if (!transcript.providerJobId) {
      // A poll with nothing to poll. `transcripts.housekeeping` is what
      // notices a transcript in this shape and re-queues a submit; this job
      // has nothing useful to do and says so.
      this.logger.warn(
        `Transcript ${transcript.id} has no provider job id; poll job ${job.id} ends the chain`,
      );

      return;
    }

    const now = new Date();

    // -------------------------------------------------------------------------
    // The hard deadline. `submittedAt + max(6h, 3 × duration)`.
    // -------------------------------------------------------------------------
    //
    // ⚠ A MISSING `submittedAt` IS TREATED AS "NOW", not as "no deadline". A
    // row with a provider job id and no submission timestamp is damaged, and
    // the dangerous reading of damaged state here is the one that polls
    // forever.
    const submittedAt = transcript.submittedAt ?? transcript.createdAt;

    if (isPastPollDeadline(submittedAt, transcript.durationMs, now)) {
      await this.pipeline.markFailed({
        transcriptId: transcript.id,
        reason:
          `The transcription provider did not finish within ` +
          `${describeWindow(submittedAt, transcript.durationMs)}. It may have lost the job.`,
        stage: 'transcription',
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
          stage: 'transcription',
        });

        return;
      }

      throw error;
    }

    const { provider, ctx } = resolved;

    let status;

    try {
      status = await provider.getStatus(ctx, transcript.providerJobId);
    } catch (error) {
      if (isTerminalProviderError(error) || error instanceof ProviderAuthError) {
        await this.pipeline.markFailed({
          transcriptId: transcript.id,
          reason: (error as Error).message,
          stage: 'transcription',
          retryable: error instanceof ProviderAuthError,
        });

        return;
      }

      // 429 included: deferred through the shared throttle key, no attempt
      // spent, the transcript's own status unchanged. From the owner's point
      // of view a rate limit is invisible backoff, not a failure.
      throw error;
    }

    if (status === 'failed') {
      // The provider's own terminal `error`. A DOMAIN failure: the job
      // succeeded at determining that the work will never complete.
      await this.pipeline.markFailed({
        transcriptId: transcript.id,
        reason:
          'The transcription provider reported that it could not transcribe this audio.',
        stage: 'transcription',
        retryable: true,
      });

      return;
    }

    if (status === 'completed') {
      await this.prisma.transcript.update({
        where: { id: transcript.id },
        data: { transcriptionStatus: 'completed', lastPolledAt: now },
      });

      this.logger.log(
        `Provider job ${transcript.providerJobId} is complete; queuing ingest for ` +
          `transcript ${transcript.id}`,
      );

      await this.pipeline.enqueueIngest(transcript.id);

      return;
    }

    // Still `queued` or `processing`. `processing` is the provider saying it is
    // actively transcribing, which is a different fact from `submitted` ("it
    // accepted the job") and is what the pipeline stepper distinguishes.
    await this.prisma.transcript.update({
      where: { id: transcript.id },
      data: {
        lastPolledAt: now,
        transcriptionStatus: status === 'processing' ? 'processing' : transcript.transcriptionStatus,
      },
    });

    const delayMs = nextPollDelayMs(readPollDelayMs(job.payload));

    this.logger.debug(
      `Provider job ${transcript.providerJobId} is ${status}; next check in ${delayMs}ms`,
    );

    // ⚠ `skipDedup: true` lives inside this call. See the file header.
    await this.pipeline.enqueuePoll(transcript.id, delayMs);
  }
}

/** "6 hours" / "9 hours", for the deadline message. */
function describeWindow(submittedAt: Date, durationMs: number | null): string {
  const windowMs = pollDeadline(submittedAt, durationMs).getTime() - submittedAt.getTime();
  const hours = Math.round(windowMs / 3_600_000);

  return `${hours} hour${hours === 1 ? '' : 's'}`;
}
