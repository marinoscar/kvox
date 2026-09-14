// =============================================================================
// `media.audio.transcode` (issue #26, epic #19, spec §1.5.1 / §7.1)
// =============================================================================
//
// Converts whatever was uploaded into a small, universally playable, SEEKABLE
// copy: mono AAC in an MP4 with the `moov` atom at the front. The original is
// never touched.
//
// -----------------------------------------------------------------------------
// NODE-ELIGIBLE, UNDER CLAUDE.md RULE 2, AND WITHOUT AN EXEMPTION TO CLAIM
// -----------------------------------------------------------------------------
//
// Rule 2 makes node-eligibility the DEFAULT posture and names three ways out
// of it: the work writes as it goes, it reads several tables mid-computation,
// or it needs a privilege a remote machine must never hold. This type has none
// of them. It reads ONE object through a presigned URL, burns CPU, and writes
// ONE file — there is no database access in the middle and no credential at
// all, so there is nothing for a `nodeSecretBroker` to broker and no reason to
// keep the work here. Its three siblings in this module (`transcription
// .submit`/`.poll`/`.ingest`) are server-only under rule 3 because they carry
// the provider API key; this one carries nothing.
//
// It is the SECOND real node-eligible type in this repository after
// `db.backup.run`, and the first that needs a native binary on both sides —
// `ffmpeg` (which ships `ffprobe`) in `apps/api/Dockerfile` and
// `apps/cli/Dockerfile`, and in `apps/cli/src/node/capabilities.ts` so a node
// without it reports itself ineligible instead of claiming work it cannot do.
//
// -----------------------------------------------------------------------------
// ⚠ ONE WRITE, TWO PATHS — AND WHAT EACH PATH IS ALLOWED TO DO
// -----------------------------------------------------------------------------
//
//   `process`            (in-process worker) probe → convert → upload → record
//   `persistNodeResult`  (a node did all three) parse → record
//
// The compute half differs. The persist half is `recordRendition`, called from
// both, so a transcript's row cannot depend on which executor happened to
// claim the job. `example-checksum.handler.ts` is the template's worked
// example of this shape and this file follows it deliberately.
//
// What `persistNodeResult` MUST NOT do is re-probe, re-convert, or "fix up" a
// number it dislikes. The moment the server recomputes, the node's answer is
// decorative and the reason for the node plane is gone. What it DOES do is
// confirm the object exists (`TranscriptObjectsService.recordUploaded`) —
// establishing that the bytes landed is not recomputing what is in them.
//
// -----------------------------------------------------------------------------
// WHAT HAPPENS WHEN A TRANSCODE PERMANENTLY FAILS
// -----------------------------------------------------------------------------
//
// `playback_status` must not be left at `processing`, and the reason is
// specific rather than tidiness: `transcription.submit` decides whether to
// keep waiting by reading `renditionExpected: playbackStatus is pending or
// processing`. A permanently failed transcode that never updates the column
// leaves every transcript whose original the provider cannot accept sitting in
// `waiting_input` forever, with no error anywhere to explain it. So the LAST
// attempt — known from `job.attempts` against this handler's own
// `maxAttempts`, since the queue charges an attempt at claim time — writes
// `playback_status: failed` before it rethrows, and fails the transcript too
// if transcription was waiting on this exact file.
// =============================================================================

import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job, Transcript } from '@prisma/client';
import { createReadStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';

import {
  type MediaAudioTranscodeResult,
  mediaAudioTranscodeResultSchema,
} from '../../jobs/contracts/media-audio-transcode.contract';
import type { JobExecutionProfile } from '../../jobs/job-execution-profile';
import { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { jobTempPath } from '../../jobs/job-temp';
import { PrismaService } from '../../prisma/prisma.service';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from '../../storage/providers/storage-provider.interface';
import { resolveStorageObjectInput } from '../../storage/storage-job-input';
import { TRANSCODE_JOB_TYPE } from '../job-types';
import {
  planTranscode,
  RENDITION_MIME_TYPE,
  RENDITION_OBJECT_NAME,
  renditionFacts,
  renditionStorageKey,
  resolveTargetBitrateKbps,
} from '../media/audio-transcode';
import { FfmpegService } from '../media/ffmpeg.service';
import { TranscriptObjectsService } from '../transcript-objects.service';
import {
  readTranscodeBitrateKbps,
  TranscriptPipelineService,
} from '../transcript-pipeline.service';
import { TranscriptionRuntimeService } from '../transcription-runtime.service';

/**
 * Three hours.
 *
 * Sized for the worst realistic case rather than the common one: a ten-hour
 * recording (the longest any provider in this build accepts) re-encoded on a
 * modest CPU from a source the encoder has to pull over HTTP. ⚠ IT IS ALSO THE
 * LEASE, indirectly — `resolveJobLeaseMs` derives the claim's lease from this
 * number, which is exactly why `job-execution-profile.ts` refuses to let a
 * handler declare a lease of its own that could disagree with it.
 */
export const TRANSCODE_MAX_RUNTIME_MS = 3 * 60 * 60 * 1000;

/**
 * Three attempts, the deployment default.
 *
 * The failures worth retrying here are transport-shaped: a presigned URL that
 * expired mid-read, a bucket that answered 503, a node that lost its lease
 * halfway. The failures that are NOT worth retrying — a file with no audio
 * stream, a container ffmpeg cannot demux — fail identically three times and
 * then stop, which costs two extra rows in the job history and buys the
 * simplicity of not having to classify ffmpeg's error strings.
 */
export const TRANSCODE_MAX_ATTEMPTS = 3;

/**
 * How long the presigned GET handed to `ffmpeg` is valid.
 *
 * ⚠ LONGER THAN THE STORAGE DEFAULT (one hour) BECAUSE THE ENCODER READS FOR
 * THE WHOLE RUN, not just at the start: ffmpeg pulls the source over HTTP as
 * it converts, so a URL that expires forty minutes into a two-hour recording
 * fails the job at the point where almost all the work has already been done.
 * Matched to the job's own runtime ceiling plus a margin, which is the only
 * number it can be consistent with.
 */
export const TRANSCODE_INPUT_URL_TTL_SECONDS = Math.round(TRANSCODE_MAX_RUNTIME_MS / 1000) + 600;

@Injectable()
export class MediaAudioTranscodeHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(MediaAudioTranscodeHandler.name);

  readonly type = TRANSCODE_JOB_TYPE;

  readonly profile: JobExecutionProfile = {
    maxRuntimeMs: TRANSCODE_MAX_RUNTIME_MS,
    maxAttempts: TRANSCODE_MAX_ATTEMPTS,
  };

  /**
   * THE FIRST OF THE TWO MEMBERS THAT MAKE THIS TYPE NODE-ELIGIBLE.
   *
   * In `jobs/contracts/` rather than inline because a second reader needs it:
   * `GET /api/nodes/job-types` publishes it as JSON Schema so `appctl`
   * validates a result against the SERVER's definition rather than a copy.
   */
  readonly nodeResultSchema = mediaAudioTranscodeResultSchema;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly ffmpeg: FfmpegService,
    private readonly objects: TranscriptObjectsService,
    private readonly pipeline: TranscriptPipelineService,
    private readonly runtime: TranscriptionRuntimeService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  // ===========================================================================
  // The server path
  // ===========================================================================

  /**
   * Probe, convert, upload, record — here, on the API server.
   *
   * A node is an OPTION, never a requirement: a deployment running no fleet,
   * or one that has turned `transcription.transcodeNodeOffloadEnabled` off,
   * must still be able to execute every type it enqueues. A handler that only
   * worked on a node would make the fleet mandatory, which is the opposite of
   * what node-eligible means.
   */
  async process(job: Job): Promise<void> {
    const transcript = await this.pipeline.loadForJob(job.payload);

    if (!transcript) {
      this.logger.log(`Transcode job ${job.id} names no live transcript; nothing to do`);

      return;
    }

    if (transcript.status === 'failed' || transcript.status === 'deleting') {
      this.logger.log(
        `Transcript ${transcript.id} is ${transcript.status}; transcode job ${job.id} is a no-op`,
      );

      return;
    }

    // Already done. The queue is at-least-once, so a job whose record committed
    // and whose acknowledgement did not is an ordinary event rather than a bug,
    // and re-encoding a three-hour recording to reach the same row would be an
    // expensive way to do nothing.
    if (transcript.playbackStatus === 'ready' && transcript.playbackObjectId) {
      this.logger.log(
        `Transcript ${transcript.id} already has playback object ${transcript.playbackObjectId}; ` +
          `transcode job ${job.id} is a no-op`,
      );

      return;
    }

    try {
      await this.runServerTranscode(job, transcript);
    } catch (error) {
      await this.onTranscodeError(job, transcript, error);

      throw error;
    }
  }

  /** The actual conversion. Separated so `process` owns only the failure policy. */
  private async runServerTranscode(job: Job, transcript: Transcript): Promise<void> {
    // Named failures, never an empty path — `storage-job-input.ts`'s header
    // records the production incident this resolver exists to prevent.
    const source = await resolveStorageObjectInput(this.prisma, job);

    // SIGNED WHEN THE JOB RUNS, not when it was enqueued: a job can sit
    // `pending` behind other work for minutes, and every one of those minutes
    // comes off the far end of the encoder's read window.
    const inputUrl = await this.storage.getSignedDownloadUrl(source.storageKey, {
      expiresIn: TRANSCODE_INPUT_URL_TTL_SECONDS,
    });

    const probe = await this.ffmpeg.probe(inputUrl);
    const plan = planTranscode(probe, await this.targetBitrateKbps(job));
    const storageKey = renditionStorageKey(transcript.id, job.id);

    // ⚠ A FILE, NOT A PIPE. `+faststart` rewrites the header after the stream
    // is finished and therefore needs a SEEKABLE output; ffmpeg silently
    // degrades to a `moov`-last file on a pipe, which is the one defect this
    // whole job exists to avoid. See `audio-transcode.ts`'s header.
    const output = jobTempPath('.m4a');

    try {
      await this.ffmpeg.transcode({ input: inputUrl, output, plan });

      const { size } = await stat(output);

      if (size <= 0) {
        throw new Error(
          `ffmpeg produced an empty rendition for transcript ${transcript.id}. The upload is ` +
            'most likely truncated or not decodable.',
        );
      }

      await this.storage.upload(storageKey, createReadStream(output), {
        mimeType: RENDITION_MIME_TYPE,
      });

      const facts = renditionFacts(probe, plan);

      await this.recordRendition(
        job,
        transcript,
        {
          bytes: size,
          durationMs: probe.durationMs,
          remuxed: plan.remux,
          ...facts,
        },
        'server',
      );
    } finally {
      // Best effort. `TempFileJanitorTask` is the safety net for a process that
      // never reaches this line, not a substitute for reaching it.
      await rm(output, { force: true }).catch(() => undefined);
    }
  }

  // ===========================================================================
  // The node path
  // ===========================================================================

  /**
   * Where a node must PUT this job's rendition.
   *
   * `transcripts/<transcriptId>/renditions/<jobId>.m4a` rather than the data
   * plane's default `node-outputs/<jobId>/<uuid>`, because the rendition is a
   * DURABLE, EXTERNALLY-REFERENCED artifact: `transcripts.playback_object_id`
   * points at it, and `transcript.purge` enumerates a transcript's own prefix
   * to remove every byte it ever owned. An object outside that prefix would
   * outlive the transcript it belongs to.
   *
   * Idempotent by construction — both inputs are fixed on the job row before
   * this can be called, so a node asking again after a timed-out transfer gets
   * the same key rather than orphaning the first upload.
   */
  async deriveOutputKey(job: Job): Promise<string> {
    const transcript = await this.pipeline.loadForJob(job.payload);

    if (!transcript) {
      throw new Error(
        `Transcode job ${job.id} names no live transcript, so there is nowhere to put a ` +
          'rendition.',
      );
    }

    return renditionStorageKey(transcript.id, job.id);
  }

  /**
   * THE SECOND MEMBER THAT MAKES THIS TYPE NODE-ELIGIBLE: writes down a
   * rendition a node produced and `nodeResultSchema` has already validated.
   *
   * ⚠ IT PARSES AGAIN, DELIBERATELY. The interface hands this method
   * `result: unknown` because the value came from off-machine, so narrowing is
   * the only way to touch a field at all — and re-parsing rather than casting
   * means a future caller that forgets to validate (a fork's own admin
   * "re-persist" tool, say) cannot write an arbitrary object into the database
   * through this method.
   */
  async persistNodeResult(job: Job, result: unknown): Promise<void> {
    const parsed: MediaAudioTranscodeResult = this.nodeResultSchema.parse(result);

    const transcript = await this.pipeline.loadForJob(job.payload);

    if (!transcript) {
      this.logger.warn(
        `A node returned a rendition for job ${job.id}, whose transcript is gone; ` +
          'nothing to record',
      );

      return;
    }

    await this.recordRendition(job, transcript, parsed, 'node');
  }

  /**
   * May a node do this work today?
   *
   * `transcription.transcodeNodeOffloadEnabled`, default TRUE — unlike
   * `databaseBackup.nodeOffloadEnabled`, which defaults false because a dump
   * needs a brokered database credential. Transcoding needs a presigned URL
   * and a CPU, so the trust question that switch answers does not arise here.
   *
   * ⚠ READ PER CLAIM, NOT CACHED. The value is an administrator's decision and
   * a cached copy is how "we turned node offload off" takes effect at some
   * unspecified later time. A read that FAILS returns `false`: withholding the
   * type falls back to the in-process worker, which is never worse than not
   * producing a rendition at all.
   */
  async nodeOffloadEnabled(): Promise<boolean> {
    try {
      const policy = await this.runtime.policy();

      return policy.transcodeNodeOffloadEnabled;
    } catch (error) {
      this.logger.warn(
        `Could not read transcription.transcodeNodeOffloadEnabled; withholding ${this.type} ` +
          'from the node plane and leaving the transcode to the in-process worker: ' +
          `${error instanceof Error ? error.message : String(error)}`,
      );

      return false;
    }
  }

  // ===========================================================================
  // The one write, shared by both paths
  // ===========================================================================

  /**
   * Record the rendition, measure the transcript, and unblock transcription.
   *
   * FOUR EFFECTS, IN THIS ORDER, AND THE ORDER IS THE DESIGN:
   *
   *  1. The managed `storage_objects` row, after a read-back check that the
   *     bytes are really in the bucket.
   *  2. `playback_object_id`, `playback_status: ready` and `duration_ms` on
   *     the transcript — the playback surface works from this moment on.
   *  3. The provider's `maxDurationMs`, enforced. A recording over the ceiling
   *     fails the TRANSCRIPT, never the rendition: the audio is still worth
   *     playing back, and this is the last moment where refusing costs nothing
   *     (the provider has not been asked to do anything yet, so the bill is
   *     still zero).
   *  4. `transcription.submit`, enqueued only when transcription was waiting
   *     for this exact file. A transcript already submitted against the
   *     original must not be submitted a second time.
   */
  private async recordRendition(
    job: Job,
    transcript: Transcript,
    result: MediaAudioTranscodeResult,
    producedBy: 'server' | 'node',
  ): Promise<void> {
    const storageKey = renditionStorageKey(transcript.id, job.id);

    const object = await this.objects.recordUploaded({
      storageKey,
      name: RENDITION_OBJECT_NAME,
      mimeType: RENDITION_MIME_TYPE,
      size: result.bytes,
      // The TRANSCRIPT's owner, never the account that happened to trigger the
      // job — a rendition belongs to whoever owns the recording.
      ownerId: transcript.ownerId,
      metadata: {
        transcriptId: transcript.id,
        jobId: job.id,
        producedBy,
        durationMs: result.durationMs,
        codec: result.codec,
        channels: result.channels,
        bitrateKbps: result.bitrateKbps,
        remuxed: result.remuxed,
      },
    });

    await this.prisma.transcript.update({
      where: { id: transcript.id },
      data: {
        playbackObjectId: object.id,
        playbackStatus: 'ready',
        // ⚠ `durationMs` IS WRITTEN EVEN WHEN ONE IS ALREADY THERE. The only
        // other writer is the provider's own `audio_duration` at ingest, which
        // cannot have run yet for a transcript still waiting on this file; a
        // measured duration from the file itself is the better number and a
        // stale one from an earlier, failed attempt is worth replacing.
        ...(result.durationMs > 0 ? { durationMs: result.durationMs } : {}),
      },
    });

    this.logger.log(
      `Transcript ${transcript.id} has a playback rendition: object ${object.id}, ` +
        `${result.bytes} bytes, ${result.durationMs} ms, ${result.codec} ` +
        `${result.channels}ch @ ${result.bitrateKbps}k, ` +
        `${result.remuxed ? 'remuxed' : 're-encoded'} by the ${producedBy}`,
    );

    if (await this.failIfTooLong(transcript, result.durationMs)) return;

    // Re-read rather than trusting the copy loaded at the top of the job: the
    // transcode may have run for an hour, and `transcription_status` is
    // exactly the kind of field that moves while it does.
    const current = await this.prisma.transcript.findUnique({
      where: { id: transcript.id },
      select: { transcriptionStatus: true, status: true },
    });

    if (current?.transcriptionStatus !== 'waiting_input' || current.status !== 'processing') {
      return;
    }

    this.logger.log(
      `Transcript ${transcript.id} was waiting for this rendition; queueing submission`,
    );

    await this.pipeline.enqueueSubmit(transcript.id);
  }

  /**
   * Refuse a recording the active provider will not take, with a reason a
   * person can act on.
   *
   * Returns `true` when the transcript was failed, so the caller stops.
   *
   * ⚠ ENFORCED HERE AND AGAIN IN `transcription.submit`, ON PURPOSE. This is
   * the FIRST moment the duration is known — nothing measured it before the
   * probe — and the submit handler's own check covers the transcripts that
   * never needed a rendition at all. Neither one subsumes the other, and a
   * ceiling checked in only one of the two places is a ceiling half the
   * transcripts walk past.
   */
  private async failIfTooLong(transcript: Transcript, durationMs: number): Promise<boolean> {
    if (durationMs <= 0) return false;

    const active = await this.runtime.activeProvider();

    if (!active || durationMs <= active.provider.capabilities.maxDurationMs) return false;

    await this.pipeline.markFailed({
      transcriptId: transcript.id,
      reason:
        `This recording is ${Math.round(durationMs / 60_000)} minutes long, above the ` +
        `${Math.round(active.provider.capabilities.maxDurationMs / 60_000)}-minute limit ` +
        `${active.provider.label} accepts. The audio is still available to play back.`,
      stage: 'transcription',
      retryable: false,
    });

    return true;
  }

  // ===========================================================================
  // Failure policy
  // ===========================================================================

  /**
   * What a thrown transcode leaves behind.
   *
   * Nothing at all, until the LAST attempt — a retryable failure must not
   * write `playback_status: failed`, because the next attempt may well
   * succeed and a status that flapped would be read by `transcription.submit`
   * as "no rendition is coming" at exactly the wrong moment.
   *
   * `job.attempts` is charged AT CLAIM TIME (see `job-claim.service.ts`), so a
   * job inside `process` always sees its own attempt already counted and
   * `attempts >= maxAttempts` is the honest test for "this is the last one".
   * This also holds for a process that is killed outright: the attempt is
   * already spent, so the budget still bounds the retries even though this
   * method never runs.
   *
   * ⚠ IT NEVER THROWS. It runs inside a `catch` whose job is to rethrow the
   * REAL error; an exception raised here would replace a message naming the
   * actual ffmpeg failure with one about a database write.
   */
  private async onTranscodeError(job: Job, transcript: Transcript, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);

    if (job.attempts < TRANSCODE_MAX_ATTEMPTS) {
      this.logger.warn(
        `Transcode of transcript ${transcript.id} failed on attempt ${job.attempts} of ` +
          `${TRANSCODE_MAX_ATTEMPTS} and will be retried: ${message}`,
      );

      return;
    }

    try {
      await this.prisma.transcript.updateMany({
        where: { id: transcript.id, playbackStatus: { in: ['pending', 'processing'] } },
        data: { playbackStatus: 'failed' },
      });

      const current = await this.prisma.transcript.findUnique({
        where: { id: transcript.id },
        select: { transcriptionStatus: true },
      });

      // Transcription was waiting for THIS file, which means the original was
      // not usable — so there is nothing left to transcribe and the transcript
      // has to be failed rather than left in `waiting_input` forever.
      if (current?.transcriptionStatus === 'waiting_input') {
        await this.pipeline.markFailed({
          transcriptId: transcript.id,
          reason:
            'This recording could not be converted into a format the transcription provider ' +
            `accepts. The upload itself is intact and can be downloaded. (${message})`,
          stage: 'transcode',
        });
      }
    } catch (secondary) {
      this.logger.error(
        `Could not record the permanent transcode failure for transcript ${transcript.id}: ` +
          `${secondary instanceof Error ? secondary.message : String(secondary)}`,
      );
    }
  }

  /**
   * The target bitrate for this job, in kbit/s.
   *
   * ⚠ THE PAYLOAD WINS OVER THE CURRENT SETTING, and the reason is the whole
   * point of putting it there: a worker node cannot read settings, so the
   * number on the job is what a node-executed transcode uses. If the server
   * path read the live setting instead, the same job would produce a different
   * file depending on which executor claimed it — and an administrator who
   * changed the setting mid-flight would get a queue of renditions encoded at
   * two different rates with nothing recording which was which.
   *
   * The settings read is the fallback for a job enqueued by a build older than
   * issue #26, which carries no `bitrateKbps` at all.
   */
  private async targetBitrateKbps(job: Job): Promise<number> {
    const declared = readTranscodeBitrateKbps(job.payload);

    if (declared !== null) return resolveTargetBitrateKbps(declared);

    try {
      const policy = await this.runtime.policy();

      return resolveTargetBitrateKbps(policy.playback.bitrateKbps);
    } catch (error) {
      this.logger.warn(
        'Could not read transcription.playback.bitrateKbps; using the default: ' +
          `${error instanceof Error ? error.message : String(error)}`,
      );

      return resolveTargetBitrateKbps(undefined);
    }
  }
}
