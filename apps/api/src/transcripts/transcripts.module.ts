import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { CredentialsModule } from '../credentials/credentials.module';
import { JobsModule } from '../jobs/jobs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SearchIndexingModule } from '../search/indexing/search-indexing.module';
import { StorageModule } from '../storage/storage.module';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';
import { TranscriptionModule } from '../transcription/transcription.module';
import { MediaAudioTranscodeHandler } from './handlers/media-audio-transcode.handler';
import { TranscriptionIngestHandler } from './handlers/transcription-ingest.handler';
import { TranscriptionPollHandler } from './handlers/transcription-poll.handler';
import { TranscriptionSubmitHandler } from './handlers/transcription-submit.handler';
import { TranscriptPurgeHandler } from './handlers/transcript-purge.handler';
import { TranscriptSnapshotHandler } from './handlers/transcript-snapshot.handler';
import { TranscriptsHousekeepingHandler } from './handlers/transcripts-housekeeping.handler';
import { TranscriptExportHandler } from './handlers/transcript-export.handler';
import { TranscriptNameCheckHandler } from './handlers/transcript-name-check.handler';
import { JsonTranscriptExporter } from './export/json.exporter';
import { MarkdownTranscriptExporter } from './export/markdown.exporter';
import { PdfTranscriptExporter } from './export/pdf.exporter';
import { TranscriptExportService } from './export/transcript-export.service';
import { TranscriptExporterRegistry } from './export/transcript-exporter.interface';
import { TranscriptJobFailureListener } from './listeners/transcript-job-failure.listener';
import { TranscriptsUploadListener } from './listeners/transcripts-upload.listener';
import { FfmpegService } from './media/ffmpeg.service';
import { TranscriptsHousekeepingTask } from './tasks/transcripts-housekeeping.task';
import { TranscriptAccessService } from './transcript-access.service';
import { TranscriptEditingService } from './transcript-editing.service';
import { TranscriptMaterializeService } from './transcript-materialize.service';
import { TranscriptNameCheckService } from './transcript-name-check.service';
import { TranscriptNameChecksController } from './transcript-name-checks.controller';
import { TranscriptObjectsService } from './transcript-objects.service';
import { TranscriptPipelineService } from './transcript-pipeline.service';
import { TranscriptSharingService } from './transcript-sharing.service';
import { ShareLookupThrottleService } from './share-lookup-throttle.service';
import { TranscriptionRuntimeService } from './transcription-runtime.service';
import { TranscriptsController } from './transcripts.controller';
import { TranscriptsService } from './transcripts.service';

// =============================================================================
// TranscriptsModule (issue #25, epic #19)
// =============================================================================
//
// The pipeline: create, upload listener, seven job handlers, the reconciliation
// cron, the ten read/lifecycle routes, (issue #27) the five correction routes
// with their pure editing core, and (issue #28) the three export routes with
// their exporter registry.
//
// ⚠ THE THREE EXPORTERS ARE PROVIDERS SO THEY CAN SELF-REGISTER, AND FOR NO
// OTHER REASON. Nothing injects `JsonTranscriptExporter` by class — every
// consumer goes through `TranscriptExporterRegistry.get(format)`, which is what
// makes spec §8.1's promise ("a future `docx` exporter is one new class") true:
// adding one means a new file and one more line in the list below, with no
// change to the controller, the service or the job handler. Listing them here
// is how Nest instantiates them at all, which is when their `onModuleInit`
// registers them.
//
// -----------------------------------------------------------------------------
// WHAT EACH IMPORT IS FOR, AND WHY NONE OF THEM IS INCIDENTAL
// -----------------------------------------------------------------------------
//
//   • `JobsModule` — `JobsService` to enqueue and `JobHandlerRegistry` for the
//     five handlers to register themselves with, plus `ProviderThrottleService`
//     so submit/poll/ingest can share ONE vendor rate-limit bucket.
//   • `TranscriptionModule` — the provider registry and the settings service.
//     It is deliberately NOT `@Global()`, so this line is how a reader sees
//     that this module can reach a plaintext-returning credential path.
//   • `CredentialsModule` — `TranscriptionRuntimeService` resolves the provider
//     API key per call. Imported explicitly for the same visibility reason.
//   • `StorageModule` — `ObjectsService`, for `initUpload` (with `managedBy`
//     and, since #79, this module's own MIME allowlist in place of the
//     operator's generic-upload one) and `deleteManagedObject`.
//   • `StorageProvidersModule` — the `STORAGE_PROVIDER` token itself, which
//     `StorageModule` does not re-export. Submit presigns with it; ingest
//     writes the gzipped raw result through it.
//   • `NotificationsModule` — the two owner-addressed events, plus (#29) the
//     one recipient-addressed one.
//
// -----------------------------------------------------------------------------
// NOTHING IS EXPORTED YET, AND THAT IS ON PURPOSE
// -----------------------------------------------------------------------------
//
// Issues #28–#31 extend this module rather than importing from it: #26 added a
// handler that lives here, #27 added the correction services and the snapshot
// handler, #28 adds the exporters. A service exported before anybody imports it
// is a public API nobody asked for. #26's `MediaAudioTranscodeHandler` is the
// worked example: it needs `TranscriptPipelineService`, `TranscriptObjectsService`
// and its own `FfmpegService`, and gets all three through ordinary DI with no
// export at all.
//
// ⚠ `FfmpegService` IS A PROVIDER OF THIS MODULE, NOT A GLOBAL. It spawns
// binaries, and the list of modules that can reach it should stay exactly as
// long as the list of modules that convert media — which is this one.
//
// ⚠ THE CORRECTION CORE IS NOT A PROVIDER AND CANNOT BE. Everything in
// `editing/` is a pure function — no `@Injectable`, no constructor, nothing to
// inject — precisely so that `materialize()` and the live edit path can call
// the same reducers (spec §4.4). #28's exporters and #31's UI-facing server
// code import it from `./editing` directly; there is nothing here for them to
// resolve out of the container.
// =============================================================================

@Module({
  imports: [
    PrismaModule,
    JobsModule,
    TranscriptionModule,
    CredentialsModule,
    StorageModule,
    StorageProvidersModule,
    NotificationsModule,
    // The semantic index (#188, epic #165). ONE-WAY: this module reaches into
    // `SearchIndexService` to queue a re-index after content commits and to
    // forget a purged transcript's rows; nothing in `search/indexing/` imports
    // anything from here — the handler reads `transcripts` through Prisma
    // directly, precisely so this import needs no `forwardRef`.
    SearchIndexingModule,
    // AI name correction (#328/#330, epic #326): the provider registry, the
    // policy, the capability probe and the per-user key, for the
    // `transcript.name_check` job and its request-time pre-flight. ONE-WAY, like
    // the import above — `AiModule` imports nothing from here, and `NotesModule`
    // (which imports this module) is never imported back, so no `forwardRef`.
    AiModule,
  ],
  controllers: [TranscriptsController, TranscriptNameChecksController],
  providers: [
    TranscriptsService,
    TranscriptAccessService,
    TranscriptEditingService,
    TranscriptExportService,
    TranscriptExporterRegistry,
    TranscriptMaterializeService,
    // Sharing (#29). `ShareLookupThrottleService` holds its window in THIS
    // PROCESS's memory, so it is a plain singleton of this module — see its own
    // file for why that limit is acceptable and where the seam is if a shared
    // limiter is ever wanted.
    TranscriptSharingService,
    ShareLookupThrottleService,
    TranscriptObjectsService,
    TranscriptPipelineService,
    TranscriptionRuntimeService,
    TranscriptsUploadListener,
    // #95: fails a transcript whose provider-facing job gave up.
    TranscriptJobFailureListener,
    FfmpegService,
    MediaAudioTranscodeHandler,
    TranscriptionSubmitHandler,
    TranscriptionPollHandler,
    TranscriptionIngestHandler,
    TranscriptPurgeHandler,
    TranscriptSnapshotHandler,
    TranscriptExportHandler,
    TranscriptNameCheckService,
    TranscriptNameCheckHandler,
    JsonTranscriptExporter,
    MarkdownTranscriptExporter,
    PdfTranscriptExporter,
    TranscriptsHousekeepingHandler,
    TranscriptsHousekeepingTask,
  ],
  // ⚠ TWO PROVIDERS, AND ONLY BECAUSE SOMEBODY NOW IMPORTS THEM (#49, epic
  // #45). This module exported nothing at all until the notes pipeline needed
  // to generate from a transcript AS THE USER CORRECTED IT — which means going
  // through `materialize()`, the canonical "full state at version N" entry
  // point, and rendering it with THIS module's own Markdown projection rather
  // than writing a third transcript-to-text serializer that could disagree with
  // the other two about what a transcript says.
  //
  // `MarkdownTranscriptExporter` is exported BY CLASS rather than the whole
  // `TranscriptExporterRegistry`, deliberately: the consumer wants one named
  // projection it can depend on, not the ability to render a transcript into
  // whatever formats happen to be registered.
  exports: [
    TranscriptMaterializeService,
    MarkdownTranscriptExporter,
    // ⚠ A THIRD, ADDED BY #50 FOR THE SAME REASON AS THE FIRST TWO: somebody
    // now imports it. `POST /api/note-templates/preview` generates from a
    // transcript the CALLER named, so it has to ask THIS module whether that
    // caller may read it — with this module's own 404-never-403 posture and its
    // one shared not-found sentence. Re-deriving the check inside the notes
    // module would be a second, independently-maintained answer to "who may
    // read this transcript", which is exactly the cross-feature disagreement
    // epic #45 was scoped to avoid.
    TranscriptAccessService,
    // ⚠ A FOURTH, ADDED BY #80 AND FOR THE SAME NARROW REASON. The Danger
    // Zone's `user.data.purge` soft-deletes a user's transcripts in batches and
    // hands each to `enqueuePurge` — the one place that knows which job type
    // and which subject shape a transcript purge is queued under. A second
    // `jobs.enqueue({ type: 'transcript.purge', … })` written in the user-data
    // module would be a literal string pair to keep in step with this one, and
    // getting it wrong produces `pending` rows no worker can ever claim.
    TranscriptPipelineService,
  ],
})
export class TranscriptsModule {}
