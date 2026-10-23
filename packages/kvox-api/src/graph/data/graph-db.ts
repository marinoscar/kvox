import type { KvoxPrismaClientLike, KvoxSql, KvoxTransactionOptions } from '../../ports/index.js';
import type { NoteRow, NoteVersionRow } from '../../notes/index.js';
import type {
  BatchResult,
  DelegateArgs,
  RowDelegate,
  TranscriptRow,
  TranscriptSegmentRow,
  TranscriptSpeakerRow,
} from '../../transcripts/index.js';
import type { InputJsonValue, JsonValue } from './prisma.js';
import { KVOX_PRISMA } from '../../ports/index.js';

// =============================================================================
// The graph slice's view of the database (issue #496, epic #491)
// =============================================================================
//
// The slice never imports a generated Prisma client. It declares, here, the
// STRUCTURAL row type of every table it owns and the narrowed client type it
// injects through `KVOX_PRISMA` (`KvoxGraphDb`). The application proves its real
// client satisfies this type with a compile-time assignment in
// `apps/api/test/kvox/prisma-shape.typecheck.ts`, so a schema change that breaks
// the slice fails the typecheck, not production.
//
// THE DELEGATES TAKE LOOSE ARGUMENTS ON PURPOSE (see `transcripts-db.ts`): each
// method takes `any` arguments and answers the row type, and a call with `select`
// or `include` still returns the narrower object at run time.
//
// COLUMNS: copied from `kvox.graph.prisma` in `@marinoscar/kvox-db`, which owns the
// schema. The enums are string unions of its enum members. THE `valid` (`tstzrange`) AND
// `embedding` (`vector`) COLUMNS ARE `Unsupported` in Prisma and so absent from every row
// type: they are read and written with raw SQL, exactly as before the move.
//
// TABLES THE SLICE READS BUT DOES NOT OWN: `transcripts`, `transcript_segments`,
// `transcript_speakers`, `notes` and `note_versions` (the evidence a claim cites). The
// audit log, the job queue, user settings and stored objects are reached through ports.
// =============================================================================

/** The `KgReviewStatus` enum. @stability experimental */
export type KgReviewStatusValue = 'unreviewed' | 'accepted' | 'edited' | 'rejected' | 'merged' | 'superseded';

/** The `KgValidPrecision` enum. @stability experimental */
export type KgValidPrecisionValue = 'day' | 'month' | 'year' | 'unknown';

/** The `KgItemKind` enum. @stability experimental */
export type KgItemKindValue = 'commitment' | 'decision' | 'claim' | 'person_fact' | 'risk';

/** The `KgSensitivity` enum. @stability experimental */
export type KgSensitivityValue = 'business' | 'personal' | 'sensitive';

/** The `KgAliasSource` enum. @stability experimental */
export type KgAliasSourceValue = 'user' | 'extraction' | 'speaker_naming' | 'import';

/** The `KgEvidenceSubjectKind` enum. @stability experimental */
export type KgEvidenceSubjectKindValue = 'entity' | 'relation' | 'item' | 'proposal_item' | 'import';

/** The `KgMentionStatus` enum. @stability experimental */
export type KgMentionStatusValue = 'suggested' | 'linked' | 'new' | 'ignored';

/** The `KgProposalKind` enum. @stability experimental */
export type KgProposalKindValue = 'extraction' | 'import' | 'resolution';

/** The `KgProposalStatus` enum. @stability experimental */
export type KgProposalStatusValue = 'draft' | 'extracting' | 'committed' | 'discarded' | 'failed' | 'reverted';

/** The `KgProposalItemKind` enum. @stability experimental */
export type KgProposalItemKindValue = 'entity' | 'relation' | 'item' | 'closing';

/** The `KgProposalItemDecision` enum. @stability experimental */
export type KgProposalItemDecisionValue = 'pending' | 'accept' | 'edit' | 'reject' | 'merge_into';

/** The `KgProposalItemOrigin` enum. @stability experimental */
export type KgProposalItemOriginValue = 'ai' | 'user';

/** The `KgAttributeKind` enum. @stability experimental */
export type KgAttributeKindValue = 'text' | 'number' | 'date' | 'boolean' | 'select' | 'multi_select' | 'url' | 'entity_ref';

/** The `KgExportFormat` enum. @stability experimental */
export type KgExportFormatValue = 'jsonld' | 'turtle' | 'nquads';

/** The `KgExportStatus` enum. @stability experimental */
export type KgExportStatusValue = 'pending' | 'running' | 'ready' | 'failed';

/**
 * A row of `kg_entities`.
 *
 * @stability experimental
 */
export interface KgEntityRow {
  /** The `id` column. */
  id: string;
  /** The `owner_id` column. */
  ownerId: string;
  /** The `type` column. */
  type: string;
  /** The `label` column. */
  label: string;
  /** The `props` column. */
  props: JsonValue;
  /** The `embedding_model` column. */
  embeddingModel: string | null;
  /** The `embedding_hash` column. */
  embeddingHash: string | null;
  /** The `review_status` column. */
  reviewStatus: KgReviewStatusValue;
  /** The `merged_into_id` column. */
  mergedIntoId: string | null;
  /** The `occurred_at` column. */
  occurredAt: Date | null;
  /** The `ontology_version` column. */
  ontologyVersion: string;
  /** The `created_at` column. */
  createdAt: Date;
  /** The `updated_at` column. */
  updatedAt: Date;
  /** The aliases, when the query included them. */
  aliases?: any;
  /** Relation counts, when the query asked for them. */
  _count?: any;
  /** The digest, when the query included it. */
  digest?: any;
  /** The relations pointing here, when the query included them. */
  relationsTo?: any;
  /** The relations leaving here, when the query included them. */
  relationsFrom?: any;
}

/**
 * A row of `kg_entity_aliases`.
 *
 * @stability experimental
 */
export interface KgEntityAliasRow {
  /** The `id` column. */
  id: string;
  /** The `entity_id` column. */
  entityId: string;
  /** The `owner_id` column. */
  ownerId: string;
  /** The `alias` column. */
  alias: string;
  /** The `normalized` column. */
  normalized: string;
  /** The `source` column. */
  source: KgAliasSourceValue;
  /** The `created_at` column. */
  createdAt: Date;
}

/**
 * A row of `kg_relations`.
 *
 * @stability experimental
 */
export interface KgRelationRow {
  /** The `id` column. */
  id: string;
  /** The `owner_id` column. */
  ownerId: string;
  /** The `type` column. */
  type: string;
  /** The `from_id` column. */
  fromId: string | null;
  /** The `from_speaker_id` column. */
  fromSpeakerId: string | null;
  /** The `to_id` column. */
  toId: string;
  /** The `props` column. */
  props: JsonValue;
  /** The `valid_precision` column. */
  validPrecision: KgValidPrecisionValue | null;
  /** The `review_status` column. */
  reviewStatus: KgReviewStatusValue;
  /** The `confidence` column. */
  confidence: number | null;
  /** The `superseded_by_id` column. */
  supersededById: string | null;
  /** The `ontology_version` column. */
  ontologyVersion: string;
  /** The `created_at` column. */
  createdAt: Date;
  /** The `updated_at` column. */
  updatedAt: Date;
  /** The target entity, when the query included it. */
  toEntity?: any;
  /** The source entity, when the query included it. */
  fromEntity?: any;
}

/**
 * A row of `kg_items`.
 *
 * @stability experimental
 */
export interface KgItemRow {
  /** The `id` column. */
  id: string;
  /** The `owner_id` column. */
  ownerId: string;
  /** The `kind` column. */
  kind: KgItemKindValue;
  /** The `subject_id` column. */
  subjectId: string | null;
  /** The `meeting_id` column. */
  meetingId: string | null;
  /** The `owner_person_id` column. */
  ownerPersonId: string | null;
  /** The `counterparty_id` column. */
  counterpartyId: string | null;
  /** The `title` column. */
  title: string | null;
  /** The `statement` column. */
  statement: string;
  /** The `status` column. */
  status: string;
  /** The `props` column. */
  props: JsonValue;
  /** The `occurred_at` column. */
  occurredAt: Date | null;
  /** The `due_at` column. */
  dueAt: Date | null;
  /** The `superseded_by_id` column. */
  supersededById: string | null;
  /** The `sensitivity` column. */
  sensitivity: KgSensitivityValue | null;
  /** The `statement_hash` column. */
  statementHash: string;
  /** The `valid_precision` column. */
  validPrecision: KgValidPrecisionValue | null;
  /** The `embedding_model` column. */
  embeddingModel: string | null;
  /** The `embedding_hash` column. */
  embeddingHash: string | null;
  /** The `review_status` column. */
  reviewStatus: KgReviewStatusValue;
  /** The `confidence` column. */
  confidence: number | null;
  /** The `ontology_version` column. */
  ontologyVersion: string;
  /** The `created_at` column. */
  createdAt: Date;
  /** The `updated_at` column. */
  updatedAt: Date;
  /** The subject entity, when the query included it. */
  subject?: any;
  /** The owner person, when the query included it. */
  ownerPerson?: any;
  /** The counterparty, when the query included it. */
  counterparty?: any;
}

/**
 * A row of `kg_evidence`.
 *
 * @stability experimental
 */
export interface KgEvidenceRow {
  /** The `id` column. */
  id: string;
  /** The `owner_id` column. */
  ownerId: string;
  /** The `subject_kind` column. */
  subjectKind: KgEvidenceSubjectKindValue;
  /** The `subject_id` column. */
  subjectId: string;
  /** The `transcript_id` column. */
  transcriptId: string | null;
  /** The `segment_id` column. */
  segmentId: string | null;
  /** The `segment_rev` column. */
  segmentRev: number | null;
  /** The `start_ms` column. */
  startMs: number | null;
  /** The `end_ms` column. */
  endMs: number | null;
  /** The `note_id` column. */
  noteId: string | null;
  /** The `note_version` column. */
  noteVersion: number | null;
  /** The `char_start` column. */
  charStart: number | null;
  /** The `char_end` column. */
  charEnd: number | null;
  /** The `quote` column. */
  quote: string;
  /** The `import_object_id` column. */
  importObjectId: string | null;
  /** The `source_iri` column. */
  sourceIri: string | null;
  /** The `created_at` column. */
  createdAt: Date;
}

/**
 * A row of `kg_mentions`.
 *
 * @stability experimental
 */
export interface KgMentionRow {
  /** The `id` column. */
  id: string;
  /** The `owner_id` column. */
  ownerId: string;
  /** The `entity_id` column. */
  entityId: string;
  /** The `note_id` column. */
  noteId: string | null;
  /** The `transcript_id` column. */
  transcriptId: string | null;
  /** The `span` column. */
  span: JsonValue | null;
  /** The `status` column. */
  status: KgMentionStatusValue;
  /** The `score` column. */
  score: number | null;
  /** The `created_at` column. */
  createdAt: Date;
}

/**
 * A row of `kg_proposals`.
 *
 * @stability experimental
 */
export interface KgProposalRow {
  /** The `id` column. */
  id: string;
  /** The `owner_id` column. */
  ownerId: string;
  /** The `kind` column. */
  kind: KgProposalKindValue;
  /** The `status` column. */
  status: KgProposalStatusValue;
  /** The `note_id` column. */
  noteId: string | null;
  /** The `note_version` column. */
  noteVersion: number | null;
  /** The `model` column. */
  model: string | null;
  /** The `provider` column. */
  provider: string | null;
  /** The `system_prompt` column. */
  systemPrompt: string | null;
  /** The `user_content` column. */
  userContent: string | null;
  /** The `user_guidance` column. */
  userGuidance: JsonValue | null;
  /** The `stats` column. */
  stats: JsonValue;
  /** The `committed_at` column. */
  committedAt: Date | null;
  /** The `reverted_at` column. */
  revertedAt: Date | null;
  /** The `job_id` column. */
  jobId: string | null;
  /** The `commit_log` column. */
  commitLog: JsonValue | null;
  /** The `created_at` column. */
  createdAt: Date;
  /** The `updated_at` column. */
  updatedAt: Date;
  /** The rows, when the query included them. */
  items?: any;
}

/**
 * A row of `kg_proposal_items`.
 *
 * @stability experimental
 */
export interface KgProposalItemRow {
  /** The `id` column. */
  id: string;
  /** The `proposal_id` column. */
  proposalId: string;
  /** The `kind` column. */
  kind: KgProposalItemKindValue;
  /** The `payload` column. */
  payload: JsonValue;
  /** The `resolution` column. */
  resolution: JsonValue | null;
  /** The `edited_payload` column. */
  editedPayload: JsonValue | null;
  /** The `decision` column. */
  decision: KgProposalItemDecisionValue;
  /** The `flags` column. */
  flags: string[];
  /** The `origin` column. */
  origin: KgProposalItemOriginValue;
  /** The `merge_into_id` column. */
  mergeIntoId: string | null;
  /** The `distinct_from` column. */
  distinctFrom: string[];
  /** The `committed_ref_id` column. */
  committedRefId: string | null;
  /** The `sort_order` column. */
  sortOrder: number;
  /** The `created_at` column. */
  createdAt: Date;
  /** The `updated_at` column. */
  updatedAt: Date;
}

/**
 * A row of `kg_merges`.
 *
 * @stability experimental
 */
export interface KgMergeRow {
  /** The `id` column. */
  id: string;
  /** The `owner_id` column. */
  ownerId: string;
  /** The `survivor_id` column. */
  survivorId: string;
  /** The `merged_id` column. */
  mergedId: string;
  /** The `reversal` column. */
  reversal: JsonValue;
  /** The `reversed_at` column. */
  reversedAt: Date | null;
  /** The `created_at` column. */
  createdAt: Date;
}

/**
 * A row of `kg_distinct_pairs`.
 *
 * @stability experimental
 */
export interface KgDistinctPairRow {
  /** The `owner_id` column. */
  ownerId: string;
  /** The `a_id` column. */
  aId: string;
  /** The `b_id` column. */
  bId: string;
  /** The `created_at` column. */
  createdAt: Date;
}

/**
 * A row of `kg_attribute_defs`.
 *
 * @stability experimental
 */
export interface KgAttributeDefRow {
  /** The `id` column. */
  id: string;
  /** The `owner_id` column. */
  ownerId: string;
  /** The `entity_type` column. */
  entityType: string;
  /** The `key` column. */
  key: string;
  /** The `label` column. */
  label: string;
  /** The `kind` column. */
  kind: KgAttributeKindValue;
  /** The `options` column. */
  options: JsonValue | null;
  /** The `extractable` column. */
  extractable: boolean;
  /** The `extraction_hint` column. */
  extractionHint: string | null;
  /** The `sensitivity` column. */
  sensitivity: KgSensitivityValue | null;
  /** The `sort_order` column. */
  sortOrder: number;
  /** The `deprecated_at` column. */
  deprecatedAt: Date | null;
  /** The `created_at` column. */
  createdAt: Date;
  /** The `updated_at` column. */
  updatedAt: Date;
}

/**
 * A row of `kg_entity_digests`.
 *
 * @stability experimental
 */
export interface KgEntityDigestRow {
  /** The `entity_id` column. */
  entityId: string;
  /** The `owner_id` column. */
  ownerId: string;
  /** The `summary` column. */
  summary: string;
  /** The `citations` column. */
  citations: JsonValue;
  /** The `covers_until` column. */
  coversUntil: Date;
  /** The `model` column. */
  model: string;
  /** The `generated_at` column. */
  generatedAt: Date;
}

/**
 * A row of `kg_entity_views`.
 *
 * @stability experimental
 */
export interface KgEntityViewRow {
  /** The `id` column. */
  id: string;
  /** The `user_id` column. */
  userId: string;
  /** The `entity_id` column. */
  entityId: string;
  /** The `last_viewed_at` column. */
  lastViewedAt: Date;
}

/**
 * A row of `kg_exports`.
 *
 * @stability experimental
 */
export interface KgExportRow {
  /** The `id` column. */
  id: string;
  /** The `owner_id` column. */
  ownerId: string;
  /** The `format` column. */
  format: KgExportFormatValue;
  /** The `status` column. */
  status: KgExportStatusValue;
  /** The `graph_fingerprint` column. */
  graphFingerprint: string;
  /** The `ontology_version` column. */
  ontologyVersion: string;
  /** The `object_id` column. */
  objectId: string | null;
  /** The `stats` column. */
  stats: JsonValue;
  /** The `error_message` column. */
  errorMessage: string | null;
  /** The `job_id` column. */
  jobId: string | null;
  /** The `expires_at` column. */
  expiresAt: Date;
  /** The `created_at` column. */
  createdAt: Date;
}

/**
 * A row of `kg_graph_layouts`.
 *
 * @stability experimental
 */
export interface KgGraphLayoutRow {
  /** The `id` column. */
  id: string;
  /** The `owner_id` column. */
  ownerId: string;
  /** The `computed_at` column. */
  computedAt: Date;
  /** The `node_count` column. */
  nodeCount: number;
  /** The `edge_count` column. */
  edgeCount: number;
  /** The `clusters` column. */
  clusters: JsonValue;
  /** The `positions` column. */
  positions: JsonValue;
  /** The `ontology_version` column. */
  ontologyVersion: string;
  /** The `source_updated_at` column. */
  sourceUpdatedAt: Date | null;
}

/**
 * A write that creates the row or updates the one with the same key.
 *
 * @stability experimental
 */
export interface GraphUpsert<Row> {
  /** Inserts the row, or updates the one `where` names. */
  /**
   * The where.
   */
  /**
   * The where.
   */
  upsert(args: { where: any; update: any; create: any }): Promise<Row>;
}

/**
 * A bulk insert that answers the rows it created.
 *
 * @stability experimental
 */
export interface GraphCreateManyAndReturn<Row> {
  /** Inserts the rows and answers them. */
  /**
   * The skip duplicates.
   */
  /**
   * The skip duplicates.
   */
  createManyAndReturn(args: { data: any[]; skipDuplicates?: boolean; select?: any }): Promise<Row[]>;
}

/**
 * A grouped aggregate over a table.
 *
 * @stability experimental
 */
export interface GraphGroupBy {
  /** Groups rows and aggregates; the result shape follows the arguments. */
  groupBy(args: any): Promise<any[]>;
}

/**
 * The delegates the slice works with, shared by the client and a transaction.
 *
 * @stability experimental
 */
export interface KvoxGraphDelegates {
  /** `kg_entities`. */
  kgEntity: RowDelegate<KgEntityRow>;
  /** `kg_entity_aliases`. */
  kgEntityAlias: RowDelegate<KgEntityAliasRow> & GraphCreateManyAndReturn<KgEntityAliasRow>;
  /** `kg_relations`. */
  kgRelation: RowDelegate<KgRelationRow>;
  /** `kg_items`. */
  kgItem: RowDelegate<KgItemRow>;
  /** `kg_evidence`. */
  kgEvidence: RowDelegate<KgEvidenceRow> & GraphCreateManyAndReturn<KgEvidenceRow> & GraphGroupBy;
  /** `kg_mentions`. */
  kgMention: RowDelegate<KgMentionRow> & GraphCreateManyAndReturn<KgMentionRow> & GraphGroupBy;
  /** `kg_proposals`. */
  kgProposal: RowDelegate<KgProposalRow>;
  /** `kg_proposal_items`. */
  kgProposalItem: RowDelegate<KgProposalItemRow>;
  /** `kg_merges`. */
  kgMerge: RowDelegate<KgMergeRow>;
  /** `kg_distinct_pairs`. */
  kgDistinctPair: RowDelegate<KgDistinctPairRow>;
  /** `kg_attribute_defs`. */
  kgAttributeDef: RowDelegate<KgAttributeDefRow>;
  /** `kg_entity_digests`. */
  kgEntityDigest: RowDelegate<KgEntityDigestRow> & GraphUpsert<KgEntityDigestRow>;
  /** `kg_entity_views`. */
  kgEntityView: RowDelegate<KgEntityViewRow> & GraphUpsert<KgEntityViewRow>;
  /** `kg_exports`. */
  kgExport: RowDelegate<KgExportRow>;
  /** `kg_graph_layouts`. */
  kgGraphLayout: RowDelegate<KgGraphLayoutRow>;
  /** `transcripts` (reads only: the evidence a claim cites). */
  transcript: Pick<RowDelegate<TranscriptRow>, 'findUnique' | 'findFirst' | 'findMany'>;
  /** `transcript_segments` (reads only). */
  transcriptSegment: Pick<RowDelegate<TranscriptSegmentRow>, 'findUnique' | 'findFirst' | 'findMany'>;
  /** `transcript_speakers` (reads only). */
  transcriptSpeaker: Pick<RowDelegate<TranscriptSpeakerRow>, 'findUnique' | 'findFirst' | 'findMany'>;
  /** `notes` (reads only). */
  note: Pick<RowDelegate<NoteRow>, 'findUnique' | 'findFirst' | 'findMany'>;
  /** `note_versions` (reads only). */
  noteVersion: Pick<RowDelegate<NoteVersionRow>, 'findUnique' | 'findFirst' | 'findMany'>;
  /** `note_import_batches` (reads only: the review queue's grouping, #717). */
  noteImportBatch: Pick<RowDelegate<GraphImportBatchRow>, 'findUnique' | 'findFirst' | 'findMany'>;
  /** `note_import_batch_items` (reads only: which batch produced a note version, #717). */
  noteImportBatchItem: Pick<RowDelegate<GraphImportBatchItemRow>, 'findUnique' | 'findFirst' | 'findMany'>;
  /** `note_libraries` (reads only: a group's label, #717). */
  noteLibrary: Pick<RowDelegate<GraphLibraryRow>, 'findUnique' | 'findFirst' | 'findMany'>;
  /** `note_library_files` (reads, and the one `extracted_version` write of #716). */
  noteLibraryFile: Pick<RowDelegate<GraphLibraryFileRow>, 'findFirst' | 'findMany' | 'updateMany'>;
}

/**
 * The columns of `note_library_files` the graph reads and stamps (#716).
 *
 * @stability experimental
 */
export interface GraphLibraryFileRow {
  /** The `id` column. */
  id: string;
  /** The `library_id` column. */
  libraryId: string;
  /** The `note_id` column. */
  noteId: string | null;
  /** The highest note version the graph extraction covered. */
  extractedVersion: number | null;
}

/**
 * The columns of `note_import_batches` the review queue reads (#717).
 *
 * @stability experimental
 */
export interface GraphImportBatchRow {
  /** The `id` column. */
  id: string;
  /** The `owner_id` column. */
  ownerId: string;
  /** The `library_id` column. */
  libraryId: string | null;
  /** The `created_at` column. */
  createdAt: Date;
}

/**
 * The columns of `note_import_batch_items` the review queue reads (#717).
 *
 * @stability experimental
 */
export interface GraphImportBatchItemRow {
  /** The `batch_id` column. */
  batchId: string;
  /** The `note_id` column. */
  noteId: string | null;
  /** The `note_version` column. */
  noteVersion: number | null;
}

/**
 * The columns of `note_libraries` the review queue reads (#717).
 *
 * @stability experimental
 */
export interface GraphLibraryRow {
  /** The `id` column. */
  id: string;
  /** The `owner_id` column. */
  ownerId: string;
  /** The `name` column. */
  name: string;
}

/**
 * The client inside an interactive transaction.
 *
 * @stability experimental
 */
export interface KvoxGraphTx extends KvoxGraphDelegates {
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
export interface KvoxGraphDb extends KvoxPrismaClientLike, KvoxGraphDelegates {
  /**
   * Runs a callback in a transaction on the narrowed transaction client.
   *
   * @param fn - receives the transaction client.
   * @param options - an optional timeout and isolation level.
   */
  $transaction<T>(fn: (tx: KvoxGraphTx) => Promise<T>, options?: KvoxTransactionOptions): Promise<T>;
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
