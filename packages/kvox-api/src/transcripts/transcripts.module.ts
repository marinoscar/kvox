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
import { TranscriptionModule } from '../transcription/index.js';
import { MediaAudioTranscodeHandler } from './handlers/media-audio-transcode.handler.js';
import { TranscriptExportHandler } from './handlers/transcript-export.handler.js';
import { TranscriptNameCheckHandler } from './handlers/transcript-name-check.handler.js';
import { TranscriptPurgeHandler } from './handlers/transcript-purge.handler.js';
import { TranscriptSnapshotHandler } from './handlers/transcript-snapshot.handler.js';
import { TranscriptionIngestHandler } from './handlers/transcription-ingest.handler.js';
import { TranscriptionPollHandler } from './handlers/transcription-poll.handler.js';
import { TranscriptionSubmitHandler } from './handlers/transcription-submit.handler.js';
import { TranscriptsHousekeepingHandler } from './handlers/transcripts-housekeeping.handler.js';
import { JsonTranscriptExporter } from './export/json.exporter.js';
import { MarkdownTranscriptExporter } from './export/markdown.exporter.js';
import { PdfTranscriptExporter } from './export/pdf.exporter.js';
import { TranscriptExportService } from './export/transcript-export.service.js';
import { TranscriptExporterRegistry, type TranscriptExporter } from './export/transcript-exporter.interface.js';
import { TranscriptJobFailureListener } from './listeners/transcript-job-failure.listener.js';
import { FfmpegService } from './media/ffmpeg.service.js';
import { OwnerOnlyTranscriptSharing, TranscriptSharing } from './sharing/transcript-sharing.js';
import { TranscriptsHousekeepingEnqueuer } from './tasks/transcripts-housekeeping.enqueuer.js';
import { TranscriptAccessService } from './transcript-access.service.js';
import { TranscriptEditingService } from './transcript-editing.service.js';
import { TranscriptMaterializeService } from './transcript-materialize.service.js';
import { TranscriptNameCheckService } from './transcript-name-check.service.js';
import { TranscriptNameChecksController } from './transcript-name-checks.controller.js';
import { TranscriptObjectsService } from './transcript-objects.service.js';
import { TranscriptPipelineService } from './transcript-pipeline.service.js';
import { TranscriptSharesService } from './transcript-shares.service.js';
import { TranscriptUploadHook } from './transcript-upload.hook.js';
import { TranscriptionRuntimeService } from './transcription-runtime.service.js';
import { TranscriptsController } from './transcripts.controller.js';
import { TRANSCRIPTS_NOTIFICATION_EVENTS } from './transcripts.notifications.js';
import {
  TRANSCRIPTS_MODULE_OPTIONS,
  resolveTranscriptsOptions,
  type TranscriptsModuleOptions,
} from './transcripts.options.js';
import { TranscriptsService } from './transcripts.service.js';

// =============================================================================
// TranscriptsModule (issue #25, epic #19; the package slice of issue #493, epic #491)
// =============================================================================
//
// The pipeline: create, the upload hook, nine job handlers, the reconciliation
// cron, the read/lifecycle routes, (issue #27) the correction routes with their pure
// editing core, (issue #28) the export routes with their exporter registry, and the
// AI name check.
//
// It is built over ports only. The host's database, object store, job queue,
// notifications, events, audit, AI, settings and secrets arrive through the
// `KVOX_*` tokens of `KvoxPortsModule` (global), and the two things a port cannot
// express are options of `forRoot`: who else may open a transcript (`sharing`) and
// the peer slices' modules (`peers`).
//
// ⚠ THE THREE EXPORTERS ARE PROVIDERS SO THEY CAN SELF-REGISTER, AND FOR NO OTHER
// REASON. Nothing injects `JsonTranscriptExporter` by class: every consumer goes
// through `TranscriptExporterRegistry.get(format)`, which is what makes spec §8.1's
// promise ("a future `docx` exporter is one new class") true: adding one means a
// new class in `exporters.extra`, with no change to the controller, the service or
// the job handler. Listing them here is how Nest instantiates them at all, which is
// when their `onModuleInit` registers them.
//
// ⚠ `FfmpegService` IS A PROVIDER OF THIS MODULE, NOT A GLOBAL. It spawns binaries,
// and the list of modules that can reach it should stay exactly as long as the list
// of modules that convert media - which is this one. `media.transcode: false` leaves
// it, and the `media.audio.transcode` handler, out: the pipeline's registry guard
// then skips the rendition and playback uses the original.
//
// ⚠ THE CORRECTION CORE IS NOT A PROVIDER AND CANNOT BE. Everything in `editing/` is
// a pure function - no `@Injectable`, no constructor, nothing to inject - precisely so
// that `materialize()` and the live edit path can call the same reducers (spec §4.4).
//
// ⚠ THE CRON IS A SEPARATE FILE, LOADED ONLY WHEN `schedules` IS NOT FALSE.
// `@nestjs/schedule` registers its metadata at import, so a host without
// `ScheduleModule` must not load it. The enqueuer (`enqueue()`) is always provided.
//
// Exported, because somebody imports them: the notes pipeline generates from a
// transcript AS THE USER CORRECTED IT (`TranscriptMaterializeService`, rendered with
// `MarkdownTranscriptExporter` rather than a third serializer), asks whether a caller
// may read one (`TranscriptAccessService`, the one place that answers with the 404
// posture), the user-data purge hands each transcript to `enqueuePurge`
// (`TranscriptPipelineService`, the one place that knows the job type and subject
// shape), and the HTTP layer of a host reads the lists (`TranscriptsService`).
// =============================================================================

/**
 * Declares the slice's notification events with the host when the module starts.
 * Idempotent per key, so a host that registered them at import time (the web edition,
 * whose registry freezes at bootstrap) is unaffected.
 */
@Injectable()
class TranscriptsNotificationRegistrar implements OnModuleInit {
  constructor(@Inject(KVOX_NOTIFY) private readonly notify: KvoxNotifyPort) {}

  onModuleInit(): void {
    this.notify.registerEvents(TRANSCRIPTS_NOTIFICATION_EVENTS);
  }
}

/**
 * The exporter classes a configuration enables. The PDF exporter loads `pdfkit` when it
 * renders, so a host without the optional peer can still import the slice.
 */
function exporterClasses(options: TranscriptsModuleOptions): Type<TranscriptExporter>[] {
  const classes: Type<TranscriptExporter>[] = [];

  if (options.exporters?.json !== false) classes.push(JsonTranscriptExporter);
  if (options.exporters?.markdown !== false) classes.push(MarkdownTranscriptExporter);

  if (options.exporters?.pdf !== false) classes.push(PdfTranscriptExporter);

  return [...classes, ...(options.exporters?.extra ?? [])];
}

/**
 * The transcripts slice: uploads become transcripts, which are corrected, versioned,
 * shared, exported and checked for mis-heard names.
 *
 * @stability experimental
 */
@Module({})
export class TranscriptsModule {
  /**
   * Builds the module over the host's ports.
   *
   * @param options - the exporters, media conversion, schedules, sharing and peer modules.
   * @returns the dynamic module; it exports `TranscriptsService`,
   *   {@link TranscriptAccessService}, {@link TranscriptMaterializeService},
   *   `TranscriptEditingService`, {@link TranscriptPipelineService},
   *   {@link TranscriptExporterRegistry} and {@link MarkdownTranscriptExporter}.
   */
  static forRoot(options: TranscriptsModuleOptions = {}): DynamicModule {
    const resolved = resolveTranscriptsOptions(options);
    const controllers = [TranscriptsController, TranscriptNameChecksController];
    const exporters = exporterClasses(options);
    const transcode = options.media?.transcode !== false;

    const providers: Provider[] = [
      { provide: TRANSCRIPTS_MODULE_OPTIONS, useValue: resolved },
      { provide: TranscriptSharing, useClass: options.sharing ?? OwnerOnlyTranscriptSharing },
      TranscriptsService,
      TranscriptAccessService,
      TranscriptEditingService,
      TranscriptExportService,
      TranscriptExporterRegistry,
      TranscriptMaterializeService,
      // The four deprecated `:id/shares` routes (#29, #485): thin adapters over `TranscriptSharing`.
      TranscriptSharesService,
      TranscriptObjectsService,
      TranscriptPipelineService,
      TranscriptionRuntimeService,
      // Starts the pipeline when a transcript's audio finishes uploading, and fails
      // the transcript when its upload is cancelled.
      TranscriptUploadHook,
      // #95: fails a transcript whose provider-facing job gave up.
      TranscriptJobFailureListener,
      TranscriptionSubmitHandler,
      TranscriptionPollHandler,
      TranscriptionIngestHandler,
      TranscriptPurgeHandler,
      TranscriptSnapshotHandler,
      TranscriptExportHandler,
      TranscriptNameCheckService,
      TranscriptNameCheckHandler,
      TranscriptsHousekeepingHandler,
      TranscriptsHousekeepingEnqueuer,
      TranscriptsNotificationRegistrar,
      ...exporters,
    ];

    if (transcode) providers.push(FfmpegService, MediaAudioTranscodeHandler);

    if (options.schedules !== false) {
      const { TranscriptsHousekeepingTask } =
        require('./tasks/transcripts-housekeeping.task.js') as typeof import('./tasks/transcripts-housekeeping.task.js');
      providers.push(TranscriptsHousekeepingTask);
    }

    // Now that the routes are known, describe them in the API document the way the host chose.
    documentKvoxAuth(controllers);

    return {
      module: TranscriptsModule,
      global: false,
      imports: [
        ...(options.imports ?? []),
        // The peer slices. The application imports both itself; pass the very same
        // objects here (a dynamic module built twice with the same options is one
        // module, but a different configuration would register a handler twice).
        options.peers?.transcription ?? TranscriptionModule.forRoot(),
        options.peers?.searchIndexing ?? SearchIndexingModule.forRoot(),
      ],
      controllers,
      providers,
      exports: [
        TranscriptsService,
        TranscriptAccessService,
        TranscriptMaterializeService,
        TranscriptEditingService,
        TranscriptPipelineService,
        TranscriptExporterRegistry,
        MarkdownTranscriptExporter,
        TranscriptsHousekeepingEnqueuer,
        // The notes slice (#495) asks which transcripts are shared with a user.
        TranscriptSharing,
      ],
    };
  }
}
