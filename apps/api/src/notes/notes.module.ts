import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { GraphExtractionModule } from '../graph/extraction/extraction.module';
import { JobsModule } from '../jobs/jobs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SearchIndexingModule } from '../search/indexing/search-indexing.module';
import { SettingsModule } from '../settings/settings.module';
import { StorageModule } from '../storage/storage.module';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';
import { TranscriptsModule } from '../transcripts/transcripts.module';
import { NoteAccessService } from './access/note-access.service';
import { NoteOriginService } from './note-origin.service';
import { NoteSourceNameService } from './note-source-name.service';
import { NoteGenerationAccessService } from './access/note-generation-access.service';
import { NoteTemplateAccessService } from './access/note-template-access.service';
import {
  NOTE_STREAM_TUNING,
  NoteGenerationStreamService,
} from './generation/note-generation-stream.service';
import { NoteGenerationRequestService } from './generation/note-generation-request.service';
import { NoteGenerationService } from './generation/note-generation.service';
import { NoteSourceService } from './generation/note-source.service';
import { NoteTitleService } from './generation/note-title.service';
import { MarkdownNoteExporter } from './export/markdown.exporter';
import { NoteExportService } from './export/note-export.service';
import { NoteExporterRegistry } from './export/note-exporter.registry';
import { PdfNoteExporter } from './export/pdf.exporter';
import { WordNoteExporter } from './export/word.exporter';
import { NoteExportHandler } from './handlers/note-export.handler';
import { NoteGenerateHandler } from './handlers/note-generate.handler';
import { NoteRetitleHandler } from './handlers/note-retitle.handler';
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
import { NoteGenerationContextService } from './note-generation-context.service';
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
    // The semantic index (#188, epic #165). ONE-WAY, exactly as in
    // `TranscriptsModule`: this module queues a re-index after a note's content
    // commits and forgets a purged note's rows, while `search/indexing/` reads
    // `notes` through Prisma directly and imports nothing from here — which is
    // what keeps both edges out of a `forwardRef`.
    SearchIndexingModule,
    // Graph extraction (#363): `NoteGenerationService.commit()` asks it to
    // queue a `kg.extract` once a note is ready. ONE-WAY: that module provides
    // the two note services it needs itself and never imports this one.
    GraphExtractionModule,
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
    // Naming a generated note (#182). It hangs off `NoteGenerationService.commit`
    // rather than off the handler, because a note is titled once its BODY is
    // durable — the one moment at which there is something to name and nothing
    // left that a failure could spoil. It needs `AiModule`'s three exports for
    // its first rank and nothing new: the resolution it performs is the one
    // `NoteGenerateHandler` already performs, reached through the same services.
    NoteTitleService,
    // `note.retitle` (#184) — the retroactive half of the same epic. It is a
    // handler and NOT a migration on purpose: titling spends the note owner's
    // own vendor key, which `migrate deploy` must never do on their behalf.
    // Registering it here is what makes both entry points able to queue work;
    // it needs nothing this module did not already import, because it resolves
    // no provider itself — it reuses `NoteTitleService`'s three ranks.
    NoteRetitleHandler,
    // The notes themselves (#53). `NoteAccessService` is the ONE place that
    // decides 404-never-403 for a note, and the shape note sharing will extend
    // rather than replace — see its header.
    NoteAccessService,
    NoteGenerationRequestService,
    // Resolving "from *Q3 planning*" for a whole page in a bounded number of
    // queries, scoped to what the caller may read (#192). It replaces a
    // per-source request the web client used to issue.
    NoteSourceNameService,
    // The transcript a note ultimately came from (#309) — detail responses
    // only, walking a chain of source notes as far as the caller may read.
    NoteOriginService,
    NotesService,
    // What a generation sent to its provider (#307), read back for
    // `GET /api/notes/:id/context` and `/generations/:generationId/context`.
    NoteGenerationContextService,
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
  // ⚠ TWO EXPORTS, ADDED BY #80 FOR THE NARROW REASON EXPORTS IN THIS
  // REPOSITORY ARE ADDED FOR: somebody now imports them. The Danger Zone's
  // `user.data.purge` soft-deletes a user's notes in batches and hands each to
  // `NotesService.enqueuePurge`, and removes their own custom templates through
  // `NoteTemplatesService.remove` — the path that already knows a template must
  // be ARCHIVED rather than deleted while a note still names it. Re-deriving
  // either inside the user-data module would be a second implementation of
  // "how a note's bytes are removed" and of "when a template may go", each free
  // to drift from the one the per-item delete endpoints use.
  exports: [NotesService, NoteTemplatesService],
})
export class NotesModule {}
