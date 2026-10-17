import { Module, type DynamicModule } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';

import { KvoxPortsModule, type KvoxPortBindings } from '@marinoscar/kvox-api/core';
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
// Four domain slices over ten ports, and nothing else:
//
//   KvoxPortsModule     binds every port (global)
//   TranscriptionModule the provider framework, with the fake provider
//   SearchModule        the query side (full text; the fake AI reports no embeddings)
//   SearchIndexing      the `search.index` job
//   TranscriptsModule   the pipeline, correction, exports
//   NotesModule         notes, templates, the generation stream
//
// WHAT EACH `forRoot` SWITCHES OFF is what keeps four optional peers out of the
// install: `schedules: false` needs no `@nestjs/schedule` (the host would call
// `TranscriptsHousekeepingEnqueuer.enqueue()` and its notes twin on its own
// timer); `exporters.pdf: false` and `documentSources.pdf: false` need no
// `pdfkit` and no `unpdf`; `exporters.docx: false` needs no `docx`.
// `media.transcode: false` leaves the ffmpeg transcoder out.
//
// THE `peers` OPTION passes the very module objects the host imports, so the
// container sees one `TranscriptionModule` and one `SearchIndexingModule` and
// each job handler is registered once.
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

  return {
    module: BareHostModule,
    imports: [
      KvoxPortsModule.forRoot({ ports: options.ports, brand: { appName: 'BareHost', appSlug: 'barehost' } }),
      transcription,
      SearchModule.forRoot(),
      searchIndexing,
      transcripts,
      notes,
    ],
    controllers: [LocalStoreController, LocalUploadsController],
    providers: [
      { provide: LOCAL_FS_OBJECT_STORE, useValue: options.objectStore },
      { provide: APP_PIPE, useClass: ZodValidationPipe },
    ],
  };
}
