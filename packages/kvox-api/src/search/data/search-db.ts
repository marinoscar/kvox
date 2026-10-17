import type { KvoxPrismaClientLike } from '../../ports/index.js';

// =============================================================================
// The search slice's view of the database (issue #494, epic #491)
// =============================================================================
//
// The slice never imports a generated Prisma client. It declares, here, the
// STRUCTURAL row types of the three tables it owns and the narrowed client type
// it casts `KVOX_PRISMA` to once (`KvoxSearchDb`). The application proves its
// real client satisfies this type with a compile-time assignment in
// `apps/api/test/kvox/prisma-shape.typecheck.ts`, so a schema change that breaks
// the slice fails the typecheck, not production.
//
// WHAT IS DELEGATE AND WHAT IS RAW SQL
// -----------------------------------------------------------------------------
//
//   • `search_chunks`, `search_index_state` and the cascade-delete of
//     `search_embeddings` go through delegates (`searchChunk`, `searchIndexState`,
//     `searchEmbedding`): they are ordinary rows the slice owns.
//   • `search_embeddings.embedding` is `Unsupported("vector(1536)")` and
//     REQUIRED, so the generated client emits no `create` for the model and no
//     read of the column. Every write and every comparison of a vector is raw
//     SQL with the literal assembled by hand. That is intended, not a gap.
//   • `transcripts`, `transcript_segments`, `transcript_speakers`, `notes` and
//     the generated `tsvector` columns on them belong to the transcripts and
//     notes slices. Search READS them with raw SQL only (the typed result rows
//     below) and never imports that code: its dependency is on the tables'
//     existence, which `@marinoscar/kvox-db` installs, not on their owners.
// =============================================================================

/**
 * The indexing state of one document.
 *
 * @stability experimental
 */
export type SearchIndexStatus = 'pending' | 'indexing' | 'indexed' | 'failed' | 'skipped';

/**
 * A row of `search_chunks`: one chunk of a document's text.
 *
 * @stability experimental
 */
export interface SearchChunkRow {
  /** The chunk id. */
  id: string;
  /** `transcript` or `note` (plain text, no foreign key). */
  documentType: string;
  /** The document the chunk belongs to (no foreign key). */
  documentId: string;
  /** Position among the document's chunks, dense and 0-based. */
  ordinal: number;
  /** The chunk text as embedded, speaker labels or note title included. */
  text: string;
  /** sha256 of the final text: the content-addressing key. */
  contentHash: string;
  /** Offset of the chunk in the document's source text. */
  charStart: number;
  /** End offset of the chunk in the document's source text. */
  charEnd: number;
  /** When the row was created. */
  createdAt: Date;
}

/**
 * A row of `search_index_state`: one document's legibility surface.
 *
 * @stability experimental
 */
export interface SearchIndexStateRow {
  /** The row id. */
  id: string;
  /** `transcript` or `note`. */
  documentType: string;
  /** The document this row describes (no foreign key). */
  documentId: string;
  /** The document's owner: whose key indexing spends. */
  ownerId: string;
  /** Where indexing stands. */
  status: SearchIndexStatus;
  /** Why the document is not searchable by meaning, or `null`. */
  reason: string | null;
  /** How many chunks the current index holds. */
  chunkCount: number;
  /** The embeddings model of the current vectors, or `null`. */
  model: string | null;
  /** Hash of the whole document's chunks: one comparison answers "is anything stale". */
  contentFingerprint: string | null;
  /** The last unrecognised failure's message, or `null`. */
  lastError: string | null;
  /** When the document was last confirmed current, or `null`. */
  indexedAt: Date | null;
  /** When the row was created. */
  createdAt: Date;
  /** When the row last changed. */
  updatedAt: Date;
}

/**
 * The address every read and write of one document's state uses.
 *
 * @stability experimental
 */
export interface SearchDocumentKey {
  /** `transcript` or `note`. */
  documentType: string;
  /** The document id. */
  documentId: string;
}

/**
 * What a bulk delete answers.
 *
 * @stability experimental
 */
export interface SearchDeleteResult {
  /** How many rows were deleted. */
  count: number;
}

/**
 * The `search_chunks` delegate: the calls the slice makes, nothing else.
 *
 * @stability experimental
 */
export interface SearchChunkDelegate {
  /**
   * The identity, position and hash of every chunk a document has now.
   *
   * (The chunks still to embed, those with NO vector for a model, are read with raw
   * SQL: a `NOT EXISTS` over `search_embeddings`, whose vector column no delegate can
   * name.)
   */
  findMany(args: {
    where: { documentType: string; documentId: string };
    select: { id: true; ordinal: true; contentHash: true };
  }): Promise<Array<Pick<SearchChunkRow, 'id' | 'ordinal' | 'contentHash'>>>;

  /** Inserts one chunk and returns its id. */
  create(args: {
    data: Pick<
      SearchChunkRow,
      'documentType' | 'documentId' | 'ordinal' | 'text' | 'contentHash' | 'charStart' | 'charEnd'
    >;
    select: { id: true };
  }): Promise<Pick<SearchChunkRow, 'id'>>;

  /** Rewrites a chunk's text and offsets in place, keeping its id. */
  update(args: {
    where: { id: string };
    data: Pick<SearchChunkRow, 'text' | 'contentHash' | 'charStart' | 'charEnd'>;
  }): Promise<unknown>;

  /** Deletes chunks (their vectors cascade); returns how many. */
  deleteMany(args: {
    where:
      | { documentType: string; documentId: string }
      | { documentType: string; documentId: string; ordinal: { gte: number } }
      | { documentType: string; documentId: { in: string[] } };
  }): Promise<SearchDeleteResult>;
}

/**
 * The `search_embeddings` delegate: deletion only (a vector is never read or
 * written through a delegate; see the file header).
 *
 * @stability experimental
 */
export interface SearchEmbeddingDelegate {
  /** Drops the vectors of one chunk (an edited chunk must not keep its old vector). */
  deleteMany(args: { where: { chunkId: string } }): Promise<SearchDeleteResult>;
}

/**
 * What `upsert` writes on the create branch.
 *
 * @stability experimental
 */
export type SearchIndexStateCreate = Pick<SearchIndexStateRow, 'documentType' | 'documentId' | 'ownerId'> &
  Partial<Pick<SearchIndexStateRow, 'status' | 'reason' | 'lastError'>>;

/**
 * What `update`/`upsert` writes on the update branch.
 *
 * @stability experimental
 */
export type SearchIndexStateUpdate = Partial<
  Pick<
    SearchIndexStateRow,
    | 'status'
    | 'reason'
    | 'lastError'
    | 'chunkCount'
    | 'model'
    | 'contentFingerprint'
    | 'indexedAt'
    | 'ownerId'
  >
>;

/**
 * The `search_index_state` delegate.
 *
 * @stability experimental
 */
export interface SearchIndexStateDelegate {
  /** What the handler compares a document against before it does any work. */
  findUnique(args: {
    where: { documentType_documentId: SearchDocumentKey };
    select: { status: true; contentFingerprint: true; model: true };
  }): Promise<Pick<SearchIndexStateRow, 'status' | 'contentFingerprint' | 'model'> | null>;

  /** An owner's state rows of one document type: the library listing, and the ids a bulk forget enumerates. */
  findMany(args: {
    where: { ownerId: string; documentType: string };
    select: {
      documentId: true;
      status: true;
      reason: true;
      lastError: true;
      model: true;
      indexedAt: true;
      updatedAt: true;
    };
  }): Promise<
    Array<
      Pick<
        SearchIndexStateRow,
        'documentId' | 'status' | 'reason' | 'lastError' | 'model' | 'indexedAt' | 'updatedAt'
      >
    >
  >;

  /** Updates a state row that exists. */
  update(args: {
    where: { documentType_documentId: SearchDocumentKey };
    data: SearchIndexStateUpdate;
  }): Promise<unknown>;

  /** Creates or updates a state row. */
  upsert(args: {
    where: { documentType_documentId: SearchDocumentKey };
    create: SearchIndexStateCreate;
    update: SearchIndexStateUpdate;
  }): Promise<unknown>;

  /** Deletes the state of one document, or of every document of a type an owner has. */
  deleteMany(args: {
    where: { documentType: string; documentId: string } | { ownerId: string; documentType: string };
  }): Promise<SearchDeleteResult>;
}

/**
 * The narrowed client the slice works with: the host client's raw methods plus
 * the three delegates above.
 *
 * @stability experimental
 */
export interface KvoxSearchDb extends KvoxPrismaClientLike {
  /** `search_chunks`. */
  searchChunk: SearchChunkDelegate;
  /** `search_embeddings` (deletion only; vectors are raw SQL). */
  searchEmbedding: SearchEmbeddingDelegate;
  /** `search_index_state`. */
  searchIndexState: SearchIndexStateDelegate;
}

// -----------------------------------------------------------------------------
// Typed result rows of the raw statements that read other slices' tables
// -----------------------------------------------------------------------------

/**
 * One candidate document of the ranked window (`GET /api/search`).
 *
 * @stability experimental
 */
export interface SearchCandidateRow {
  /** The document kind. */
  type: 'transcript' | 'note';
  /** The document id. */
  id: string;
  /** The title. */
  title: string;
  /** The document's own status. */
  status: string;
  /** When it last changed. */
  updated_at: Date;
  /** The arm's score (meaningless across arms). */
  score: number;
}

/**
 * One `ts_headline` rendering, still carrying its sentinels.
 *
 * @stability experimental
 */
export interface SearchSnippetRow {
  /** The document kind. */
  type: 'transcript' | 'note';
  /** The document id. */
  doc_id: string;
  /** Which part matched. */
  field: 'title' | 'body' | 'segment';
  /** Where to seek, for a transcript segment. */
  start_ms: number | null;
  /** The `ts_headline` output, carrying its sentinels. */
  raw: string;
}

/**
 * `transcripts.owner_id`, the owner alone.
 *
 * @stability experimental
 */
export interface DocumentOwnerRow {
  /** The owner. */
  owner_id: string;
}

/**
 * A transcript's chunker input: its version and owner.
 *
 * @stability experimental
 */
export interface TranscriptHeaderRow {
  /** The owner. */
  owner_id: string;
  /** The version the chunker's input is at. */
  current_version: number;
}

/**
 * One transcript segment as the chunker reads it.
 *
 * @stability experimental
 */
export interface TranscriptSegmentRow {
  /** Position among the segments. */
  ordinal: number;
  /** The segment text. */
  text: string;
  /** The speaker's display name, or `null`. */
  display_name: string | null;
}

/**
 * A note's chunker input.
 *
 * @stability experimental
 */
export interface NoteContentRow {
  /** The owner. */
  owner_id: string;
  /** The version. */
  current_version: number;
  /** The title. */
  title: string;
  /** The body. */
  body: string;
}

/**
 * A transcript's or note's revision token inputs.
 *
 * @stability experimental
 */
export interface DocumentRevisionRow {
  /** The version. */
  current_version: number;
  /** The title (empty for a transcript). */
  title: string;
}

/**
 * One owned document of the index-status library listing.
 *
 * @stability experimental
 */
export interface LibraryDocumentRow {
  /** The document id. */
  id: string;
  /** The title. */
  title: string;
  /** When it last changed. */
  updated_at: Date;
}
