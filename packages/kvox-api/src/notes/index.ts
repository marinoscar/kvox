// The notes slice of @marinoscar/kvox-api (issue #495, epic #491).
//
// Depends on `ports`, `core`, `transcripts` and `search`. The one way in is
// `NotesModule.forRoot(options)`; the rest of this file is what a host or a sibling slice
// (the graph, Ask) imports. The Word exporter is deliberately NOT exported: its file imports
// the optional peer `docx`, and `forRoot` loads it only when it is enabled.

export { NotesModule } from './notes.module.js';
export {
  NOTES_MODULE_OPTIONS,
  resolveNotesOptions,
  type NoteDocumentSourceOptions,
  type NoteExporterOptions,
  type NoteStreamOptions,
  type NotesModuleOptions,
  type ResolvedNotesOptions,
} from './notes.options.js';

export {
  NOTE_TEMPLATES_PERMISSIONS,
  NOTE_TEMPLATES_READ_PERMISSION,
  NOTE_TEMPLATES_WRITE_PERMISSION,
  NOTES_PERMISSIONS,
  NOTES_READ_PERMISSION,
  NOTES_WRITE_PERMISSION,
} from './notes.permissions.js';

export {
  NOTE_FAILED_NOTIFICATION,
  NOTE_READY_NOTIFICATION,
  NOTES_NOTIFICATION_EVENTS,
  type NoteFailedNotificationData,
  type NoteReadyNotificationData,
} from './notes.notifications.js';

export { NOTE_READY_EVENT, type NoteReadyEvent } from './notes.events.js';

export {
  NOTE_EXPORT_JOB_TYPE,
  NOTE_GENERATE_JOB_TYPE,
  NOTE_JOB_TYPES,
  NOTE_PURGE_JOB_TYPE,
  NOTE_RETITLE_JOB_TYPE,
  NOTE_SOURCE_EXTRACT_JOB_TYPE,
  NOTE_SUBJECT_TYPE,
  NOTES_HOUSEKEEPING_JOB_TYPE,
  NOTES_MANAGED_BY,
} from './job-types.js';

export { actorOf, CurrentActor, type NotesActor } from './notes-actor.js';

// Services other slices and hosts use.
export { NotesService, SUMMARY_LIST_SIZE, DELETABLE_STATUSES, encodeCursor } from './notes.service.js';
export type { QueuedGeneration, QueuedRetitle, RetitleSweep } from './notes.service.js';
export { NoteTemplatesService, assertInstructionsFit } from './note-templates.service.js';
export { NoteTemplatePreviewService } from './note-template-preview.service.js';
export {
  NO_GENERATION_REASON,
  NoteGenerationContextService,
  SOURCE_WITHHELD_NOTICE,
} from './note-generation-context.service.js';
export { NoteObjectsService, MissingUploadedNoteObjectError } from './note-objects.service.js';
export type { ManagedObjectRef } from './note-objects.service.js';
export { NoteSourcesService } from './note-sources.service.js';
// The Markdown note import (#585): the service and its typed 400. The parser is the
// contract's (`parseNoteMarkdownExport` in `@marinoscar/kvox-contract/notes`).
export { NoteImportService, noteImportException, type NoteImportFile } from './import/note-import.service.js';
export type { NoteSourceDocument, UploadedDocument } from './note-sources.service.js';
export { NoteSourceNameService, noteSourceId, noteSourceNameKey } from './note-source-name.service.js';
export type { NoteSourceFields, NoteSourceNames } from './note-source-name.service.js';
export { NoteOriginService, MAX_NOTE_HOPS } from './note-origin.service.js';
export type { NoteOriginFields, NoteOriginTranscript } from './note-origin.service.js';
export { NotesUserDataService, type NotesUserDataSummary } from './user-data/notes-user-data.service.js';

export {
  NOTE_NOT_FOUND_MESSAGE,
  NoteAccessService,
  type NoteAccess,
  type NoteAccessLevel,
  type NoteAccessRole,
} from './access/note-access.service.js';
export {
  NOTE_GENERATION_NOT_FOUND_MESSAGE,
  NoteGenerationAccessService,
  type NoteGenerationTarget,
} from './access/note-generation-access.service.js';
export {
  BUILT_IN_TEMPLATE_IMMUTABLE_MESSAGE,
  NOTE_TEMPLATE_NOT_FOUND_MESSAGE,
  NoteTemplateAccessService,
  type NoteTemplateAccess,
  type NoteTemplateAccessLevel,
} from './access/note-template-access.service.js';

// Generation.
export { NoteGenerationService } from './generation/note-generation.service.js';
export type {
  CommitInput,
  GenerationWithNote,
  MarkFailedInput,
  RecordContextInput,
} from './generation/note-generation.service.js';
export { NoteGenerationRequestService } from './generation/note-generation-request.service.js';
export {
  DEFAULT_STREAM_DURATION_CAP_MS,
  DEFAULT_STREAM_HEARTBEAT_INTERVAL_MS,
  DEFAULT_STREAM_POLL_INTERVAL_MS,
  NOTE_STREAM_TUNING,
  NoteGenerationStreamService,
  type NoteStreamTuning,
  STREAM_DURATION_CAP_MARGIN_MS,
} from './generation/note-generation-stream.service.js';
export { NoteSourceService } from './generation/note-source.service.js';
export type { ResolvedSource, SourceSelector } from './generation/note-source.service.js';
export { NoteTitleService } from './generation/note-title.service.js';
export type { TitleNoteInput } from './generation/note-title.service.js';
export { assemblePrompt, parseTemplateStructure } from './generation/prompt.js';
export type { AssemblePromptInput, AssembledPrompt } from './generation/prompt.js';
export {
  budgetFromTarget,
  NOTE_GENERATE_AI_FEATURE,
  NOTE_TITLE_AI_FEATURE,
  NoteAiConflict,
  NoteInputError,
  providerLabelOf,
  type AiTokenCaps,
  type NoteAiConflictReason,
} from './generation/ai-support.js';

// Controllers (a host that composes its own module lists them).
export { NotesController } from './notes.controller.js';
export { NoteTemplatesController } from './note-templates.controller.js';
export { NoteSourcesController } from './note-sources.controller.js';
export { NoteImportController } from './import/note-import.controller.js';
export { NoteGenerationStreamController } from './note-generation-stream.controller.js';

// Handlers.
export { NoteExportHandler } from './handlers/note-export.handler.js';
export { NoteGenerateHandler, NOTE_GENERATE_MAX_RUNTIME_MS } from './handlers/note-generate.handler.js';
export { NotePurgeHandler } from './handlers/note-purge.handler.js';
export { NoteRetitleHandler } from './handlers/note-retitle.handler.js';
export { NoteSourceExtractHandler } from './handlers/note-source-extract.handler.js';
export { NotesHousekeepingHandler } from './handlers/notes-housekeeping.handler.js';
export { NotesHousekeepingEnqueuer } from './tasks/notes-housekeeping.enqueuer.js';

// Export.
export { NoteExportService, contentDisposition } from './export/note-export.service.js';
export type {
  CreateNoteExportResult,
  NoteExportDownload,
  NoteExportView,
} from './export/note-export.service.js';
export { NoteExporterRegistry, type NoteExporter } from './export/note-exporter.registry.js';
export { MarkdownNoteExporter } from './export/markdown.exporter.js';
export { PdfNoteExporter } from './export/pdf.exporter.js';
export {
  buildNoteExportDocument,
  noteExportFilename,
  type BuildNoteExportDocumentInput,
  type NoteExportAuthor,
  type NoteExportDocument,
  type NoteExportProvider,
  type NoteExportSource,
} from './export/note-export-document.js';

// Document sources.
export {
  EXTRACTED_OBJECT_ID_KEY,
  EXTRACTION_METADATA_KEY,
  extractedTextStorageKey,
  readExtractedObjectId,
  type NoteSourceExtractionMetadata,
} from './source-metadata.js';
export {
  NOTE_DOCUMENT_MIME_TYPES,
  acceptedDocumentTypesSentence,
  extractDocumentText,
  normalizeDocumentMimeType,
  type ExtractedDocument,
  type ExtractionOutcome,
  type NoteDocumentMimeType,
  type UnextractableDocument,
} from './extraction/index.js';
export {
  noteSourceExtractResultSchema,
  toExtractionOutcome,
  type NoteSourceExtractResult,
} from './contracts/note-source-extract.contract.js';

export type {
  NoteExportStatusValue,
  NoteGenerationErrorClassValue,
  NoteGenerationKindValue,
  NoteGenerationStatusValue,
  NoteSourceTypeValue,
  NoteStatusValue,
  NoteTitleSourceValue,
  NoteVersionKindValue,
  KvoxNotesDb,
  KvoxNotesDelegates,
  KvoxNotesTx,
  NoteExportRow,
  NoteGenerationRow,
  NoteRow,
  NoteTemplateRow,
  NoteVersionRow,
  UserHiddenNoteTemplateRow,
} from './data/notes-db.js';
export type { InputJsonValue, JsonValue } from './data/prisma.js';
