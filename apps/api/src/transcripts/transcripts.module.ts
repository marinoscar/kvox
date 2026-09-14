import { Module } from '@nestjs/common';

import { CredentialsModule } from '../credentials/credentials.module';
import { JobsModule } from '../jobs/jobs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
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
import { TranscriptsUploadListener } from './listeners/transcripts-upload.listener';
import { FfmpegService } from './media/ffmpeg.service';
import { TranscriptsHousekeepingTask } from './tasks/transcripts-housekeeping.task';
import { TranscriptAccessService } from './transcript-access.service';
import { TranscriptEditingService } from './transcript-editing.service';
import { TranscriptMaterializeService } from './transcript-materialize.service';
import { TranscriptObjectsService } from './transcript-objects.service';
import { TranscriptPipelineService } from './transcript-pipeline.service';
import { TranscriptionRuntimeService } from './transcription-runtime.service';
import { TranscriptsController } from './transcripts.controller';
import { TranscriptsService } from './transcripts.service';

// =============================================================================
// TranscriptsModule (issue #25, epic #19)
// =============================================================================
//
// The pipeline: create, upload listener, six job handlers, the reconciliation
// cron, the ten read/lifecycle routes, and (issue #27) the five correction
// routes with their pure editing core.
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
//   • `StorageModule` — `ObjectsService`, for `initUpload` (with `managedBy`)
//     and `deleteManagedObject`.
//   • `StorageProvidersModule` — the `STORAGE_PROVIDER` token itself, which
//     `StorageModule` does not re-export. Submit presigns with it; ingest
//     writes the gzipped raw result through it.
//   • `NotificationsModule` — the two owner-addressed events.
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
  ],
  controllers: [TranscriptsController],
  providers: [
    TranscriptsService,
    TranscriptAccessService,
    TranscriptEditingService,
    TranscriptMaterializeService,
    TranscriptObjectsService,
    TranscriptPipelineService,
    TranscriptionRuntimeService,
    TranscriptsUploadListener,
    FfmpegService,
    MediaAudioTranscodeHandler,
    TranscriptionSubmitHandler,
    TranscriptionPollHandler,
    TranscriptionIngestHandler,
    TranscriptPurgeHandler,
    TranscriptSnapshotHandler,
    TranscriptsHousekeepingHandler,
    TranscriptsHousekeepingTask,
  ],
})
export class TranscriptsModule {}
