// The transcripts slice of @marinoscar/kvox-api (issue #493, epic #491).
//
// Depends on `ports`, `core`, `transcription` and `search`. The one way in is
// `TranscriptsModule.forRoot(options)`; the rest of this file is what a host or a
// sibling slice (notes, graph, Ask) imports.

export { TranscriptsModule } from './transcripts.module.js';
export {
  DEFAULT_PLAYBACK_URL_TTL_SECONDS,
  DEFAULT_STALE_UPLOAD_HOURS,
  TRANSCRIPTS_MODULE_OPTIONS,
  resolveTranscriptsOptions,
  type ResolvedTranscriptsOptions,
  type TranscriptExporterOptions,
  type TranscriptsModuleOptions,
} from './transcripts.options.js';

export {
  TRANSCRIPTS_PERMISSIONS,
  TRANSCRIPTS_READ_PERMISSION,
  TRANSCRIPTS_WRITE_PERMISSION,
  type KvoxPermissionDeclaration,
} from './transcripts.permissions.js';

export {
  TRANSCRIPT_FAILED_EVENT,
  TRANSCRIPT_READY_EVENT,
  TRANSCRIPTS_NOTIFICATION_EVENTS,
  type TranscriptFailedNotificationData,
  type TranscriptReadyNotificationData,
} from './transcripts.notifications.js';

export {
  TRANSCODE_JOB_TYPE,
  TRANSCRIPT_EXPORT_JOB_TYPE,
  TRANSCRIPT_JOB_TYPES,
  TRANSCRIPT_NAME_CHECK_JOB_TYPE,
  TRANSCRIPT_PURGE_JOB_TYPE,
  TRANSCRIPT_SOURCE_CONTENT_TYPES,
  TRANSCRIPT_SNAPSHOT_JOB_TYPE,
  TRANSCRIPT_SUBJECT_TYPE,
  TRANSCRIPTION_INGEST_JOB_TYPE,
  TRANSCRIPTION_POLL_JOB_TYPE,
  TRANSCRIPTION_SUBMIT_JOB_TYPE,
  TRANSCRIPTS_HOUSEKEEPING_JOB_TYPE,
  TRANSCRIPTS_MANAGED_BY,
} from './job-types.js';

export { TRANSCRIPT_SPEAKERS_IDENTIFIED_EVENT, TranscriptSpeakersIdentifiedEvent } from './events/transcript-speakers-identified.event.js';

export { TranscriptsService, encodeCursor } from './transcripts.service.js';
export { TranscriptsController } from './transcripts.controller.js';
export { TranscriptNameChecksController } from './transcript-name-checks.controller.js';
export { TranscriptObjectsService, MissingUploadedObjectError } from './transcript-objects.service.js';
export { TranscriptionRuntimeService } from './transcription-runtime.service.js';
export { TranscriptUploadHook } from './transcript-upload.hook.js';
export { TranscriptSharesService } from './transcript-shares.service.js';
export { TranscriptNameCheckService } from './transcript-name-check.service.js';
export { TranscriptExportService, exportFilename } from './export/transcript-export.service.js';
export { PdfTranscriptExporter } from './export/pdf.exporter.js';
export { FfmpegService } from './media/ffmpeg.service.js';
export { TranscriptJobFailureListener } from './listeners/transcript-job-failure.listener.js';
export { MediaAudioTranscodeHandler } from './handlers/media-audio-transcode.handler.js';
export { TranscriptExportHandler } from './handlers/transcript-export.handler.js';
export { TranscriptNameCheckHandler } from './handlers/transcript-name-check.handler.js';
export { TranscriptPurgeHandler } from './handlers/transcript-purge.handler.js';
export { TranscriptSnapshotHandler } from './handlers/transcript-snapshot.handler.js';
export { TranscriptionIngestHandler } from './handlers/transcription-ingest.handler.js';
export { TranscriptionPollHandler } from './handlers/transcription-poll.handler.js';
export { TranscriptionSubmitHandler } from './handlers/transcription-submit.handler.js';
export { TranscriptsHousekeepingHandler } from './handlers/transcripts-housekeeping.handler.js';

// The pure correction core (`editing/`): reducers, ops, ordinals, word alignment, speaker identities.
export * from './editing/index.js';
export { TranscriptAccessService, TRANSCRIPT_NOT_FOUND_MESSAGE } from './transcript-access.service.js';
export type {
  TranscriptAccess,
  TranscriptAccessLevel,
  TranscriptAccessRole,
  TranscriptRef,
} from './transcript-access.service.js';
export {
  TranscriptMaterializeService,
  type LiveState,
  type MaterializedTranscript,
  type WordsSelection,
} from './transcript-materialize.service.js';
export { TranscriptEditingService } from './transcript-editing.service.js';
export { TranscriptPipelineService, type MarkFailedInput, type TranscriptStage } from './transcript-pipeline.service.js';

export {
  OwnerOnlyTranscriptSharing,
  SHARE_NOT_FOUND_MESSAGE,
  SHARE_RECIPIENT_NOT_FOUND_MESSAGE,
  SHARE_WITH_SELF_MESSAGE,
  TranscriptSharing,
  type TranscriptGrant,
  type TranscriptShareAction,
  type TranscriptShareActor,
  type TranscriptShareDecision,
  type TranscriptShareRole,
  type TranscriptShareSubject,
} from './sharing/transcript-sharing.js';

export { TranscriptExporterRegistry, type TranscriptExporter } from './export/transcript-exporter.interface.js';
export { MarkdownTranscriptExporter } from './export/markdown.exporter.js';
export { JsonTranscriptExporter } from './export/json.exporter.js';
export {
  ExporterRegistry,
  canonicalJson,
  defaultOptions,
  endStream,
  failStream,
  hashExportRequest,
  optionsSchemaFor,
  writeChunk,
  type Exporter,
  type ExportOptionField,
  type ExportOptions,
  type ExportOptionsSchema,
} from './export/export-kit.js';
export * from './export/export-document.js';

export { TranscriptsHousekeepingEnqueuer } from './tasks/transcripts-housekeeping.enqueuer.js';

export { actorOf, type TranscriptsActor } from './transcripts-actor.js';

export { TRANSCRIPT_DB_STATUSES } from './data/transcripts-db.js';
export type {
  BatchResult,
  DelegateArgs,
  KvoxTranscriptsDb,
  KvoxTranscriptsDelegates,
  KvoxTranscriptsTx,
  PlaybackStatusValue,
  RowDelegate,
  TranscriptExportRow,
  TranscriptExportStatusValue,
  TranscriptNameCheckModeValue,
  TranscriptNameCheckRow,
  TranscriptNameCheckStatusValue,
  TranscriptNameSuggestionRow,
  TranscriptNameSuggestionStatusValue,
  TranscriptNoteRow,
  TranscriptOrganizationRow,
  TranscriptRow,
  TranscriptSegmentRow,
  TranscriptSpeakerRow,
  TranscriptStatusValue,
  TranscriptUserRow,
  TranscriptVersionKindValue,
  TranscriptVersionRow,
  TranscriptionStatusValue,
} from './data/transcripts-db.js';
export type { InputJsonValue, JsonValue } from './data/prisma.js';
