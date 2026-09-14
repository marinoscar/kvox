import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { JobsModule } from '../jobs/jobs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SettingsModule } from '../settings/settings.module';
import { StorageModule } from '../storage/storage.module';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';
import { TranscriptsModule } from '../transcripts/transcripts.module';
import { NoteAccessService } from './access/note-access.service';
import { NoteGenerationAccessService } from './access/note-generation-access.service';
import { NoteTemplateAccessService } from './access/note-template-access.service';
import {
  NOTE_STREAM_TUNING,
  NoteGenerationStreamService,
} from './generation/note-generation-stream.service';
import { NoteGenerationRequestService } from './generation/note-generation-request.service';
import { NoteGenerationService } from './generation/note-generation.service';
import { NoteSourceService } from './generation/note-source.service';
import { MarkdownNoteExporter } from './export/markdown.exporter';
import { NoteExportService } from './export/note-export.service';
import { NoteExporterRegistry } from './export/note-exporter.registry';
import { PdfNoteExporter } from './export/pdf.exporter';
import { WordNoteExporter } from './export/word.exporter';
import { NoteExportHandler } from './handlers/note-export.handler';
import { NoteGenerateHandler } from './handlers/note-generate.handler';
import { NotePurgeHandler } from './handlers/note-purge.handler';
import { NotesHousekeepingHandler } from './handlers/notes-housekeeping.handler';
import { NoteSourceExtractHandler } from './handlers/note-source-extract.handler';
import { NoteGenerationStreamController } from './note-generation-stream.controller';
import { NoteObjectsService } from './note-objects.service';
import { NoteSourcesController } from './note-sources.controller';
import { NoteSourcesService } from './note-sources.service';
import { NoteTemplatePreviewService } from './note-template-preview.service';
import { NoteTemplatesController } from './note-templates.controller';
import { NoteTemplatesService } from './note-templates.service';
import { NotesController } from './notes.controller';
import { NotesService } from './notes.service';
import { NotesHousekeepingTask } from './tasks/notes-housekeeping.task';

// =============================================================================
// NotesModule (issue #49, epic #45)
// =============================================================================
//
// The generation pipeline (#49), document sources (#51), the note controllers
// (#53) and export (#54). This module exists as soon as there is a
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
//     exporter. ⚠ NOT for note export: `notes/export/` has its own three
//     exporters over the GENERIC registry (`apps/api/src/export/`), which is
//     what `docs/specs/notes.md` §8.1 means by "extracted, not
//     re-implemented" — one registry class, two document types. ⚠ THIS IMPORT IS THE POINT OF THE EPIC: a note is generated
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
  // #53's TEN NOTE ROUTES (`/api/notes/*`), #51's ONE
  // (`POST /api/notes/sources/documents`), #50's SEVEN
  // (`/api/note-templates/*`) and #52's TWO SSE readers
  // (`GET /api/notes/:id/stream`, `GET /api/note-generations/:id/stream`).
  //
  // ⚠ `NoteSourcesController` IS DECLARED ON `notes/sources`, A LITERAL PREFIX,
  // which is why it does not collide with `NotesController`'s `:id` parameter
  // route: the two share no method-and-path pair.
  controllers: [
    NotesController,
    NoteSourcesController,
    NoteTemplatesController,
    NoteGenerationStreamController,
  ],
  providers: [
    NoteGenerationService,
    NoteSourceService,
    NoteGenerateHandler,
    // The notes themselves (#53). `NoteAccessService` is the ONE place that
    // decides 404-never-403 for a note, and the shape note sharing will extend
    // rather than replace — see its header.
    NoteAccessService,
    NoteGenerationRequestService,
    NotesService,
    // `note.purge` and `notes.housekeeping`, plus the ten-minute `@Cron` that
    // only ENQUEUES the latter (CLAUDE.md rule 1).
    NotePurgeHandler,
    NotesHousekeepingHandler,
    NotesHousekeepingTask,
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
    // Export (#54). The registry, its three self-registering exporters, the
    // service the three routes call, and the `note.export` handler.
    //
    // ⚠ EACH EXPORTER IS A PROVIDER IN ITS OWN RIGHT, which is the whole
    // mechanism: `onModuleInit` is where an exporter registers itself, and a
    // class Nest never instantiates never registers. Adding a fourth format is
    // one new class and one line here — nothing in the controller, the handler
    // or `apps/web` branches on a format string.
    NoteExporterRegistry,
    MarkdownNoteExporter,
    PdfNoteExporter,
    WordNoteExporter,
    NoteExportService,
    NoteExportHandler,
    // The generation stream (#52). `NoteGenerationStreamService` only ever
    // READS — the stream is a view over `note_generations.content`, never a
    // second source of truth, and the note completes identically with nobody
    // watching.
    NoteGenerationAccessService,
    NoteGenerationStreamService,
    // Declared with no overrides so the service's own defaults ship. It exists
    // as a provider at all because a spec cannot override a token its module
    // never declared; nothing in production supplies a value.
    { provide: NOTE_STREAM_TUNING, useValue: {} },
  ],
})
export class NotesModule {}
