// The search slice of @marinoscar/kvox-api (issue #494, epic #491).
//
// Depends on `ports` and `core` only. The ways in are `SearchModule.forRoot(options)`
// (the query side: `GET /api/search`) and `SearchIndexingModule.forRoot(options)`
// (the `search.index` job and the two index routes). A host with no AI port that
// reports a 1536-wide embeddings model still gets full-text search, and the
// response says why the semantic arm is off.

export { SearchModule } from './search.module.js';
export { SearchIndexingModule } from './indexing/search-indexing.module.js';
export {
  DEFAULT_SEARCH_TYPE_PERMISSIONS,
  SEARCH_DEFAULT_BATCH_SIZE,
  SEARCH_EMBEDDING_DIMENSIONS,
  type ResolvedSearchIndexingOptions,
  type ResolvedSearchOptions,
  type SearchIndexingModuleOptions,
  type SearchModuleOptions,
  type SearchTypePermissions,
} from './search.options.js';

export {
  MIN_SEMANTIC_SIMILARITY,
  SearchService,
} from './search.service.js';
export { SearchController } from './search.controller.js';
export {
  QUERY_EMBED_TIMEOUT_MS,
  SEARCH_EMBED_FEATURE,
  SearchQueryEmbedder,
  type EmbedderReady,
  type EmbedderResolution,
} from './search-query-embedder.service.js';
export {
  embeddingGateFor,
  type EmbeddingGate,
  type EmbeddingGateClosed,
  type EmbeddingGateOpen,
  type EmbeddingGateReason,
  type EmbeddingMismatch,
} from './search-embedding-gate.js';
export { RRF_K, reciprocalRankFusion } from './search-fusion.js';
export {
  RANKING_MODEL_VERSION,
  SearchCursorError,
  decodeSearchCursor,
  encodeSearchCursor,
  fingerprintScope,
  type SearchCursorScope,
} from './search-cursor.js';
export {
  SEMANTIC_REASONS,
  semanticAxis,
  type SemanticQueryPlan,
  type SemanticQueryPlanOff,
  type SemanticQueryPlanOk,
  type SemanticReason,
} from './search-semantic.js';
export {
  OwnerOnlyTranscriptVisibility,
  SEARCH_TRANSCRIPT_VISIBILITY,
  type SearchScopedClient,
  type SearchTranscriptAlias,
  type SearchTranscriptVisibility,
  type SearchViewer,
} from './search-visibility.js';

export {
  SEARCH_DOCUMENT_TYPES,
  SEARCH_DOC_NOTE,
  SEARCH_DOC_TRANSCRIPT,
  SEARCH_INDEX_JOB_TYPE,
  SEARCH_REASON_DIMENSION_MISMATCH,
  SEARCH_REASON_EMBEDDING_UNSUPPORTED,
  SEARCH_REASON_KEY_INVALID,
  SEARCH_REASON_KEY_MISSING,
  SEARCH_REASON_NOT_CONFIGURED,
  indexReasonFor,
  readSearchIndexPayload,
  searchReasonFor,
  type SearchDocumentType,
  type SearchGateReason,
  type SearchIndexJobPayload,
} from './indexing/job-types.js';
export {
  SearchIndexService,
  type SearchIndexReason,
} from './indexing/search-index.service.js';
export {
  SEARCH_INDEX_MAX_ATTEMPTS,
  SEARCH_INDEX_MAX_RUNTIME_MS,
  SearchIndexHandler,
} from './indexing/search-index.handler.js';
export { SearchIndexStatusService } from './indexing/search-index-status.service.js';
export { SearchIndexController } from './indexing/search-index.controller.js';

export {
  DEFAULT_SEARCH_LIMIT,
  MAX_CANDIDATE_DOCUMENTS,
  MAX_SEARCH_LIMIT,
  MAX_SEARCH_QUERY_LENGTH,
  SearchQueryParamsDto,
  SearchResponseDto,
  SearchResultDto,
  SearchSnippetDto,
  searchQuerySchema,
  type SearchQueryDto,
  type SearchResponse,
} from './dto/search.dto.js';
export {
  SEARCH_INDEX_FAILURE_LIMIT,
  SEARCH_INDEX_REQUEST_CAP,
  SearchIndexFailureDto,
  SearchIndexRequestResultDto,
  SearchIndexStatusDto,
  SearchIndexTypeCountsDto,
  type SearchIndexRequestResult,
  type SearchIndexStatusResponse,
} from './indexing/dto/search-index-status.dto.js';

export type {
  DocumentOwnerRow,
  DocumentRevisionRow,
  KvoxSearchDb,
  LibraryDocumentRow,
  NoteContentRow,
  SearchCandidateRow,
  SearchChunkDelegate,
  SearchChunkRow,
  SearchDeleteResult,
  SearchDocumentKey,
  SearchEmbeddingDelegate,
  SearchIndexStateCreate,
  SearchIndexStateDelegate,
  SearchIndexStateRow,
  SearchIndexStateUpdate,
  SearchIndexStatus,
  SearchSnippetRow,
  TranscriptHeaderRow,
  TranscriptSegmentRow,
} from './data/search-db.js';

export {
  chunkNote,
  chunkTranscript,
  fingerprintDocument,
  type Chunk,
  type ChunkableSegment,
} from './chunking/index.js';
