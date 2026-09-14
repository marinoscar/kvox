import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { JobsModule } from '../jobs/jobs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SettingsModule } from '../settings/settings.module';
import { StorageModule } from '../storage/storage.module';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';
import { TranscriptsModule } from '../transcripts/transcripts.module';
import { NoteTemplateAccessService } from './access/note-template-access.service';
import { NoteGenerationService } from './generation/note-generation.service';
import { NoteSourceService } from './generation/note-source.service';
import { NoteGenerateHandler } from './handlers/note-generate.handler';
import { NoteSourceExtractHandler } from './handlers/note-source-extract.handler';
import { NoteObjectsService } from './note-objects.service';
import { NoteSourcesController } from './note-sources.controller';
import { NoteSourcesService } from './note-sources.service';
import { NoteTemplatePreviewService } from './note-template-preview.service';
import { NoteTemplatesController } from './note-templates.controller';
import { NoteTemplatesService } from './note-templates.service';

// =============================================================================
// NotesModule (issue #49, epic #45)
// =============================================================================
//
// The generation pipeline (#49) and document sources (#51): #53 adds the note
// controllers, #54 the exporters. This module exists as soon as there is a
// handler to register, because a handler that no module provides is a class
// Nest never instantiates — and `onModuleInit` is where every handler in this
// codebase registers itself.
//
// WHAT IT IMPORTS, AND WHY EACH ONE:
//
//   • `PrismaModule` — the note, generation, template and version rows.
//   • `JobsModule` — `JobHandlerRegistry` for `note.generate` to register with,
//     and `ProviderThrottleService` for the PER-USER rate-limit bucket (spec
//     §2.3). `JobsService` joins when #53 starts enqueueing.
//   • `AiModule` — the provider registry, the deployment policy, and
//     `UserAiCredentialsService`, which is the only way to reach a user's own
//     decrypted key. That module is deliberately NOT `@Global()` precisely so
//     this import shows up in a diff.
//   • `NotificationsModule` — the two owner-addressed events.
//   • `StorageModule` — `ObjectsService`, which `NoteObjectsService` delegates
//     its deletes to so this module must NAME the owner it believes in before
//     it may remove anything.
//   • `StorageProvidersModule` — the `STORAGE_PROVIDER` itself, for writing and
//     reading the two objects a document source involves (#51): the upload and
//     the extracted text beside it.
//   • `SettingsModule` — `SystemSettingsService`, for the one setting the
//     upload endpoint reads per request (`ai.maxDocumentBytes`). ⚠ Read through
//     the settings service and never off `system_settings` directly, the same
//     discipline `AiSettingsService` states for itself.
//   • `TranscriptsModule` — `TranscriptMaterializeService` and the Markdown
//     exporter. ⚠ THIS IMPORT IS THE POINT OF THE EPIC: a note is generated
//     from the transcript AS THE USER CORRECTED IT, which means going through
//     the transcript module's own materialization rather than reading its
//     tables sideways. See `NoteSourceService`'s header.
//
// Nothing is exported yet. A service exported before anybody imports it is a
// public API nobody asked for — the same discipline `TranscriptsModule` states
// for itself.
// =============================================================================

@Module({
  imports: [
    PrismaModule,
    JobsModule,
    AiModule,
    NotificationsModule,
    TranscriptsModule,
    StorageModule,
    StorageProvidersModule,
    SettingsModule,
  ],
  // #51's ONE ROUTE (`POST /api/notes/sources/documents`) plus #50's SEVEN
  // (`/api/note-templates/*`). The NOTE routes themselves are still #53's.
  controllers: [NoteSourcesController, NoteTemplatesController],
  providers: [
    NoteGenerationService,
    NoteSourceService,
    NoteGenerateHandler,
    // Document sources (#51). `NoteObjectsService` is the only thing in this
    // module that writes a `storage_objects` row, and every row it writes is
    // `managed_by: 'notes'`.
    NoteObjectsService,
    NoteSourcesService,
    NoteSourceExtractHandler,
    // Note templates (#50). `NoteTemplateAccessService` is the ONE place that
    // decides 403-for-a-built-in vs 404-for-somebody-else's — see its header
    // for why those two answers are deliberately different.
    NoteTemplateAccessService,
    NoteTemplatesService,
    NoteTemplatePreviewService,
  ],
})
export class NotesModule {}
