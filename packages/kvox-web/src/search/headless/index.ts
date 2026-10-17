// The host-neutral half of the search slice: the two API clients, the two hooks
// over them and the plain-language strings. No component, no `@mui/*`.

export { isStaleCursorError, search } from './search-client.js';
export type {
  SearchParams,
  SearchResponse,
  SearchResult,
  SearchSnippet,
  SearchSnippetField,
  SearchType,
  SemanticReason,
} from './search-client.js';
export {
  countNeedingIndex,
  describeIndexReason,
  describeUnavailableReason,
  DOCUMENT_TYPE_LABELS,
  getSearchIndexStatus,
  hasPendingIndexing,
  requestSearchIndex,
} from './search-index-client.js';
export type {
  DocumentTypeLabel,
  SearchIndexDocumentType,
  SearchIndexFailure,
  SearchIndexRequestResult,
  SearchIndexStatus,
  SearchIndexTypeCounts,
} from './search-index-client.js';
export { SEARCH_DEBOUNCE_MS, SEARCH_PAGE_SIZE, useSearch } from './useSearch.js';
export type { UseSearchOptions, UseSearchResult } from './useSearch.js';
export { SEARCH_INDEX_POLL_INTERVAL_MS, useSearchIndex } from './useSearchIndex.js';
export type { UseSearchIndexReturn } from './useSearchIndex.js';
