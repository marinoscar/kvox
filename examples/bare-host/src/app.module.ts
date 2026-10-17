import { Module, type DynamicModule } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';

import { AskModule } from '@marinoscar/kvox-api/ask';
import { KvoxPortsModule, type KvoxPortBindings } from '@marinoscar/kvox-api/core';
import { GraphModule } from '@marinoscar/kvox-api/graph';
import { GraphExtractionModule } from '@marinoscar/kvox-api/graph-extraction';
import { GraphRdfModule } from '@marinoscar/kvox-api/graph-rdf';
import { NotesModule } from '@marinoscar/kvox-api/notes';
import { SearchIndexingModule, SearchModule } from '@marinoscar/kvox-api/search';
import { TranscriptionModule } from '@marinoscar/kvox-api/transcription';
import { TranscriptsModule } from '@marinoscar/kvox-api/transcripts';

import { BareHostTranscriptionProvider } from './fake-provider.js';
import { LOCAL_FS_OBJECT_STORE, LocalStoreController, LocalUploadsController } from './local-store.controller.js';
import type { LocalFsObjectStore } from './ports/local-fs-object-store.js';

// =============================================================================
// The application module of the bare host
// =============================================================================
//
// Eight domain slices over ten ports, and nothing else:
//
//   KvoxPortsModule       binds every port (global)
//   TranscriptionModule   the provider framework, with the fake provider
//   SearchModule          the query side (full text; the fake AI reports no embeddings)
//   SearchIndexing        the `search.index` job
//   TranscriptsModule     the pipeline, correction, exports
//   NotesModule           notes, templates, the generation stream
//   GraphModule           the connected-knowledge core: write, read, access, the
//                         brief (`kg.entity_digest`), the overview (`kg.graph_layout`),
//                         `kg.migrate`, `kg.purge`, `kg.speaker_link`
//   GraphExtractionModule `kg.extract`, resolution (`kg.resolve`, `kg.embed`), the
//                         proposal review and commit routes
//   GraphRdfModule        the OWL/SHACL artefacts, `kg.export`, `kg.import`
//   AskModule             conversations and the `ask.respond` tool loop
//
// WHAT EACH `forRoot` SWITCHES OFF is what keeps four optional peers out of the
// install: `schedules: false` (on transcripts, notes, the graph and RDF) needs no
// `@nestjs/schedule`: the host calls the enqueuers on its own timer instead
// (`housekeeping.ts`: `TranscriptsHousekeepingEnqueuer`, `NotesHousekeepingEnqueuer`,
// `KgMigrateEnqueuer`, `KgExportExpiryEnqueuer`); `exporters.pdf: false` and
// `documentSources.pdf: false` need no `pdfkit` and no `unpdf`; `exporters.docx:
// false` needs no `docx`. `media.transcode: false` leaves the ffmpeg transcoder out.
// What the graph slices DO need is installed: the layout libraries (`graphology`
// and three of its packages, loaded when `kg.graph_layout` runs) and the RDF
// libraries (`n3`, `jsonld`, `rdf-validate-shacl`; `GraphRdfModule.forRoot` refuses
// to start, naming the peer, when the import is on and the SHACL engine is missing).
//
// `autoExtract: false`: a ready note is NOT extracted on `kvox.notes.note_ready`.
// Extraction is the explicit `POST /api/graph/notes/:noteId/extract`, so a note the
// happy path generates never spends the (fake) model on the graph and every graph
// job a test drains is one it asked for.
//
// THE `peers` OPTION passes the very module objects the host imports, so the
// container sees one module of each slice and each job handler is registered
// once. `SearchModule.forRoot()` is built once and shared by the graph and Ask.
//
// THE HOST OWNS THE VALIDATION PIPE: `TranscriptionSettingsController` takes its
// body as a `nestjs-zod` DTO and relies on a global `ZodValidationPipe`.
// =============================================================================

/** Everything `createBareHostModule` wires. */
export interface BareHostModuleOptions {
  /** The ten port bindings. */
  ports: KvoxPortBindings;
  /** The object store the loopback controller serves. */
  objectStore: LocalFsObjectStore;
}

@Module({})
class BareHostModule {}

/** Builds the application module around already-constructed ports. */
export function createBareHostModule(options: BareHostModuleOptions): DynamicModule {
  const transcription = TranscriptionModule.forRoot({
    providers: { assemblyai: false },
    extraProviders: [BareHostTranscriptionProvider],
  });
  const searchIndexing = SearchIndexingModule.forRoot();
  const transcripts = TranscriptsModule.forRoot({
    schedules: false,
    media: { transcode: false },
    exporters: { pdf: false },
    peers: { transcription, searchIndexing },
  });
  const notes = NotesModule.forRoot({
    schedules: false,
    exporters: { pdf: false, docx: false },
    documentSources: { pdf: false },
    peers: { transcripts, searchIndexing },
  });
  const search = SearchModule.forRoot();
  const graph = GraphModule.forRoot({ schedules: false, peers: { transcripts, notes, search } });
  const extraction = GraphExtractionModule.forRoot({ autoExtract: false, peers: { graph, notes } });
  const rdf = GraphRdfModule.forRoot({ schedules: false, peers: { graph, extraction, transcripts, notes } });
  const ask = AskModule.forRoot({ peers: { graph, notes, search } });

  return {
    module: BareHostModule,
    imports: [
      KvoxPortsModule.forRoot({ ports: options.ports, brand: { appName: 'BareHost', appSlug: 'barehost' } }),
      transcription,
      search,
      searchIndexing,
      transcripts,
      notes,
      graph,
      extraction,
      rdf,
      ask,
    ],
    controllers: [LocalStoreController, LocalUploadsController],
    providers: [
      { provide: LOCAL_FS_OBJECT_STORE, useValue: options.objectStore },
      { provide: APP_PIPE, useClass: ZodValidationPipe },
    ],
  };
}
