// =============================================================================
// TranscriptsUploadListener (issue #25, epic #19, spec §1.5)
// =============================================================================
//
// The bridge between "the audio finished uploading" and "the pipeline starts".
//
// -----------------------------------------------------------------------------
// ⚠ IT ONLY ENQUEUES. IT NEVER CALLS THE PROVIDER.
// -----------------------------------------------------------------------------
//
// CLAUDE.md rule 1 covers `@OnEvent` bodies explicitly ("an `@OnEvent` body
// that downloads or spawns" is named as a violation), and it is the exact
// mistake this listener would otherwise be: submitting to a transcription
// provider from here would put a multi-minute network call inside an event
// handler with no job row, no timeout, no retry, no visibility in
// `GET /api/admin/jobs`, and nothing to recover it if the process died
// mid-call. The spec's own "Alternatives considered" rejects an
// `ObjectProcessor` that calls the provider inline for the same reason.
//
// So: two status writes and up to two `enqueue` calls. Nothing else.
//
// -----------------------------------------------------------------------------
// THE TWO SUB-PIPELINES START INDEPENDENTLY, AND MAY RACE
// -----------------------------------------------------------------------------
//
// `media.audio.transcode` runs for PLAYBACK — a small, seekable rendition —
// and `transcription.submit` runs for TEXT. When the provider accepts the
// original directly (the common case), both start immediately and race each
// other to completion; when it does not, transcription waits in
// `waiting_input` and #26's transcode completion is what starts it. That
// concurrency is why `playback_status` and `transcription_status` are separate
// fields rather than two values of one enum (spec §1.4).
//
// -----------------------------------------------------------------------------
// AN OBJECT THAT IS NOT A TRANSCRIPT'S SOURCE IS NOT AN ERROR
// -----------------------------------------------------------------------------
//
// `OBJECT_UPLOADED_EVENT` fires for every completed upload in this
// application, most of which have nothing to do with transcripts. A lookup
// that finds nothing returns quietly; it does not log a warning, because on a
// deployment that also stores documents the warning would be the majority of
// the log.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { PrismaService } from '../../prisma/prisma.service';
import {
  OBJECT_UPLOADED_EVENT,
  ObjectUploadedEvent,
} from '../../storage/processing/events/object-uploaded.event';
import { TranscriptPipelineService } from '../transcript-pipeline.service';
import { selectTranscriptionInput } from '../transcription-input';
import { TranscriptionRuntimeService } from '../transcription-runtime.service';

@Injectable()
export class TranscriptsUploadListener {
  private readonly logger = new Logger(TranscriptsUploadListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pipeline: TranscriptPipelineService,
    private readonly runtime: TranscriptionRuntimeService,
  ) {}

  @OnEvent(OBJECT_UPLOADED_EVENT)
  async handleObjectUploaded(event: ObjectUploadedEvent): Promise<void> {
    try {
      await this.start(event);
    } catch (error) {
      // ⚠ CONTAINED. An event listener that throws produces an unhandled
      // rejection, and an unhandled rejection terminates the process by
      // default — so a damaged transcript row must not be able to take the API
      // down on somebody else's upload. `transcripts.housekeeping` is what
      // notices a transcript this listener failed to promote.
      this.logger.error(
        `Could not start the transcript pipeline for object ${event.objectId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async start(event: ObjectUploadedEvent): Promise<void> {
    const transcript = await this.prisma.transcript.findFirst({
      where: { sourceObjectId: event.objectId, deletedAt: null },
    });

    // Not a transcript's audio. See the file header.
    if (!transcript) return;

    if (transcript.status !== 'uploading') {
      this.logger.log(
        `Transcript ${transcript.id} is already ${transcript.status}; the upload event for ` +
          `object ${event.objectId} changes nothing`,
      );

      return;
    }

    // ⚠ CONDITIONAL ON `uploading`, so a duplicated event — the emitter offers
    // no exactly-once guarantee, and a retried `completeUpload` would raise a
    // second one — promotes the row exactly once. `count` says which call won.
    const promoted = await this.prisma.transcript.updateMany({
      where: { id: transcript.id, status: 'uploading' },
      data: { status: 'processing' },
    });

    if (promoted.count === 0) {
      this.logger.log(
        `Transcript ${transcript.id} was promoted by another handler; this event is a no-op`,
      );

      return;
    }

    const promotedTranscript = { ...transcript, status: 'processing' as const };

    // -------------------------------------------------------------------------
    // Playback. Guarded until #26 registers the handler — see
    // `TranscriptPipelineService.enqueueTranscode`.
    // -------------------------------------------------------------------------
    const transcodeQueued = await this.pipeline.enqueueTranscode(promotedTranscript);

    // -------------------------------------------------------------------------
    // Transcription.
    // -------------------------------------------------------------------------
    const active = await this.runtime.activeProvider();

    if (!active) {
      // Transcription was available when `POST /api/transcripts` accepted this
      // upload — that is a 409 otherwise — so getting here means an
      // administrator turned it off or removed the provider while a
      // multi-gigabyte file was uploading. The audio is safe and the playback
      // rendition still runs; only the text is unavailable.
      await this.pipeline.markFailed({
        transcriptId: transcript.id,
        reason:
          'Transcription is no longer configured for this deployment. An administrator can ' +
          'set it up again, and this recording can then be retried.',
        stage: 'transcription',
      });

      return;
    }

    const source = await this.prisma.storageObject.findUnique({
      where: { id: transcript.sourceObjectId },
    });

    if (!source) {
      await this.pipeline.markFailed({
        transcriptId: transcript.id,
        reason: 'The uploaded audio is no longer in storage.',
        stage: 'upload',
        retryable: false,
      });

      return;
    }

    const selection = selectTranscriptionInput({
      capabilities: active.provider.capabilities,
      audioDelivery: active.policy.audioDelivery,
      original: { id: source.id, mimeType: source.mimeType, size: Number(source.size) },
      // Nothing has been transcoded yet — this is the moment the upload
      // landed. A rendition only ever enters the decision on the SECOND call
      // to `selectTranscriptionInput`, inside `transcription.submit` itself.
      rendition: null,
      renditionExpected: transcodeQueued,
    });

    if (selection.kind === 'original') {
      this.logger.log(
        `Transcript ${transcript.id}: submitting the original to ${active.provider.id} ` +
          `(${selection.reason})`,
      );

      await this.pipeline.enqueueSubmit(transcript.id);

      return;
    }

    if (selection.kind === 'impossible') {
      await this.pipeline.markFailed({
        transcriptId: transcript.id,
        reason: `This audio cannot be transcribed: ${selection.reason}.`,
        stage: 'transcription',
        retryable: false,
      });

      return;
    }

    // `wait` — and `rendition` cannot happen here, because none exists yet.
    this.logger.log(
      `Transcript ${transcript.id} is waiting for input: ${selection.reason}`,
    );

    await this.prisma.transcript.update({
      where: { id: transcript.id },
      data: { transcriptionStatus: 'waiting_input' },
    });
  }
}
