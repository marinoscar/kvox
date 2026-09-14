// =============================================================================
// `transcription.submit` (issue #25, epic #19, spec §1.5.2)
// =============================================================================
//
// Hands the audio to the provider and records the handle it returns.
//
// -----------------------------------------------------------------------------
// SERVER-ONLY, UNDER CLAUDE.md RULE 3 — AND THE REASON IS SPECIFIC
// -----------------------------------------------------------------------------
//
// Rule 2 makes node-eligibility the DEFAULT posture, so a server-only type owes
// an argument. This one's is rule 3: every provider call authenticates with an
// API key that `CredentialsService` holds encrypted at `(purpose:
// 'transcription', name: <providerId>)`, and that key is LONG-LIVED AND
// ACCOUNT-LEVEL. Unlike `db.backup.run`'s PostgreSQL role — which
// `PgJobRoleBroker` mints per job, scopes to SELECT, and expires with the lease
// — AssemblyAI publishes no API for minting a job-scoped sub-key, so there is
// nothing a `nodeSecretBroker` could broker even if one existed. A node holding
// this key would hold the same account-wide access the API server has,
// indefinitely, on a machine this deployment may not fully control. So this
// handler carries neither `nodeResultSchema` nor `persistNodeResult`, which is
// what `JobHandlerRegistry.serverOnlyTypes()` reads.
//
// -----------------------------------------------------------------------------
// TWO PROPERTIES THIS HANDLER EXISTS TO GET RIGHT
// -----------------------------------------------------------------------------
//
// 1. IT IS IDEMPOTENT ON `provider_job_id`. A process killed between the
//    provider's 200 and this job's own terminal write leaves a remote job
//    nobody is polling; the retry must find it rather than submit a SECOND one
//    and pay for the same audio twice. So `provider_job_id` is written the
//    INSTANT the provider accepts, before anything else, and re-read at the
//    top of every attempt.
//
// 2. THE INPUT URL IS SIGNED WHEN THE JOB RUNS, NOT WHEN IT IS ENQUEUED. A job
//    can sit `pending` behind other work for minutes; a URL signed at enqueue
//    time is that much closer to expiry by the time the provider actually
//    starts reading bytes, and the failure arrives hours later as an opaque
//    403 on the vendor's side that this application never sees.
// =============================================================================

import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job } from '@prisma/client';

import { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import type { JobExecutionProfile } from '../../jobs/job-execution-profile';
import { ProviderThrottleService } from '../../jobs/provider-throttle.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from '../../storage/providers/storage-provider.interface';
import { isTerminalProviderError, ProviderAuthError } from '../../transcription/errors';
import type { TranscriptionAudioSource } from '../../transcription/providers/transcription-provider.interface';
import {
  TRANSCRIPTION_SUBMIT_JOB_TYPE,
  TRANSCRIPTION_THROTTLE_KEY,
} from '../job-types';
import { TranscriptPipelineService } from '../transcript-pipeline.service';
import { selectTranscriptionInput } from '../transcription-input';
import { TranscriptionRuntimeService } from '../transcription-runtime.service';

/**
 * Two hours.
 *
 * Not a target — a submission that takes two hours is a deployment with a
 * problem — but the point past which "still uploading to the provider" stops
 * being a credible explanation. It is generous because `upload` delivery mode
 * (§2.6) relays the whole file through this process, and a 5 GB relay on a
 * modest uplink legitimately takes a long time. ⚠ It is also the LEASE,
 * indirectly: `resolveJobLeaseMs` derives the claim's lease from this number.
 */
export const SUBMIT_MAX_RUNTIME_MS = 2 * 60 * 60 * 1000;

@Injectable()
export class TranscriptionSubmitHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(TranscriptionSubmitHandler.name);

  readonly type = TRANSCRIPTION_SUBMIT_JOB_TYPE;

  /**
   * Three attempts, on the deployment default, because the failures worth
   * retrying here are network-shaped. Everything that is NOT worth retrying —
   * a bad key, a file the provider rejects — is a domain failure that returns
   * normally and never reaches the retry budget at all.
   */
  readonly profile: JobExecutionProfile = {
    maxRuntimeMs: SUBMIT_MAX_RUNTIME_MS,
    maxAttempts: 3,
  };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly runtime: TranscriptionRuntimeService,
    private readonly pipeline: TranscriptPipelineService,
    private readonly throttle: ProviderThrottleService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);

    // ONE BUCKET FOR THREE TYPES. Submit, poll and ingest all authenticate as
    // the same account against the same vendor, so a 429 discovered by any one
    // of them is evidence the other two will be throttled too.
    this.throttle.registerProviderKey(this.type, TRANSCRIPTION_THROTTLE_KEY);
  }

  async process(job: Job): Promise<void> {
    const transcript = await this.pipeline.loadForJob(job.payload);

    if (!transcript) {
      this.logger.log(`Submit job ${job.id} names no live transcript; nothing to do`);

      return;
    }

    if (transcript.status === 'failed' || transcript.status === 'deleting') {
      this.logger.log(
        `Transcript ${transcript.id} is ${transcript.status}; submit job ${job.id} is a no-op`,
      );

      return;
    }

    if (transcript.transcriptionStatus === 'cancelled') {
      this.logger.log(
        `Transcript ${transcript.id} was cancelled; submit job ${job.id} is a no-op`,
      );

      return;
    }

    // -------------------------------------------------------------------------
    // Idempotency. See property 1 in the file header.
    // -------------------------------------------------------------------------
    if (transcript.providerJobId) {
      this.logger.log(
        `Transcript ${transcript.id} already has provider job ${transcript.providerJobId}; ` +
          'skipping submission and going straight to polling',
      );

      await this.pipeline.enqueueFirstPoll(transcript.id, transcript.durationMs);

      return;
    }

    let resolved;

    try {
      resolved = await this.runtime.resolve();
    } catch (error) {
      // An unconfigured deployment is a `ProviderAuthError` — a DOMAIN failure
      // that fails the transcript on the FIRST attempt rather than reading the
      // same settings row three times to reach the same conclusion.
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

    const { provider, ctx, policy } = resolved;

    // -------------------------------------------------------------------------
    // Which file? Re-decided HERE, not trusted from the listener — the job may
    // have waited while a rendition finished, and pointing the provider at a
    // decision made minutes ago is a decision made against stale state.
    // -------------------------------------------------------------------------
    const [source, rendition] = await Promise.all([
      this.prisma.storageObject.findUnique({ where: { id: transcript.sourceObjectId } }),
      transcript.playbackObjectId
        ? this.prisma.storageObject.findUnique({ where: { id: transcript.playbackObjectId } })
        : Promise.resolve(null),
    ]);

    if (!source) {
      await this.pipeline.markFailed({
        transcriptId: transcript.id,
        reason:
          'The uploaded audio is no longer in storage. An incomplete upload is cleaned up ' +
          'automatically after a few days of inactivity.',
        stage: 'upload',
        retryable: false,
      });

      return;
    }

    const selection = selectTranscriptionInput({
      capabilities: provider.capabilities,
      audioDelivery: policy.audioDelivery,
      original: {
        id: source.id,
        mimeType: source.mimeType,
        size: Number(source.size),
      },
      rendition:
        rendition && transcript.playbackStatus === 'ready'
          ? {
              id: rendition.id,
              mimeType: rendition.mimeType,
              size: Number(rendition.size),
            }
          : null,
      // A transcode that already failed is never coming, and neither is one in
      // a build with no handler for it.
      renditionExpected:
        transcript.playbackStatus === 'pending' || transcript.playbackStatus === 'processing',
    });

    if (selection.kind === 'impossible') {
      await this.pipeline.markFailed({
        transcriptId: transcript.id,
        reason: `This audio cannot be transcribed: ${selection.reason}.`,
        stage: 'transcription',
        retryable: false,
      });

      return;
    }

    if (selection.kind === 'wait') {
      // NOT A FAILURE, AND NOT A RETRY. `media.audio.transcode`'s own
      // completion is what enqueues the next `transcription.submit`; a job that
      // threw here would spend an attempt waiting for something no retry can
      // hurry along.
      this.logger.log(
        `Transcript ${transcript.id} is waiting for input: ${selection.reason}`,
      );

      await this.prisma.transcript.updateMany({
        where: { id: transcript.id, status: 'processing' },
        data: { transcriptionStatus: 'waiting_input' },
      });

      return;
    }

    const chosen =
      selection.kind === 'rendition' ? rendition : source;

    // Defensive: `selection` names an id both branches above already resolved.
    if (!chosen || chosen.id !== selection.objectId) {
      throw new Error(
        `Selected input ${selection.objectId} for transcript ${transcript.id} is not loaded`,
      );
    }

    await this.prisma.transcript.update({
      where: { id: transcript.id },
      data: { transcriptionStatus: 'submitting' },
    });

    // -------------------------------------------------------------------------
    // Deliver the audio. Two modes, and the API relays bytes in exactly one of
    // them — see spec §2.6 for why `upload` exists and why it is not default.
    // -------------------------------------------------------------------------
    let audio: TranscriptionAudioSource;

    if (policy.audioDelivery === 'upload') {
      audio = {
        kind: 'stream',
        stream: await this.storage.download(chosen.storageKey),
        size: Number(chosen.size),
        mimeType: chosen.mimeType,
      };
    } else {
      // SIGNED NOW. See property 2 in the file header.
      audio = {
        kind: 'url',
        url: await this.storage.getSignedDownloadUrl(chosen.storageKey, {
          expiresIn: policy.presignedUrlTtlMinutes * 60,
        }),
      };
    }

    const language = transcript.language ?? policy.defaultLanguage ?? null;

    try {
      const { remoteId } = await provider.submit(ctx, {
        audio,
        options: {
          language,
          // MUTUALLY EXCLUSIVE WITH `language` in practice: a provider told
          // both has to pick one, so the choice is made here rather than left
          // to whichever branch the vendor's client happens to take.
          detectLanguage: language === null,
          speakersExpected: readSpeakersExpected(transcript.providerOptions),
        },
      });

      // ⚠ WRITTEN IMMEDIATELY, before anything else can throw. See property 1.
      await this.prisma.transcript.update({
        where: { id: transcript.id },
        data: {
          providerJobId: remoteId,
          provider: provider.id,
          transcriptionStatus: 'submitted',
          submittedAt: new Date(),
          failureReason: null,
        },
      });

      this.logger.log(
        `Transcript ${transcript.id} submitted to ${provider.id} as ${remoteId} ` +
          `(${selection.kind}: ${selection.reason})`,
      );
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

      // RateLimitError and everything else: rethrow. The queue defers a 429
      // through the shared throttle key without spending an attempt, and
      // charges an attempt for anything it does not recognise.
      throw error;
    }

    await this.pipeline.enqueueFirstPoll(transcript.id, transcript.durationMs);
  }
}

/**
 * `speakersExpected` out of `transcripts.provider_options`.
 *
 * TOTAL OVER GARBAGE, for the same reason `readTranscriptId` is: the column is
 * JSONB written by a possibly-older build, and a hint nobody can read is
 * "no opinion" rather than a crash on the vendor call.
 */
export function readSpeakersExpected(options: unknown): number | null {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    return null;
  }

  const value = (options as Record<string, unknown>).speakersExpected;

  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}
