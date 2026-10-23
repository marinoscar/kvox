import type { KvoxPrismaClientLike, KvoxSql, KvoxTransactionOptions } from '../../ports/index.js';
import type {
  BatchResult,
  DelegateArgs,
  RowDelegate,
  TranscriptRow,
  TranscriptVersionRow,
} from '../../transcripts/index.js';
import type { InputJsonValue, JsonValue } from './prisma.js';

// =============================================================================
// The notes slice's view of the database (issue #495, epic #491)
// =============================================================================
//
// The slice never imports a generated Prisma client. It declares, here, the
// STRUCTURAL row type of every table it owns and the narrowed client type it
// injects through `KVOX_PRISMA` (`KvoxNotesDb`). The application proves its real
// client satisfies this type with a compile-time assignment in
// `apps/api/test/kvox/prisma-shape.typecheck.ts`, so a schema change that breaks
// the slice fails the typecheck, not production.
//
// THE DELEGATES TAKE LOOSE ARGUMENTS ON PURPOSE (see `transcripts-db.ts`): each
// method takes `any` arguments and answers the row type, and a call with `select`
// or `include` still returns the narrower object at run time. A row type lists the
// RELATIONS the slice includes as optional properties (`template`, `author`,
// `hiddenBy`, ...), so a caller that asked for one reads it without a cast.
//
// COLUMNS: copied from `kvox.notes.prisma` in `@marinoscar/kvox-db`, which owns the
// schema. The enums are string unions of its enum members.
//
// TABLES THE SLICE READS BUT DOES NOT OWN: `transcripts` and `transcript_versions`
// (the source of a note; reads only). The objects a note owns (`storage_objects`),
// the audit log and the job queue are reached through ports, never through Prisma.
// =============================================================================

/** The `NoteStatus` enum. @stability experimental */
export type NoteStatusValue = 'draft' | 'generating' | 'ready' | 'failed' | 'deleting';

/** The `NoteSourceType` enum. @stability experimental */
export type NoteSourceTypeValue = 'transcript' | 'note' | 'document';

/** The `NoteGenerationKind` enum. @stability experimental */
export type NoteGenerationKindValue = 'create' | 'regenerate' | 'preview';

/** The `NoteGenerationStatus` enum. @stability experimental */
export type NoteGenerationStatusValue = 'pending' | 'streaming' | 'succeeded' | 'failed';

/** The `NoteGenerationErrorClass` enum. @stability experimental */
export type NoteGenerationErrorClassValue = 'auth' | 'refusal' | 'rate_limit' | 'other';

/** The `NoteVersionKind` enum. @stability experimental */
export type NoteVersionKindValue = 'ai_generated' | 'edit' | 'restore';

/** The `NoteExportStatus` enum. @stability experimental */
export type NoteExportStatusValue = 'pending' | 'ready' | 'failed';

/** The `NoteTitleSource` enum. @stability experimental */
export type NoteTitleSourceValue = 'ai' | 'user' | 'template';

/**
 * A row of `notes`.
 *
 * @stability experimental
 */
export interface NoteRow {
  /** The `id` column. */
  id: string;
  /** The `owner_id` column. */
  ownerId: string;
  /** The `title` column. */
  title: string;
  /** The `title_source` column. */
  titleSource: NoteTitleSourceValue;
  /** The `body` column. */
  body: string;
  /** The `body_format` column. */
  bodyFormat: string;
  /** The `status` column. */
  status: NoteStatusValue;
  /** The `current_version` column. */
  currentVersion: number;
  /** The `provider` column. */
  provider: string | null;
  /** The `model` column. */
  model: string | null;
  /** The `current_generation_id` column. */
  currentGenerationId: string | null;
  /** The `source_type` column. */
  sourceType: NoteSourceTypeValue;
  /** The `source_transcript_id` column. */
  sourceTranscriptId: string | null;
  /** The `source_note_id` column. */
  sourceNoteId: string | null;
  /** The `source_object_id` column. */
  sourceObjectId: string | null;
  /** The `template_id` column. */
  templateId: string | null;
  /** The `context_text` column. */
  contextText: string | null;
  /** The `failure_reason` column. */
  failureReason: string | null;
  /** The `deleted_at` column. */
  deletedAt: Date | null;
  /** The `created_at` column. */
  createdAt: Date;
  /** The `updated_at` column. */
  updatedAt: Date;
  /** The template, when the query included it. */
  template?: {
    /** The template's name. */
    name: string;
  } | null;
  /** The exports, when the query included them. */
  exports?: Array<{
    /** The export's id. */
    id: string;
    /** The stored object, or `null` once it was cleared. */
    objectId: string | null;
  }>;
}

/**
 * A row of `note_templates`.
 *
 * @stability experimental
 */
export interface NoteTemplateRow {
  /** The `id` column. */
  id: string;
  /** The `owner_id` column; `null` for a built-in template. */
  ownerId: string | null;
  /** The `name` column. */
  name: string;
  /** The `description` column. */
  description: string;
  /** The `instructions` column. */
  instructions: string;
  /** The `output_format` column. */
  outputFormat: string;
  /** The `body_format` column. */
  bodyFormat: string;
  /** The `structure` column. */
  structure: JsonValue;
  /** The `tone` column. */
  tone: string | null;
  /** The `length` column. */
  length: string | null;
  /** The `model` column. */
  model: string | null;
  /** The `is_archived` column. */
  isArchived: boolean;
  /** The `created_at` column. */
  createdAt: Date;
  /** The `updated_at` column. */
  updatedAt: Date;
  /** The caller's hide rows, when the query included them. */
  hiddenBy?: Array<{
    /** The user who hid the template. */
    userId: string;
  }>;
}

/**
 * A row of `user_hidden_note_templates`.
 *
 * @stability experimental
 */
export interface UserHiddenNoteTemplateRow {
  /** The `user_id` column. */
  userId: string;
  /** The `template_id` column. */
  templateId: string;
  /** The `created_at` column. */
  createdAt: Date;
}

/**
 * A row of `note_generations`.
 *
 * @stability experimental
 */
export interface NoteGenerationRow {
  /** The `id` column. */
  id: string;
  /** The `note_id` column; `null` for a preview. */
  noteId: string | null;
  /** The `kind` column. */
  kind: NoteGenerationKindValue;
  /** The `status` column. */
  status: NoteGenerationStatusValue;
  /** The `error_class` column. */
  errorClass: NoteGenerationErrorClassValue | null;
  /** The `error_detail` column. */
  errorDetail: string | null;
  /** The `template_id` column. */
  templateId: string | null;
  /** The `template_name_snapshot` column. */
  templateNameSnapshot: string;
  /** The `context_text` column. */
  contextText: string | null;
  /** The `source_type` column. */
  sourceType: NoteSourceTypeValue;
  /** The `source_transcript_id` column. */
  sourceTranscriptId: string | null;
  /** The `source_note_id` column. */
  sourceNoteId: string | null;
  /** The `source_object_id` column. */
  sourceObjectId: string | null;
  /** The `provider_id` column. */
  providerId: string;
  /** The `model` column. */
  model: string;
  /** The `content` column. */
  content: string;
  /** The `last_event_id` column. */
  lastEventId: number;
  /** The `prompt_tokens` column. */
  promptTokens: number | null;
  /** The `completion_tokens` column. */
  completionTokens: number | null;
  /** The `system_prompt` column. */
  systemPrompt: string | null;
  /** The `user_content` column. */
  userContent: string | null;
  /** The `source_version` column. */
  sourceVersion: number | null;
  /** The `context_captured_at` column. */
  contextCapturedAt: Date | null;
  /** The `job_id` column. */
  jobId: string | null;
  /** The `expires_at` column. */
  expiresAt: Date | null;
  /** The `started_at` column. */
  startedAt: Date | null;
  /** The `completed_at` column. */
  completedAt: Date | null;
  /** The `created_at` column. */
  createdAt: Date;
  /** The note, when the query included it. */
  note?: NoteRow | null;
  /** The job's payload, when the query selected it. */
  job?: {
    /** The payload. */
    payload: JsonValue | null;
  } | null;
}

/**
 * A row of `note_versions`.
 *
 * @stability experimental
 */
export interface NoteVersionRow {
  /** The `id` column. */
  id: string;
  /** The `note_id` column. */
  noteId: string;
  /** The `version` column. */
  version: number;
  /** The `kind` column. */
  kind: NoteVersionKindValue;
  /** The `body` column. */
  body: string;
  /** The `body_format` column. */
  bodyFormat: string;
  /** The `summary` column. */
  summary: string | null;
  /** The `author_id` column. */
  authorId: string | null;
  /** The `generation_id` column. */
  generationId: string | null;
  /** The `restored_from_version` column. */
  restoredFromVersion: number | null;
  /** The `client_batch_id` column. */
  clientBatchId: string | null;
  /** The `created_at` column. */
  createdAt: Date;
  /** The author, when the query included one. */
  author?: {
    /** The author's id. */
    id: string;
    /** The name the author chose. */
    displayName: string | null;
    /** The name the sign-in provider gave. */
    providerDisplayName: string | null;
    /** The author's email address. */
    email: string;
  } | null;
}

/**
 * A row of `note_exports`.
 *
 * @stability experimental
 */
export interface NoteExportRow {
  /** The `id` column. */
  id: string;
  /** The `note_id` column. */
  noteId: string;
  /** The `version` column. */
  version: number;
  /** The `format` column. */
  format: string;
  /** The `options` column. */
  options: JsonValue;
  /** The `options_hash` column. */
  optionsHash: string;
  /** The `status` column. */
  status: NoteExportStatusValue;
  /** The `object_id` column. */
  objectId: string | null;
  /** The `job_id` column. */
  jobId: string | null;
  /** The `requested_by_id` column. */
  requestedById: string;
  /** The `error` column. */
  error: string | null;
  /** The `expires_at` column. */
  expiresAt: Date;
  /** The `created_at` column. */
  createdAt: Date;
}

/**
 * A row of `note_libraries`.
 *
 * @stability experimental
 */
export interface NoteLibraryRow {
  /** The `id` column. */
  id: string;
  /** The `owner_id` column. */
  ownerId: string;
  /** The `name` column. */
  name: string;
  /** The `auto_extract` column. */
  autoExtract: boolean;
  /** The `auto_commit` column. */
  autoCommit: boolean;
  /** The `last_scan_at` column. */
  lastScanAt: Date | null;
  /** The `created_at` column. */
  createdAt: Date;
  /** The `updated_at` column. */
  updatedAt: Date;
}

/**
 * A row of `note_library_files`.
 *
 * @stability experimental
 */
export interface NoteLibraryFileRow {
  /** The `id` column. */
  id: string;
  /** The `library_id` column. */
  libraryId: string;
  /** The `relative_path` column. */
  relativePath: string;
  /** The `size` column (BigInt in the database). */
  size: bigint | number;
  /** The `mtime` column. */
  mtime: Date;
  /** The `content_hash` column. */
  contentHash: string | null;
  /** The `note_id` column. */
  noteId: string | null;
  /** The `imported_version` column. */
  importedVersion: number | null;
  /** The `extracted_version` column. */
  extractedVersion: number | null;
  /** The `status` column. */
  status: 'pending' | 'importing' | 'imported' | 'failed' | 'missing' | 'unsupported' | 'diverged';
  /** The `failure_reason` column. */
  failureReason: string | null;
  /** The `last_seen_at` column. */
  lastSeenAt: Date;
  /** The `created_at` column. */
  createdAt: Date;
  /** The `updated_at` column. */
  updatedAt: Date;
}

/**
 * A row of `note_import_batches`.
 *
 * @stability experimental
 */
export interface NoteImportBatchRow {
  /** The `id` column. */
  id: string;
  /** The `owner_id` column. */
  ownerId: string;
  /** The `library_id` column. */
  libraryId: string | null;
  /** The `status` column. */
  status: 'scanning' | 'running' | 'completed' | 'completed_with_errors' | 'cancelled';
  /** The `created_at` column. */
  createdAt: Date;
  /** The `finished_at` column. */
  finishedAt: Date | null;
}

/**
 * A row of `note_import_batch_items`.
 *
 * @stability experimental
 */
export interface NoteImportBatchItemRow {
  /** The `id` column. */
  id: string;
  /** The `batch_id` column. */
  batchId: string;
  /** The `file_id` column. */
  fileId: string | null;
  /** The `filename` column. */
  filename: string;
  /** The `path` column. */
  path: string | null;
  /** The `action` column. */
  action: 'new' | 'changed' | 'missing';
  /** The `source_object_id` column. */
  sourceObjectId: string | null;
  /** The `note_id` column. */
  noteId: string | null;
  /** The `note_version` column. */
  noteVersion: number | null;
  /** The `diverged` column. */
  diverged: boolean;
  /** The `status` column. */
  status: 'queued' | 'importing' | 'imported' | 'failed' | 'missing' | 'skipped';
  /** The `failure_reason` column. */
  failureReason: string | null;
  /** The `job_id` column. */
  jobId: string | null;
  /** The `created_at` column. */
  createdAt: Date;
  /** The `updated_at` column. */
  updatedAt: Date;
}

/**
 * The columns of `kg_proposals` the import batch view reads (the graph slice owns the table).
 *
 * @stability experimental
 */
export interface NoteProposalRef {
  /** The `id` column. */
  id: string;
  /** The `note_id` column. */
  noteId: string | null;
  /** The `note_version` column. */
  noteVersion: number | null;
  /** The `status` column. */
  status: string;
  /** The `created_at` column. */
  createdAt: Date;
}

/**
 * The delegates the slice works with, shared by the client and a transaction.
 *
 * @stability experimental
 */
export interface KvoxNotesDelegates {
  /** `notes`. */
  note: RowDelegate<NoteRow>;
  /** `note_templates`. */
  noteTemplate: RowDelegate<NoteTemplateRow> & {
    /** Inserts the row or updates the one with the same key (the built-in seed). */
    upsert(args: { where: any; update: any; create: any }): Promise<NoteTemplateRow>;
  };
  /** `user_hidden_note_templates`. */
  userHiddenNoteTemplate: RowDelegate<UserHiddenNoteTemplateRow> & {
    /** Inserts the row or leaves the existing one. */
    upsert(args: { where: any; create: any; update: any }): Promise<UserHiddenNoteTemplateRow>;
  };
  /** `note_generations`. */
  noteGeneration: RowDelegate<NoteGenerationRow>;
  /** `note_versions`. */
  noteVersion: RowDelegate<NoteVersionRow>;
  /** `note_exports`. */
  noteExport: RowDelegate<NoteExportRow>;
  /** `transcripts` (reads only: the source of a note). */
  transcript: Pick<RowDelegate<TranscriptRow>, 'findUnique' | 'findFirst' | 'findMany'>;
  /** `transcript_versions` (reads only). */
  transcriptVersion: Pick<RowDelegate<TranscriptVersionRow>, 'findUnique'>;
  /** `note_libraries` (#714). */
  noteLibrary: RowDelegate<NoteLibraryRow>;
  /** `note_library_files` (#714). */
  noteLibraryFile: RowDelegate<NoteLibraryFileRow> & {
    /** Counts files grouped by a column. */
    groupBy(args: any): Promise<any[]>;
  };
  /** `note_import_batches` (#714). */
  noteImportBatch: RowDelegate<NoteImportBatchRow>;
  /** `note_import_batch_items` (#714). */
  noteImportBatchItem: RowDelegate<NoteImportBatchItemRow> & {
    /** Counts items grouped by a column. */
    groupBy(args: any): Promise<any[]>;
  };
  /** `kg_proposals` (reads only: the stage of an imported note). */
  kgProposal: Pick<RowDelegate<NoteProposalRef>, 'findMany'>;
}

/**
 * The client inside an interactive transaction.
 *
 * @stability experimental
 */
export interface KvoxNotesTx extends KvoxNotesDelegates {
  /** Runs a raw query and returns its rows. */
  $queryRaw<T = unknown>(query: TemplateStringsArray | KvoxSql, ...values: unknown[]): Promise<T>;
  /** Runs a raw statement and returns the affected row count. */
  $executeRaw(query: TemplateStringsArray | KvoxSql, ...values: unknown[]): Promise<number>;
}

/**
 * The narrowed client the slice injects through `KVOX_PRISMA`.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface KvoxNotesDb extends KvoxPrismaClientLike, KvoxNotesDelegates {
  /**
   * Runs a callback in a transaction on the narrowed transaction client.
   *
   * @param fn - receives the transaction client.
   * @param options - an optional timeout and isolation level.
   */
  $transaction<T>(fn: (tx: KvoxNotesTx) => Promise<T>, options?: KvoxTransactionOptions): Promise<T>;
  /**
   * Runs prepared queries in one transaction and returns their results, in order.
   *
   * @param queries - the queries.
   * @param options - an optional timeout and isolation level.
   */
  $transaction<const Q extends readonly unknown[]>(
    queries: [...Q],
    options?: KvoxTransactionOptions,
  ): Promise<{ -readonly [K in keyof Q]: Awaited<Q[K]> }>;
}

export type { BatchResult, DelegateArgs, InputJsonValue, JsonValue };
