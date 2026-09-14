import { Module } from '@nestjs/common';

import { CredentialsModule } from '../credentials/credentials.module';
import { JobsModule } from '../jobs/jobs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';
import { TranscriptionModule } from '../transcription/transcription.module';
import { TranscriptionIngestHandler } from './handlers/transcription-ingest.handler';
import { TranscriptionPollHandler } from './handlers/transcription-poll.handler';
import { TranscriptionSubmitHandler } from './handlers/transcription-submit.handler';
import { TranscriptPurgeHandler } from './handlers/transcript-purge.handler';
import { TranscriptsHousekeepingHandler } from './handlers/transcripts-housekeeping.handler';
import { TranscriptsUploadListener } from './listeners/transcripts-upload.listener';
import { TranscriptsHousekeepingTask } from './tasks/transcripts-housekeeping.task';
import { TranscriptAccessService } from './transcript-access.service';
import { TranscriptObjectsService } from './transcript-objects.service';
import { TranscriptPipelineService } from './transcript-pipeline.service';
import { TranscriptionRuntimeService } from './transcription-runtime.service';
import { TranscriptsController } from './transcripts.controller';
import { TranscriptsService } from './transcripts.service';

// =============================================================================
// TranscriptsModule (issue #25, epic #19)
// =============================================================================
//
// The pipeline: create, upload listener, five job handlers, the reconciliation
// cron, and the ten read/lifecycle routes.
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
// Issues #26–#30 extend this module rather than importing from it: #26 adds a
// handler that lives here, #27 adds the snapshot handler, #28 adds the editing
// surface. A service exported before anybody imports it is a public API nobody
// asked for. When #26 needs `TranscriptPipelineService` from a handler in this
// same module, it gets it through ordinary DI with no export at all.
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
    TranscriptObjectsService,
    TranscriptPipelineService,
    TranscriptionRuntimeService,
    TranscriptsUploadListener,
    TranscriptionSubmitHandler,
    TranscriptionPollHandler,
    TranscriptionIngestHandler,
    TranscriptPurgeHandler,
    TranscriptsHousekeepingHandler,
    TranscriptsHousekeepingTask,
  ],
})
export class TranscriptsModule {}
