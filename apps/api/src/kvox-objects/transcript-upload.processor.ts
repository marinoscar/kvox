// =============================================================================
// TranscriptUploadProcessor (issue #469, replaces TranscriptsUploadListener)
// =============================================================================
//
// The bridge between "the audio finished uploading" and "the pipeline starts".
// The platform storage slice runs every registered `ObjectProcessor` in its
// server-only `storage.object.process` job once an upload completes; this one
// is the transcripts module's half of that contract.
//
// -----------------------------------------------------------------------------
// IT ONLY ENQUEUES. IT NEVER DOWNLOADS AND NEVER CALLS THE PROVIDER.
// -----------------------------------------------------------------------------
//
// `getStream` is deliberately unused. Submitting to a transcription provider
// from here would put a multi-minute network call inside a processor run, with
// no job row of its own, no timeout of its own and no retry: queue rule 1.
// Two status writes and up to two `enqueue` calls. Nothing else.
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
// `canProcess` accepts every audio and video upload in the application, and
// most of them have nothing to do with transcripts (a note's source file, a
// generic upload). Ownership decides: `KvoxManagedObjects.managedBy` answers
// from the `kvox_object_ownership` side table, and anything not owned by
// `transcripts` returns `{ success: true, metadata: { skipped: true } }`
// quietly.
//
// -----------------------------------------------------------------------------
// A FAILURE IS RECORDED, NOT THROWN
// -----------------------------------------------------------------------------
//
// The platform records a processor's failure on the object row and moves on;
// it does not retry the job. So an error here marks the transcript failed
// (best effort) and reports `success: false`. A transcript this processor
// could not even read stays `uploading` with a `failed` source object, which
// `transcripts.housekeeping` reconciles into `failed / upload_aborted`.
// =============================================================================

import type { Readable } from 'node:stream';

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  ObjectProcessorRegistry,
  type ObjectProcessor,
  type ObjectProcessorResult,
  type StorageObject,
} from '@marinoscar/platform-api/storage';

import { PrismaService } from '../prisma/prisma.service';
import { TRANSCRIPTS_MANAGED_BY } from '../transcripts/job-types';
import { TranscriptPipelineService } from '../transcripts/transcript-pipeline.service';
import { selectTranscriptionInput } from '../transcripts/transcription-input';
import { TranscriptionRuntimeService } from '../transcripts/transcription-runtime.service';
import { KvoxManagedObjectsService } from './kvox-managed-objects.service';

/** The registered processor name; it is recorded in the object's metadata. */
export const TRANSCRIPT_UPLOAD_PROCESSOR_NAME = 'kvox.transcripts.source';

@Injectable()
export class TranscriptUploadProcessor implements ObjectProcessor, OnModuleInit {
  private readonly logger = new Logger(TranscriptUploadProcessor.name);

  readonly name = TRANSCRIPT_UPLOAD_PROCESSOR_NAME;

  readonly priority = 100;

  constructor(
    private readonly registry: ObjectProcessorRegistry,
    private readonly prisma: PrismaService,
    private readonly managed: KvoxManagedObjectsService,
    private readonly pipeline: TranscriptPipelineService,
    private readonly runtime: TranscriptionRuntimeService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  /** Audio and video only: a transcript's source is one of the two. */
  canProcess(object: StorageObject): boolean {
    const mimeType = (object.mimeType ?? '').toLowerCase();

    return mimeType.startsWith('audio/') || mimeType.startsWith('video/');
  }

  /** `_getStream` is the contract's byte accessor; this processor never reads bytes. */
  async process(
    object: StorageObject,
    _getStream: () => Promise<Readable>,
  ): Promise<ObjectProcessorResult> {
    const owners = await this.managed.managedBy([object.id]);

    // Not a transcript's audio. See the file header.
    if (owners.get(object.id) !== TRANSCRIPTS_MANAGED_BY) {
      return { success: true, metadata: { skipped: true } };
    }

    try {
      const started = await this.start(object);

      return { success: true, metadata: { started } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.error(
        `Could not start the transcript pipeline for object ${object.id}: ${message}`,
      );

      await this.failTranscript(object.id);

      return { success: false, error: message };
    }
  }

  /**
   * Promotes the transcript and starts the pipeline.
   *
   * @returns whether this run started it (false: no transcript, already
   *   promoted, or the pipeline was ended by a domain failure).
   */
  private async start(object: StorageObject): Promise<boolean> {
    const transcript = await this.prisma.transcript.findFirst({
      where: { sourceObjectId: object.id, deletedAt: null },
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
      original: { id: object.id, mimeType: object.mimeType, size: Number(object.size) },
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
