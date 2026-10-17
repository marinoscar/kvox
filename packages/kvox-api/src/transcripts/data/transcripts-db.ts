import type { KvoxPrismaClientLike, KvoxSql, KvoxTransactionOptions } from '../../ports/index.js';
import type { SegmentOriginValue, WordsAlignmentValue } from '../editing/editing-state.js';
import type { InputJsonValue, JsonValue } from './prisma.js';

// =============================================================================
// The transcripts slice's view of the database (issue #493, epic #491)
// =============================================================================
//
// The slice never imports a generated Prisma client. It declares, here, the
// STRUCTURAL row type of every table it owns and the narrowed client type it
// injects through `KVOX_PRISMA` (`KvoxTranscriptsDb`). The application proves its
// real client satisfies this type with a compile-time assignment in
// `apps/api/test/kvox/prisma-shape.typecheck.ts`, so a schema change that breaks
// the slice fails the typecheck, not production.
//
// THE DELEGATES TAKE LOOSE ARGUMENTS ON PURPOSE. A generated delegate is generic in
// its arguments (`SelectSubset<T, FindManyArgs>`) and a structural interface cannot
// restate that: an interface method with an exact argument type is satisfied by the
// generated one, one with a type parameter on the result is not. So each method takes
// `any` arguments and answers the row type; a call with `select` still returns the
// narrower object at run time, which a caller that reads only the selected columns
// never notices. The shape proof is what keeps the column NAMES honest.
//
// COLUMNS: copied from `kvox.transcripts.prisma` in `@marinoscar/kvox-db`, which
// owns the schema. The enums are string unions of its enum members.
//
// TABLES THE SLICE READS BUT DOES NOT OWN, with the columns it uses:
//   • `organizations`  the default organization, when a principal carries none.
//   • `users`          an owner's display name, for the list and detail rows.
//   • `notes`          `source_transcript_id`, cleared when its transcript is purged.
// =============================================================================

/** The `TranscriptStatus` enum. @stability experimental */
export const TRANSCRIPT_DB_STATUSES = ['uploading', 'processing', 'ready', 'failed', 'deleting'] as const;
/** The `TranscriptStatus` enum's member type. @stability experimental */
export type TranscriptStatusValue = (typeof TRANSCRIPT_DB_STATUSES)[number];

/** The `TranscriptionStatus` enum. @stability experimental */
export type TranscriptionStatusValue =
  | 'waiting_input'
  | 'queued'
  | 'submitting'
  | 'submitted'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** The `PlaybackStatus` enum. @stability experimental */
export type PlaybackStatusValue = 'pending' | 'processing' | 'ready' | 'failed' | 'not_needed';

/** The `TranscriptVersionKind` enum. @stability experimental */
export type TranscriptVersionKindValue = 'ai_original' | 'edit' | 'restore';

/** The `TranscriptExportStatus` enum. @stability experimental */
export type TranscriptExportStatusValue = 'pending' | 'ready' | 'failed';

/** The `TranscriptNameCheckMode` enum. @stability experimental */
export type TranscriptNameCheckModeValue = 'standard' | 'thorough';

/** The `TranscriptNameCheckStatus` enum. @stability experimental */
export type TranscriptNameCheckStatusValue = 'pending' | 'running' | 'ready' | 'failed';

/** The `TranscriptNameSuggestionStatus` enum. @stability experimental */
export type TranscriptNameSuggestionStatusValue = 'pending' | 'accepted' | 'rejected' | 'stale';

/**
 * A row of `transcripts`.
 *
 * @stability experimental
 */
export interface TranscriptRow {
  /** The `id` column. */
  id: string;
  /** The `owner_id` column. */
  ownerId: string;
  /** The `org_id` column. */
  orgId: string;
  /** The `title` column. */
  title: string;
  /** The `language` column. */
  language: string | null;
  /** The `status` column. */
  status: TranscriptStatusValue;
  /** The `transcription_status` column. */
  transcriptionStatus: TranscriptionStatusValue;
  /** The `playback_status` column. */
  playbackStatus: PlaybackStatusValue;
  /** The `source_object_id` column. */
  sourceObjectId: string;
  /** The `playback_object_id` column. */
  playbackObjectId: string | null;
  /** The `raw_result_object_id` column. */
  rawResultObjectId: string | null;
  /** The `provider` column. */
  provider: string;
  /** The `provider_job_id` column. */
  providerJobId: string | null;
  /** The `provider_options` column. */
  providerOptions: JsonValue | null;
  /** The `submitted_at` column. */
  submittedAt: Date | null;
  /** The `last_polled_at` column. */
  lastPolledAt: Date | null;
  /** The `completed_at` column. */
  completedAt: Date | null;
  /** The `remote_deleted_at` column. */
  remoteDeletedAt: Date | null;
  /** The `deleted_at` column. */
  deletedAt: Date | null;
  /** The `created_at` column. */
  createdAt: Date;
  /** The `updated_at` column. */
  updatedAt: Date;
  /** The `recorded_at` column. */
  recordedAt: Date;
  /** The `duration_ms` column. */
  durationMs: number | null;
  /** The `failure_reason` column. */
  failureReason: string | null;
  /** The `current_version` column. */
  currentVersion: number;
  /** The `speaker_count` column. */
  speakerCount: number;
  /** The `word_count` column. */
  wordCount: number;
  /** The `speaker_identities` column. */
  speakerIdentities: JsonValue;
}

/**
 * A row of `transcript_speakers`.
 *
 * @stability experimental
 */
export interface TranscriptSpeakerRow {
  /** The `id` column. */
  id: string;
  /** The `transcript_id` column. */
  transcriptId: string;
  /** The `label` column. */
  label: string | null;
  /** The `display_name` column. */
  displayName: string;
  /** The `color_index` column. */
  colorIndex: number;
  /** The `rev` column. */
  rev: number;
}

/**
 * A row of `transcript_segments`.
 *
 * @stability experimental
 */
export interface TranscriptSegmentRow {
  /** The `id` column. */
  id: string;
  /** The `transcript_id` column. */
  transcriptId: string;
  /** The `speaker_id` column. */
  speakerId: string;
  /** The `start_ms` column. */
  startMs: number;
  /** The `end_ms` column. */
  endMs: number;
  /** The `ordinal` column. */
  ordinal: number;
  /** The `text` column. */
  text: string;
  /** The `words` column. */
  words: JsonValue;
  /** The `words_alignment` column. */
  wordsAlignment: WordsAlignmentValue;
  /** The `confidence` column. */
  confidence: number | null;
  /** The `origin` column. */
  origin: SegmentOriginValue;
  /** The `rev` column. */
  rev: number;
  /** The `edited_by_id` column. */
  editedById: string | null;
  /** The `edited_at` column. */
  editedAt: Date | null;
}

/**
 * A row of `transcript_versions`.
 *
 * @stability experimental
 */
export interface TranscriptVersionRow {
  /** The `id` column. */
  id: string;
  /** The `transcript_id` column. */
  transcriptId: string;
  /** The `version` column. */
  version: number;
  /** The `kind` column. */
  kind: TranscriptVersionKindValue;
  /** The `author_id` column. */
  authorId: string | null;
  /** The `summary` column. */
  summary: string | null;
  /** The `ops` column. */
  ops: JsonValue;
  /** The `restored_from_version` column. */
  restoredFromVersion: number | null;
  /** The `snapshot_object_id` column. */
  snapshotObjectId: string | null;
  /** The `client_batch_id` column. */
  clientBatchId: string | null;
  /** The `created_at` column. */
  createdAt: Date;
}

/**
 * A row of `transcript_exports`.
 *
 * @stability experimental
 */
export interface TranscriptExportRow {
  /** The `id` column. */
  id: string;
  /** The `transcript_id` column. */
  transcriptId: string;
  /** The `version` column. */
  version: number;
  /** The `format` column. */
  format: string;
  /** The `options` column. */
  options: JsonValue;
  /** The `options_hash` column. */
  optionsHash: string;
  /** The `status` column. */
  status: TranscriptExportStatusValue;
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
 * A row of `transcript_name_checks`.
 *
 * @stability experimental
 */
export interface TranscriptNameCheckRow {
  /** The `id` column. */
  id: string;
  /** The `transcript_id` column. */
  transcriptId: string;
  /** The `requested_by_id` column. */
  requestedById: string | null;
  /** The `mode` column. */
  mode: TranscriptNameCheckModeValue;
  /** The `status` column. */
  status: TranscriptNameCheckStatusValue;
  /** The `based_on_version` column. */
  basedOnVersion: number;
  /** The `terms` column. */
  terms: JsonValue;
  /** The `provider_id` column. */
  providerId: string | null;
  /** The `model` column. */
  model: string | null;
  /** The `candidate_count` column. */
  candidateCount: number;
  /** The `suggestion_count` column. */
  suggestionCount: number;
  /** The `input_tokens` column. */
  inputTokens: number;
  /** The `output_tokens` column. */
  outputTokens: number;
  /** The `error_class` column. */
  errorClass: string | null;
  /** The `error` column. */
  error: string | null;
  /** The `job_id` column. */
  jobId: string | null;
  /** The `created_at` column. */
  createdAt: Date;
  /** The `started_at` column. */
  startedAt: Date | null;
  /** The `completed_at` column. */
  completedAt: Date | null;
}

/**
 * A row of `transcript_name_suggestions`.
 *
 * @stability experimental
 */
export interface TranscriptNameSuggestionRow {
  /** The `id` column. */
  id: string;
  /** The `check_id` column. */
  checkId: string;
  /** The `segment_id` column. */
  segmentId: string;
  /** The `segment_rev` column. */
  segmentRev: number;
  /** The `start` column. */
  start: number;
  /** The `end` column. */
  end: number;
  /** The `original` column. */
  original: string;
  /** The `replacement` column. */
  replacement: string;
  /** The `confidence` column. */
  confidence: number | null;
  /** The `reason` column. */
  reason: string | null;
  /** The `source` column. */
  source: string;
  /** The `status` column. */
  status: TranscriptNameSuggestionStatusValue;
  /** The `decided_at` column. */
  decidedAt: Date | null;
  /** The `decided_by_id` column. */
  decidedById: string | null;
  /** The `created_at` column. */
  createdAt: Date;
}

/**
 * The columns of `users` the slice reads: an owner's display name.
 *
 * @stability experimental
 */
export interface TranscriptUserRow {
  /** The `id` column. */
  id: string;
  /** The `display_name` column. */
  displayName: string | null;
  /** The `provider_display_name` column. */
  providerDisplayName: string | null;
  /** The `email` column. */
  email: string;
}

/**
 * The columns of `notes` the slice reads: which notes were generated from a transcript.
 *
 * @stability experimental
 */
export interface TranscriptNoteRow {
  /** The `id` column. */
  id: string;
  /** The `title` column. */
  title: string;
  /** The `source_transcript_id` column. */
  sourceTranscriptId: string | null;
  /** The `deleted_at` column. */
  deletedAt: Date | null;
  /** The `created_at` column. */
  createdAt: Date;
}

/**
 * The column of `organizations` the slice reads.
 *
 * @stability experimental
 */
export interface TranscriptOrganizationRow {
  /** The `id` column. */
  id: string;
  /** The `is_default` column. */
  isDefault: boolean;
}

/**
 * What a bulk write answers.
 *
 * @stability experimental
 */
export interface BatchResult {
  /** How many rows it touched. */
  count: number;
}

/**
 * The arguments of every delegate call, loose on purpose (see the file header).
 *
 * @stability experimental
 */
export interface DelegateArgs {
  /** The filter. */
  where?: any;
  /** The columns to return. */
  select?: any;
  /** The relations to load. */
  include?: any;
  /** The ordering. */
  orderBy?: any;
  /** The most rows to return. */
  take?: number;
  /** How many rows to skip. */
  skip?: number;
  /** The row to continue after. */
  cursor?: any;
  /** The columns that make rows distinct. */
  distinct?: any;
}

/**
 * A model delegate: the calls the slice makes, with the row type it gets back.
 *
 * @typeParam Row - the table's row type.
 * @stability experimental
 */
export interface RowDelegate<Row> {
  /** One row by a unique key, or `null`. */
  findUnique(args: DelegateArgs & { where: any }): Promise<Row | null>;
  /** One row by a unique key; rejects when there is none. */
  findUniqueOrThrow(args: DelegateArgs & { where: any }): Promise<Row>;
  /** The first row matching, or `null`. */
  findFirst(args?: DelegateArgs): Promise<Row | null>;
  /** The rows matching. */
  findMany(args?: DelegateArgs): Promise<Row[]>;
  /** Inserts one row. */
  create(args: { data: any; select?: any }): Promise<Row>;
  /** Inserts many rows. */
  createMany(args: { data: any[]; skipDuplicates?: boolean }): Promise<BatchResult>;
  /** Updates the row with a unique key. */
  update(args: { where: any; data: any; select?: any }): Promise<Row>;
  /** Updates every row matching. */
  updateMany(args: { where?: any; data: any }): Promise<BatchResult>;
  /** Deletes the row with a unique key. */
  delete(args: { where: any }): Promise<Row>;
  /** Deletes every row matching. */
  deleteMany(args?: { where?: any }): Promise<BatchResult>;
  /** Counts the rows matching. */
  count(args?: { where?: any; select?: any }): Promise<number>;
}

/**
 * The delegates the slice works with, shared by the client and a transaction.
 *
 * @stability experimental
 */
export interface KvoxTranscriptsDelegates {
  /** `transcripts`. */
  transcript: RowDelegate<TranscriptRow>;
  /** `transcript_speakers`. */
  transcriptSpeaker: RowDelegate<TranscriptSpeakerRow>;
  /** `transcript_segments`. */
  transcriptSegment: RowDelegate<TranscriptSegmentRow>;
  /** `transcript_versions`. */
  transcriptVersion: RowDelegate<TranscriptVersionRow>;
  /** `transcript_exports`. */
  transcriptExport: RowDelegate<TranscriptExportRow>;
  /** `transcript_name_checks`. */
  transcriptNameCheck: RowDelegate<TranscriptNameCheckRow>;
  /** `transcript_name_suggestions`. */
  transcriptNameSuggestion: RowDelegate<TranscriptNameSuggestionRow>;
  /** `users` (reads only: an owner's display name). */
  user: Pick<RowDelegate<TranscriptUserRow>, 'findUnique' | 'findMany'>;
  /** `organizations` (reads only: the default organization). */
  organization: Pick<RowDelegate<TranscriptOrganizationRow>, 'findFirst'>;
  /** `notes` (the dependent-notes guard on delete, and clearing `source_transcript_id` of a purged transcript's notes). */
  note: {
    /** The notes matching. */
    findMany(args?: DelegateArgs): Promise<TranscriptNoteRow[]>;
    /** Updates every note matching. */
    updateMany(args: { where?: any; data: any }): Promise<BatchResult>;
  };
}

/**
 * The client inside an interactive transaction.
 *
 * @stability experimental
 */
export interface KvoxTranscriptsTx extends KvoxTranscriptsDelegates {
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
export interface KvoxTranscriptsDb extends KvoxPrismaClientLike, KvoxTranscriptsDelegates {
  /**
   * Runs a callback in a transaction on the narrowed transaction client.
   *
   * @param fn - receives the transaction client.
   * @param options - an optional timeout and isolation level.
   */
  $transaction<T>(fn: (tx: KvoxTranscriptsTx) => Promise<T>, options?: KvoxTransactionOptions): Promise<T>;
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

export type { InputJsonValue, JsonValue };
