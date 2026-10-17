import type { DynamicModule, ModuleMetadata, Type } from '@nestjs/common';

import type { TranscriptExporter } from './export/transcript-exporter.interface.js';
import type { TranscriptSharing } from './sharing/transcript-sharing.js';

// =============================================================================
// TranscriptsModule options (issue #493, epic #491)
// =============================================================================
//
// Plain data plus `Type<...>` bindings, as every slice's `forRoot` takes. No
// environment variable is read inside the package: a host reads its own
// configuration and passes values.
// =============================================================================

/**
 * Which exporters the module registers, and the extra ones a fork adds. A new
 * format is one class (`TranscriptExporter`) listed in `extra`: no change to the
 * controller, the service or the job handler.
 *
 * @stability experimental
 */
export interface TranscriptExporterOptions {
  /** The JSON exporter (`format: json`). Default on. */
  json?: boolean;
  /** The Markdown exporter. Default on. */
  markdown?: boolean;
  /** The PDF exporter (needs the optional peer `pdfkit` and the packaged fonts). Default on. */
  pdf?: boolean;
  /** Further exporter classes; each registers itself with the registry when the module starts. */
  extra?: Type<TranscriptExporter>[];
}

/**
 * Options of `TranscriptsModule.forRoot`.
 *
 * @example
 * ```ts
 * TranscriptsModule.forRoot({
 *   sharing: PlatformTranscriptSharing,
 *   media: { ffmpegPath: '/usr/bin/ffmpeg' },
 * });
 * ```
 *
 * @stability experimental
 */
export interface TranscriptsModuleOptions {
  /** Which exporters to register. */
  exporters?: TranscriptExporterOptions;

  /** The PDF exporter. */
  pdf?: {
    /** The directory holding the `NotoSans-*.ttf` fonts. Default: the fonts shipped in this package. */
    fontDir?: string;
  };

  /** Media conversion for the playback rendition. */
  media?: {
    /** The `ffmpeg` binary. Default `ffmpeg` on the `PATH`. */
    ffmpegPath?: string;
    /** The `ffprobe` binary. Default `ffprobe` on the `PATH`. */
    ffprobePath?: string;
    /**
     * Register `media.audio.transcode`. Default true. Off, the pipeline's existing
     * registry guard skips the rendition and playback uses the original: a host
     * without ffmpeg.
     */
    transcode?: boolean;
  };

  /**
   * Register `TranscriptsHousekeepingTask` with `@nestjs/schedule` (default true).
   * False exposes the task class for a host without `ScheduleModule`, which calls
   * its `enqueue()` itself. A cron only enqueues (a registered job does the work).
   */
  schedules?: boolean;

  /**
   * Who else may open a transcript. Default: nobody (`OwnerOnlyTranscriptSharing`).
   *
   * @extensionPoint
   */
  sharing?: Type<TranscriptSharing>;

  /**
   * Modules the host's own classes need (for example the module that provides the
   * services `sharing` injects). Imported by the slice's module so those providers
   * resolve.
   */
  imports?: ModuleMetadata['imports'];

  /**
   * The modules of the peer slices this one imports. Pass the objects the host
   * imports itself (`TranscriptionModule.forRoot(...)`, `SearchIndexingModule.forRoot(...)`):
   * the module imports them to reach the providers they export. Absent, each is built
   * with its defaults, which is only right when the host imports the defaults too.
   */
  peers?: {
    /** `TranscriptionModule.forRoot(...)`: the provider registry and the settings service. */
    transcription?: DynamicModule;
    /** `SearchIndexingModule.forRoot(...)`: `SearchIndexService`. */
    searchIndexing?: DynamicModule;
  };

  /**
   * How long a signed audio URL lives, in seconds. Default six hours: longer than
   * a download link's usual hour, because the URL is held by an `<audio>` element
   * for the whole time somebody listens.
   */
  playbackUrlTtlSeconds?: number;

  /**
   * The absolute URL of the application root, for the call-to-action of a
   * "ready" or "failed" message. A function so the host reads its configuration
   * when a message is built, not when the module is declared. Absent: the message
   * carries no link.
   */
  appUrl?: () => string | undefined;

  /**
   * How long an upload that never completed is left alone before the stale-upload
   * sweep may fail its transcript, in hours. Default 72 (the web edition's storage
   * default).
   */
  staleUploadHours?: number;
}

/**
 * The options with defaults applied, as the providers read them.
 *
 * @stability experimental
 */
export interface ResolvedTranscriptsOptions {
  /** The `ffmpeg` binary. */
  ffmpegPath: string;
  /** The `ffprobe` binary. */
  ffprobePath: string;
  /** The PDF fonts directory, or `undefined` for the packaged one. */
  fontDir: string | undefined;
  /** Signed audio URL lifetime, in seconds. */
  playbackUrlTtlSeconds: number;
  /** Hours an unfinished upload is left alone. */
  staleUploadHours: number;
  /** The application root URL, or `undefined`. */
  appUrl: (() => string | undefined) | undefined;
}

/**
 * Injection token of the resolved options. The description string is permanent.
 *
 * @stability experimental
 */
export const TRANSCRIPTS_MODULE_OPTIONS = Symbol.for('@marinoscar/kvox/TRANSCRIPTS_MODULE_OPTIONS');

/** Default signed audio URL lifetime: six hours. @stability experimental */
export const DEFAULT_PLAYBACK_URL_TTL_SECONDS = 6 * 60 * 60;

/** Default hours an unfinished upload is left alone. @stability experimental */
export const DEFAULT_STALE_UPLOAD_HOURS = 72;

/**
 * Applies the defaults to a host's options.
 *
 * @param options - what the host passed to `forRoot`.
 * @returns the resolved options.
  * @stability experimental
 */
export function resolveTranscriptsOptions(options: TranscriptsModuleOptions): ResolvedTranscriptsOptions {
  return {
    ffmpegPath: options.media?.ffmpegPath ?? 'ffmpeg',
    ffprobePath: options.media?.ffprobePath ?? 'ffprobe',
    fontDir: options.pdf?.fontDir,
    playbackUrlTtlSeconds: options.playbackUrlTtlSeconds ?? DEFAULT_PLAYBACK_URL_TTL_SECONDS,
    staleUploadHours: options.staleUploadHours ?? DEFAULT_STALE_UPLOAD_HOURS,
    appUrl: options.appUrl,
  };
}
