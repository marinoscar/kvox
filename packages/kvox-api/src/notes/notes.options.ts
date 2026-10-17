import type { DynamicModule, ModuleMetadata, Type } from '@nestjs/common';

import type { NoteExporter } from './export/note-exporter.registry.js';

// =============================================================================
// NotesModule options (issue #495, epic #491)
// =============================================================================
//
// Plain data plus `Type<...>` bindings, as every slice's `forRoot` takes. No
// environment variable is read inside the package: a host reads its own
// configuration and passes values.
// =============================================================================

/**
 * Which exporters the module registers, and the extra ones a fork adds. A new format
 * is one class (`NoteExporter`) listed in `extra`: no change to the controller, the
 * service or the job handler.
 *
 * @stability experimental
 */
export interface NoteExporterOptions {
  /** The Markdown exporter. Default on. */
  markdown?: boolean;
  /** The PDF exporter (needs the optional peer `pdfkit` and the packaged fonts). Default on. */
  pdf?: boolean;
  /** The Word exporter (needs the optional peer `docx`). Default on. */
  docx?: boolean;
  /** Further exporter classes; each registers itself with the registry when the module starts. */
  extra?: Type<NoteExporter>[];
}

/**
 * Which document formats a note can be generated from (`POST /api/notes/sources/documents`).
 *
 * @stability experimental
 */
export interface NoteDocumentSourceOptions {
  /** Extract text from PDFs (needs the optional peer `unpdf`). Default on. */
  pdf?: boolean;
  /** Read plain text and Markdown files. Default on. */
  text?: boolean;
}

/**
 * The stream's tuning. Absent fields keep the slice's defaults.
 *
 * @stability experimental
 */
export interface NoteStreamOptions {
  /** How often the stream flusher writes the buffered text to the row, in milliseconds. */
  flushIntervalMs?: number;
  /** How many buffered characters make the flusher write at once. */
  flushChars?: number;
  /** The longest an SSE connection may stay open, in milliseconds. */
  maxDurationMs?: number;
}

/**
 * Options of `NotesModule.forRoot`.
 *
 * @example
 * ```ts
 * NotesModule.forRoot({
 *   peers: { transcripts: TranscriptsModule.forRoot(), searchIndexing: SearchIndexingModule.forRoot() },
 *   appUrl: () => process.env.APP_URL,
 * });
 * ```
 *
 * @stability experimental
 */
export interface NotesModuleOptions {
  /** Which exporters to register. */
  exporters?: NoteExporterOptions;

  /** Which uploaded document formats can be a source. */
  documentSources?: NoteDocumentSourceOptions;

  /** The PDF exporter. */
  pdf?: {
    /** The directory holding the `NotoSans-*.ttf` fonts. Default: the fonts shipped in this package. */
    fontDir?: string;
  };

  /**
   * Register `NotesHousekeepingTask` with `@nestjs/schedule` (default true). False
   * exposes the enqueuer for a host without `ScheduleModule`, which calls its
   * `enqueue()` itself. A cron only enqueues (a registered job does the work).
   */
  schedules?: boolean;

  /** The generation stream's tuning. */
  stream?: NoteStreamOptions;

  /**
   * Modules the host's own classes need. Imported by the slice's module so those
   * providers resolve.
   */
  imports?: ModuleMetadata['imports'];

  /**
   * The modules of the peer slices this one imports. Pass the objects the host imports
   * itself (`TranscriptsModule.forRoot(...)`, `SearchIndexingModule.forRoot(...)`): the
   * module imports them to reach the providers they export, and NEVER provides those
   * providers a second time. Absent, each is built with its defaults, which is only right
   * when the host imports the defaults too.
   */
  peers?: {
    /** `TranscriptsModule.forRoot(...)`: materialization, access and sharing of a source transcript. */
    transcripts?: DynamicModule;
    /** `SearchIndexingModule.forRoot(...)`: `SearchIndexService`. */
    searchIndexing?: DynamicModule;
  };

  /**
   * The absolute URL of the application root, for the call-to-action of a "ready" or
   * "failed" message. A function so the host reads its configuration when a message is
   * built, not when the module is declared. Absent: the message carries no link.
   */
  appUrl?: () => string | undefined;

  /**
   * The largest note file `POST /api/notes/import` accepts, in bytes (default 5 MiB: a
   * note is text). The multipart read stops at this many bytes and answers 413, so the
   * import stays bounded by it (it runs inside the request, not as a job).
   */
  maxImportBytes?: number;
}

/** The default of {@link NotesModuleOptions.maxImportBytes}: 5 MiB. */
const DEFAULT_MAX_IMPORT_BYTES = 5 * 1024 * 1024;

/**
 * The options with defaults applied, as the providers read them.
 *
 * @stability experimental
 */
export interface ResolvedNotesOptions {
  /** The PDF fonts directory, or `undefined` for the packaged one. */
  fontDir: string | undefined;
  /** The application root URL, or `undefined`. */
  appUrl: (() => string | undefined) | undefined;
  /** Whether PDF documents can be a source. */
  documentPdf: boolean;
  /** Whether text and Markdown documents can be a source. */
  documentText: boolean;
  /** The stream's tuning; absent fields keep the stream service's defaults. */
  stream: NoteStreamOptions;
  /** The largest note file an import accepts, in bytes. */
  maxImportBytes: number;
}

/**
 * Injection token of the resolved options. The description string is permanent.
 *
 * @stability experimental
 */
export const NOTES_MODULE_OPTIONS = Symbol.for('@marinoscar/kvox/NOTES_MODULE_OPTIONS');

/**
 * Applies the defaults to a host's options.
 *
 * @param options - what the host passed to `forRoot`.
 * @returns the resolved options.
 * @stability experimental
 */
export function resolveNotesOptions(options: NotesModuleOptions): ResolvedNotesOptions {
  return {
    fontDir: options.pdf?.fontDir,
    appUrl: options.appUrl,
    documentPdf: options.documentSources?.pdf !== false,
    documentText: options.documentSources?.text !== false,
    stream: { ...(options.stream ?? {}) },
    maxImportBytes: options.maxImportBytes ?? DEFAULT_MAX_IMPORT_BYTES,
  };
}
