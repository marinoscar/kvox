// =============================================================================
// TranscriptsUploadAbortedListener (issue #322)
// =============================================================================
//
// The bridge between "the user cancelled the audio upload" and "the transcript
// goes away".
//
// `ObjectsService.abortUpload` cannot delete a transcript's source object: the
// transcript points at it through `transcripts.source_object_id`, which is
// `Restrict`. So for a managed object it aborts the multipart upload, marks the
// row `failed`, and emits `OBJECT_UPLOAD_ABORTED_EVENT`. This listener is the
// transcripts module's half of that contract: it soft-deletes the transcript
// (the same `deleting` + `deletedAt` shape `TranscriptsService.remove` writes)
// and queues `transcript.purge`, the one path allowed to free the object.
//
// Before this listener existed, a cancelled upload left the transcript in
// `uploading` forever — the cancel failed on the FK and nothing else noticed.
//
// -----------------------------------------------------------------------------
// ⚠ IT ONLY WRITES A STATUS AND ENQUEUES. NOTHING ELSE.
// -----------------------------------------------------------------------------
//
// CLAUDE.md rule 1: an `@OnEvent` body may not do long-running work. Deleting
// bytes, calling the provider, clearing the search index — all of that is
// `transcript.purge`'s job, on the queue, with a row, a timeout and retries.
//
// ⚠ CONDITIONAL ON `uploading`. A transcript whose upload already completed
// (it is `processing`) is not this event's to touch — `abortUpload` refuses a
// completed upload anyway — and a duplicated event, or one racing an explicit
// delete, soft-deletes the row at most once. `count` says which call won, and
// only the winner enqueues (enqueueing twice would be harmless thanks to the
// active-dedup key, but there is no reason to rely on it).
//
// ⚠ ERRORS ARE CONTAINED, exactly as `TranscriptsUploadListener` contains
// them: an event listener that throws is an unhandled rejection, which by
// default terminates the process. A transcript this listener failed to purge
// is still reclaimed by `transcripts.housekeeping`, whose step 2 purges a
// transcript whose source object is `failed`.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { PrismaService } from '../../prisma/prisma.service';
import {
  OBJECT_UPLOAD_ABORTED_EVENT,
  ObjectUploadAbortedEvent,
} from '../../storage/processing/events/object-upload-aborted.event';
import { TRANSCRIPTS_MANAGED_BY } from '../job-types';
import { TranscriptPipelineService } from '../transcript-pipeline.service';

@Injectable()
export class TranscriptsUploadAbortedListener {
  private readonly logger = new Logger(TranscriptsUploadAbortedListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pipeline: TranscriptPipelineService,
  ) {}

  @OnEvent(OBJECT_UPLOAD_ABORTED_EVENT)
  async handleUploadAborted(event: ObjectUploadAbortedEvent): Promise<void> {
    try {
      await this.purge(event);
    } catch (error) {
      // CONTAINED — see the file header.
      this.logger.error(
        `Could not purge the transcript for aborted upload ${event.objectId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async purge(event: ObjectUploadAbortedEvent): Promise<void> {
    // Another module's object. Not an error, and not worth a log line.
    if (event.managedBy !== TRANSCRIPTS_MANAGED_BY) return;

    const transcript = await this.prisma.transcript.findFirst({
      where: { sourceObjectId: event.objectId, deletedAt: null },
      select: { id: true, status: true },
    });

    if (!transcript) {
      this.logger.log(
        `Aborted upload ${event.objectId} has no live transcript; nothing to purge`,
      );

      return;
    }

    if (transcript.status !== 'uploading') {
      this.logger.log(
        `Transcript ${transcript.id} is already ${transcript.status}; the abort of ` +
          `object ${event.objectId} changes nothing`,
      );

      return;
    }

    const result = await this.prisma.transcript.updateMany({
      where: { id: transcript.id, status: 'uploading', deletedAt: null },
      data: { status: 'deleting', deletedAt: new Date() },
    });

    if (result.count === 0) {
      this.logger.log(
        `Transcript ${transcript.id} left 'uploading' before the abort was handled; ` +
          'this event is a no-op',
      );

      return;
    }

    this.logger.log(
      `Upload of transcript ${transcript.id} was cancelled (object ${event.objectId}); purging`,
    );

    await this.pipeline.enqueuePurge(transcript.id);
  }
}
