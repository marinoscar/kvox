import {
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnModuleInit,
  type Provider,
  type Type,
} from '@nestjs/common';

import { documentKvoxAuth } from '../core/index.js';
import { KVOX_NOTIFY, type KvoxNotifyPort } from '../ports/index.js';
import { SearchIndexingModule } from '../search/index.js';
import { TranscriptsModule } from '../transcripts/index.js';
import { NoteAccessService } from './access/note-access.service.js';
import { NoteGenerationAccessService } from './access/note-generation-access.service.js';
import { NoteTemplateAccessService } from './access/note-template-access.service.js';
import { MarkdownNoteExporter } from './export/markdown.exporter.js';
import { NoteExportService } from './export/note-export.service.js';
import { NoteExporterRegistry, type NoteExporter } from './export/note-exporter.registry.js';
import { PdfNoteExporter } from './export/pdf.exporter.js';
import {
  NOTE_STREAM_TUNING,
  NoteGenerationStreamService,
} from './generation/note-generation-stream.service.js';
import { NoteGenerationRequestService } from './generation/note-generation-request.service.js';
import { NoteGenerationService } from './generation/note-generation.service.js';
import { NoteSourceService } from './generation/note-source.service.js';
import { NoteTitleService } from './generation/note-title.service.js';
import { NoteExportHandler } from './handlers/note-export.handler.js';
import { NoteGenerateHandler } from './handlers/note-generate.handler.js';
import { NotePurgeHandler } from './handlers/note-purge.handler.js';
import { NoteRetitleHandler } from './handlers/note-retitle.handler.js';
import { NoteSourceExtractHandler } from './handlers/note-source-extract.handler.js';
import { NotesHousekeepingHandler } from './handlers/notes-housekeeping.handler.js';
import { NoteGenerationContextService } from './note-generation-context.service.js';
import { NoteGenerationStreamController } from './note-generation-stream.controller.js';
import { NoteObjectsService } from './note-objects.service.js';
import { NoteOriginService } from './note-origin.service.js';
import { NoteSourceNameService } from './note-source-name.service.js';
import { NoteSourcesController } from './note-sources.controller.js';
import { NoteSourcesService } from './note-sources.service.js';
import { NoteImportController } from './import/note-import.controller.js';
import { NoteImportService } from './import/note-import.service.js';
import { NoteLibrariesController } from './library/note-libraries.controller.js';
import { NoteLibrariesService } from './library/note-libraries.service.js';
import { NoteLibraryPolicy } from './library/note-library-policy.js';
import { NoteTemplatePreviewService } from './note-template-preview.service.js';
import { NoteTemplatesController } from './note-templates.controller.js';
import { NoteTemplatesService } from './note-templates.service.js';
import { NotesController } from './notes.controller.js';
import { NOTES_NOTIFICATION_EVENTS } from './notes.notifications.js';
import {
  NOTES_MODULE_OPTIONS,
  resolveNotesOptions,
  type NotesModuleOptions,
} from './notes.options.js';
import { NotesService } from './notes.service.js';
import { NoteVersionWriter } from './note-version-writer.js';
import { NotesHousekeepingEnqueuer } from './tasks/notes-housekeeping.enqueuer.js';
import { NotesUserDataService } from './user-data/notes-user-data.service.js';

// =============================================================================
// NotesModule (issue #49, epic #45; the package slice of issue #495, epic #491)
// =============================================================================
//
// The generation pipeline (#49), document sources (#51), the note controllers (#53) and
// export (#54). This module exists as soon as there is a handler to register, because a
// handler that no module provides is a class Nest never instantiates - and `onModuleInit`
// is where every handler registers itself, with the host's job port.
//
// It is built over ports only. The host's database, object store, job queue, notifications,
// events, audit, AI and settings arrive through the `KVOX_*` tokens of `KvoxPortsModule`
// (global); the peer slices' modules are options of `forRoot`.
//
// WHAT IT IMPORTS, AND WHY EACH ONE:
//
//   • the transcripts slice - `TranscriptMaterializeService` (a note is generated from the
//     transcript AS THE USER CORRECTED IT, which means going through the transcript slice's
//     own materialization rather than reading its tables sideways), `TranscriptAccessService`,
//     `TranscriptSharing` and `MarkdownTranscriptExporter`. ⚠ NOT for note export: the notes
//     have their own three exporters over the GENERIC export kit, which is what
//     `docs/specs/notes.md` §8.1 means by "extracted, not re-implemented" - one registry class,
//     two document types.
//   • the search-indexing slice - `SearchIndexService`: this module queues a re-index after a
//     note's content commits and forgets a purged note's rows, while the search slice reads
//     `notes` through the database directly and imports nothing from here, which is what keeps
//     both edges out of a `forwardRef`.
//
// ⚠ BOTH ARE IMPORTED, NEVER PROVIDED AGAIN: a peer slice's providers are reached through its
// module, so a handler registers once however many slices import it.
//
// ⚠ THIS SLICE DOES NOT KNOW THE GRAPH EXISTS. After a note commits `ready` it publishes
// `kvox.notes.note_ready` on the event port (`NoteGenerationService.commit`); whoever extracts
// knowledge from a ready note subscribes. Before the graph moved behind that event this module
// imported the graph's extraction module, which closed a cycle.
//
// THE THREE EXPORTERS ARE PROVIDERS SO THEY CAN SELF-REGISTER, AND FOR NO OTHER REASON.
// Nothing injects a note exporter by class: every consumer goes through
// `NoteExporterRegistry.get(format)`. Adding a fourth format is one class in `exporters.extra`
// and nothing in the controller, the handler or the web branches on a format string. The
// Word exporter (`docx`, an optional peer) is loaded with `require` only when it is enabled.
//
// THE CRON IS A SEPARATE FILE, LOADED ONLY WHEN `schedules` IS NOT FALSE (`@nestjs/schedule`
// registers its metadata at import). The enqueuer (`enqueue()`) is always provided.
//
// Exported, because somebody imports them: the Danger Zone's `user.data.purge` soft-deletes a
// user's notes in batches and hands each to `NotesService.enqueuePurge`, and removes their own
// custom templates through `NoteTemplatesService.remove` - the path that already knows a
// template must be ARCHIVED rather than deleted while a note still names it. The graph and Ask
// read notes through `NoteAccessService`, `NoteOriginService` and `NotesService`.
// =============================================================================

/**
 * Declares the slice's notification events with the host when the module starts.
 * Idempotent per key, so a host that registered them at import time (the web edition,
 * whose registry freezes at bootstrap) is unaffected.
 */
@Injectable()
class NotesNotificationRegistrar implements OnModuleInit {
  constructor(@Inject(KVOX_NOTIFY) private readonly notify: KvoxNotifyPort) {}

  onModuleInit(): void {
    this.notify.registerEvents(NOTES_NOTIFICATION_EVENTS);
  }
}

/**
 * The exporter classes a configuration enables. The PDF exporter loads `pdfkit` when it
 * renders; the Word exporter's file imports `docx`, so it is loaded only when enabled.
 */
function exporterClasses(options: NotesModuleOptions): Type<NoteExporter>[] {
  const classes: Type<NoteExporter>[] = [];

  if (options.exporters?.markdown !== false) classes.push(MarkdownNoteExporter);
  if (options.exporters?.pdf !== false) classes.push(PdfNoteExporter);

  if (options.exporters?.docx !== false) {
    const { WordNoteExporter } =
      require('./export/word.exporter.js') as typeof import('./export/word.exporter.js');
    classes.push(WordNoteExporter);
  }

  return [...classes, ...(options.exporters?.extra ?? [])];
}

/**
 * The notes slice: transcripts, other notes and uploaded documents become AI-generated,
 * user-correctable notes with templates, versions, a resumable stream and exports.
 *
 * @stability experimental
 */
@Module({})
export class NotesModule {
  /**
   * Builds the module over the host's ports.
   *
   * @param options - the exporters, document sources, schedules, stream tuning and peer modules.
   * @returns the dynamic module; it exports `NotesService`, `NoteAccessService`,
   *   `NoteOriginService`, `NoteSourceNameService`, `NoteTemplatesService`,
   *   `NoteExportService`, {@link NotesUserDataService}, {@link NoteExporterRegistry} and
   *   {@link NotesHousekeepingEnqueuer}.
   */
  static forRoot(options: NotesModuleOptions = {}): DynamicModule {
    const resolved = resolveNotesOptions(options);
    const controllers = [
      // Libraries and import batches (#714): static `libraries` / `import-batches` paths.
      NoteLibrariesController,
      NotesController,
      // `POST /api/notes/import` (#585). Its own controller, so its static path is
      // registered beside the `:id` routes without depending on their order.
      NoteImportController,
      NoteSourcesController,
      NoteTemplatesController,
      NoteGenerationStreamController,
    ];

    const providers: Provider[] = [
      { provide: NOTES_MODULE_OPTIONS, useValue: resolved },
      NoteGenerationService,
      NoteSourceService,
      NoteGenerateHandler,
      // Naming a generated note (#182). It hangs off `NoteGenerationService.commit` rather
      // than off the handler, because a note is titled once its BODY is durable.
      NoteTitleService,
      // `note.retitle` (#184) - the retroactive half of the same epic. A handler and NOT a
      // migration on purpose: titling spends the note owner's own vendor key.
      NoteRetitleHandler,
      // The notes themselves (#53). `NoteAccessService` is the ONE place that decides
      // 404-never-403 for a note.
      NoteAccessService,
      NoteGenerationRequestService,
      // Resolving "from *Q3 planning*" for a whole page in a bounded number of queries,
      // scoped to what the caller may read (#192).
      NoteSourceNameService,
      // The transcript a note ultimately came from (#309).
      NoteOriginService,
      NotesService,
      // The optimistic version commit shared by edit, restore and the library import (#712).
      NoteVersionWriter,
      // What a generation sent to its provider (#307).
      NoteGenerationContextService,
      // `note.purge` and `notes.housekeeping`, plus the enqueuer the ten-minute cron calls.
      NotePurgeHandler,
      NotesHousekeepingHandler,
      NotesHousekeepingEnqueuer,
      // Document sources (#51). `NoteObjectsService` is the only thing in this module that
      // stores an object, and every object it stores is `managed_by: 'notes'`.
      NoteObjectsService,
      NoteSourcesService,
      // Note import (#585): a Markdown note export back into a note.
      NoteImportService,
      // Libraries, scans and import batches (#714), and the policy the graph reads.
      NoteLibrariesService,
      NoteLibraryPolicy,
      NoteSourceExtractHandler,
      // Note templates (#50). `NoteTemplateAccessService` is the ONE place that decides
      // 403-for-a-built-in vs 404-for-somebody-else's.
      NoteTemplateAccessService,
      NoteTemplatesService,
      NoteTemplatePreviewService,
      // Export (#54). The registry, its self-registering exporters, the service the three
      // routes call, and the `note.export` handler.
      NoteExporterRegistry,
      ...exporterClasses(options),
      NoteExportService,
      NoteExportHandler,
      // The generation stream (#52). `NoteGenerationStreamService` only ever READS - the
      // stream is a view over `note_generations.content`, never a second source of truth,
      // and the note completes identically with nobody watching.
      NoteGenerationAccessService,
      NoteGenerationStreamService,
      // Declared with no overrides so the service's own defaults ship (the `stream` option
      // tunes the duration cap). A spec overrides it.
      { provide: NOTE_STREAM_TUNING, useValue: {} },
      // The Danger Zone's view of the notes categories.
      NotesUserDataService,
      NotesNotificationRegistrar,
    ];

    if (options.schedules !== false) {
      const { NotesHousekeepingTask } =
        require('./tasks/notes-housekeeping.task.js') as typeof import('./tasks/notes-housekeeping.task.js');
      providers.push(NotesHousekeepingTask);
    }

    // Now that the routes are known, describe them in the API document the way the host chose.
    documentKvoxAuth(controllers);

    return {
      module: NotesModule,
      global: false,
      imports: [
        ...(options.imports ?? []),
        // The peer slices. The application imports both itself; pass the very same objects
        // here (a dynamic module built twice with the same options is one module, but a
        // different configuration would register a handler twice).
        options.peers?.transcripts ?? TranscriptsModule.forRoot(),
        options.peers?.searchIndexing ?? SearchIndexingModule.forRoot(),
      ],
      controllers,
      providers,
      exports: [
        NotesService,
        NoteVersionWriter,
        NoteLibrariesService,
        NoteLibraryPolicy,
        NoteAccessService,
        NoteOriginService,
        NoteSourceNameService,
        NoteTemplatesService,
        NoteExportService,
        NoteExporterRegistry,
        NotesUserDataService,
        NotesHousekeepingEnqueuer,
      ],
    };
  }
}
