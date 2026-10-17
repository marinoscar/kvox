// =============================================================================
// TranscriptUploadHook (issue #469, replaces TranscriptsUploadListener; a port
// subscription since issue #493, epic #491)
// =============================================================================
//
// The bridge between "the audio finished uploading" and "the pipeline starts".
// It subscribes to the object-store port's `onUploaded` hook (the web edition
// fans the platform storage slice's per-object `storage.object.process` job out to
// it) and to `onAborted`, which fails a transcript whose upload was cancelled.
//
// -----------------------------------------------------------------------------
// IT ONLY ENQUEUES. IT NEVER DOWNLOADS AND NEVER CALLS THE PROVIDER.
// -----------------------------------------------------------------------------
//
// Submitting to a transcription provider from here would put a multi-minute
// network call inside an upload handler, with no job row of its own, no timeout of
// its own and no retry: queue rule 1. Two status writes and up to two `enqueue`
// calls. Nothing else.
//
// -----------------------------------------------------------------------------
// THE TWO SUB-PIPELINES START INDEPENDENTLY, AND MAY RACE
// -----------------------------------------------------------------------------
//
// `media.audio.transcode` runs for PLAYBACK (a small, seekable rendition) and
// `transcription.submit` runs for TEXT. When the provider accepts the original
// directly (the common case) both start immediately and race to completion;
// when it does not, transcription waits in `waiting_input` and the transcode
// completion starts it. That concurrency is why `playback_status` and
// `transcription_status` are separate fields (spec section 1.4).
//
// -----------------------------------------------------------------------------
// AN OBJECT THAT IS NOT A TRANSCRIPT'S SOURCE IS NOT AN ERROR
// -----------------------------------------------------------------------------
//
// The hook hears every completed upload in the application, and most of them have
// nothing to do with transcripts (a note's source file, a generic upload). The
// event's `managedBy` decides, and anything not owned by `transcripts` returns
// quietly.
//
// -----------------------------------------------------------------------------
// A FAILURE IS RECORDED, NOT THROWN
// -----------------------------------------------------------------------------
//
// The host records a hook's failure in its log and moves on; it does not retry.
// So an error here marks the transcript failed (best effort) and does not
// rethrow. A transcript this hook could not even read stays `uploading`, which
// `transcripts.housekeeping` reconciles into `failed / upload_aborted` when its
// source object failed.
// =============================================================================

import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';

import {
  KVOX_OBJECT_STORE,
  KVOX_PRISMA,
  type KvoxAbortedEvent,
  type KvoxObjectStorePort,
  type KvoxUploadedEvent,
} from '../ports/index.js';
import type { KvoxTranscriptsDb } from './data/transcripts-db.js';
import { TRANSCRIPT_SOURCE_CONTENT_TYPES, TRANSCRIPTS_MANAGED_BY } from './job-types.js';
import { TranscriptPipelineService } from './transcript-pipeline.service.js';
import { selectTranscriptionInput } from './transcription-input.js';
import { TranscriptionRuntimeService } from './transcription-runtime.service.js';

/** The failure reason an aborted upload leaves on its transcript (the housekeeping reconcile's too). */
export const UPLOAD_ABORTED_REASON = 'upload_aborted';

/**
 * TranscriptUploadHook: wiring the slice registers itself; a host configures it through `TranscriptsModule.forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class TranscriptUploadHook implements OnModuleInit {
  private readonly logger = new Logger(TranscriptUploadHook.name);

  constructor(
    @Inject(KVOX_OBJECT_STORE) private readonly store: KvoxObjectStorePort,
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxTranscriptsDb,
    private readonly pipeline: TranscriptPipelineService,
    private readonly runtime: TranscriptionRuntimeService,
  ) {}

  onModuleInit(): void {
    // Only audio and video can be a transcript's source: a host that runs one processing job per
    // completed upload queues none for any other file.
    this.store.onUploaded((event) => this.handleUploaded(event), { contentTypes: TRANSCRIPT_SOURCE_CONTENT_TYPES });
    this.store.onAborted((event) => this.handleAborted(event));
  }

  /** A completed upload: start the pipeline when the object is a transcript's source. */
  async handleUploaded(event: KvoxUploadedEvent): Promise<void> {
    if (event.managedBy !== TRANSCRIPTS_MANAGED_BY) return;

    try {
      await this.start(event.objectId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.error(`Could not start the transcript pipeline for object ${event.objectId}: ${message}`);

      await this.failTranscript(event.objectId);
    }
  }

  /** A cancelled upload: the transcript waiting for it can never complete. */
  async handleAborted(event: KvoxAbortedEvent): Promise<void> {
    if (event.managedBy !== TRANSCRIPTS_MANAGED_BY) return;

    // Conditional on `uploading`, like the housekeeping reconcile (same reason string), so
    // it changes nothing for a transcript already promoted or failed.
    const failed = await this.prisma.transcript.updateMany({
      where: { sourceObjectId: event.objectId, deletedAt: null, status: 'uploading' },
      data: { status: 'failed', failureReason: UPLOAD_ABORTED_REASON },
    });

    if (failed.count > 0) {
      this.logger.log(`The upload of object ${event.objectId} was aborted; its transcript is marked failed`);
    }
  }

  /**
   * Promotes the transcript and starts the pipeline.
   *
   * @returns whether this run started it (false: no transcript, already
   *   promoted, or the pipeline was ended by a domain failure).
   */
  private async start(objectId: string): Promise<boolean> {
    const object = (await this.store.describe([objectId])).get(objectId);

    if (!object) return false;

    const transcript = await this.prisma.transcript.findFirst({
      where: { sourceObjectId: objectId, deletedAt: null },
    });

    if (!transcript) return false;

    if (transcript.status !== 'uploading') {
      this.logger.log(
        `Transcript ${transcript.id} is already ${transcript.status}; processing object ` +
          `${object.id} changes nothing`,
      );

      return false;
    }

    // CONDITIONAL ON `uploading`, so a duplicated run (a retried completion
    // raises a second processing job) promotes the row exactly once. `count`
    // says which call won.
    const promoted = await this.prisma.transcript.updateMany({
      where: { id: transcript.id, status: 'uploading' },
      data: { status: 'processing' },
    });

    if (promoted.count === 0) {
      this.logger.log(
        `Transcript ${transcript.id} was promoted by another run; this one is a no-op`,
      );

      return false;
    }

    const promotedTranscript = { ...transcript, status: 'processing' as const };

    // Playback. Guarded until the handler is registered, see
    // `TranscriptPipelineService.enqueueTranscode`.
    const transcodeQueued = await this.pipeline.enqueueTranscode(promotedTranscript);

    const active = await this.runtime.activeProvider();

    if (!active) {
      // Transcription was available when `POST /api/transcripts` accepted this
      // upload, so getting here means an administrator turned it off while a
      // multi-gigabyte file was uploading. The audio is safe and the playback
      // rendition still runs; only the text is unavailable.
      await this.pipeline.markFailed({
        transcriptId: transcript.id,
        reason:
          'Transcription is no longer configured for this deployment. An administrator can ' +
          'set it up again, and this recording can then be retried.',
        stage: 'transcription',
      });

      return false;
    }

    const selection = selectTranscriptionInput({
      capabilities: active.provider.capabilities,
      audioDelivery: active.policy.audioDelivery,
      // The processor is handed the row, so there is no second read.
      original: { id: object.id, mimeType: object.mimeType, size: object.size },
      // Nothing has been transcoded yet. A rendition only enters the decision
      // on the SECOND call, inside `transcription.submit` itself.
      rendition: null,
      renditionExpected: transcodeQueued,
    });

    if (selection.kind === 'original') {
      this.logger.log(
        `Transcript ${transcript.id}: submitting the original to ${active.provider.id} ` +
          `(${selection.reason})`,
      );

      await this.pipeline.enqueueSubmit(transcript.id);

      return true;
    }

    if (selection.kind === 'impossible') {
      await this.pipeline.markFailed({
        transcriptId: transcript.id,
        reason: `This audio cannot be transcribed: ${selection.reason}.`,
        stage: 'transcription',
        retryable: false,
      });

      return false;
    }

    // `wait`; `rendition` cannot happen here, because none exists yet.
    this.logger.log(`Transcript ${transcript.id} is waiting for input: ${selection.reason}`);

    await this.prisma.transcript.update({
      where: { id: transcript.id },
      data: { transcriptionStatus: 'waiting_input' },
    });

    return true;
  }

  /** Best effort: a transcript must not sit in `processing` with no job behind it. */
  private async failTranscript(objectId: string): Promise<void> {
    try {
      const transcript = await this.prisma.transcript.findFirst({
        where: { sourceObjectId: objectId, deletedAt: null },
        select: { id: true },
      });

      if (!transcript) return;

      await this.pipeline.markFailed({
        transcriptId: transcript.id,
        reason: 'The recording could not be handed to the transcription pipeline.',
        stage: 'upload',
      });
    } catch (error) {
      this.logger.error(
        `Could not mark the transcript for object ${objectId} failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
