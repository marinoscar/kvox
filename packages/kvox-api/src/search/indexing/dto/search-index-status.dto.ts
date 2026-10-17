import { createZodDto } from 'nestjs-zod';
import {
  searchIndexTypeCountsSchema,
  searchIndexFailureSchema,
  searchIndexStatusSchema,
  searchIndexRequestResultSchema,
} from '@marinoscar/kvox-contract/search';

// The wire schemas of this file moved to `@marinoscar/kvox-contract/search` (issue #488, file `search/search-index-status.ts`); they are re-exported below so no importer changes.
export {
  SEARCH_INDEX_REQUEST_CAP,
  SEARCH_INDEX_FAILURE_LIMIT,
  searchIndexDocumentTypeSchema,
  searchIndexTypeCountsSchema,
  searchIndexFailureSchema,
  searchIndexStatusSchema,
  searchIndexRequestResultSchema,
  type SearchIndexStatusResponse,
  type SearchIndexRequestResult,
} from '@marinoscar/kvox-contract/search';

/**
 * Documents the `SearchIndexTypeCounts` wire shape in the API reference.
 *
 * @stability experimental
 */
export class SearchIndexTypeCountsDto extends createZodDto(searchIndexTypeCountsSchema) {}

/**
 * Documents the `SearchIndexFailure` wire shape in the API reference.
 *
 * @stability experimental
 */
export class SearchIndexFailureDto extends createZodDto(searchIndexFailureSchema) {}

/**
 * Documents the `SearchIndexStatus` wire shape in the API reference.
 *
 * @stability experimental
 */
export class SearchIndexStatusDto extends createZodDto(searchIndexStatusSchema) {}

/**
 * Documents the `SearchIndexRequestResult` wire shape in the API reference.
 *
 * @stability experimental
 */
export class SearchIndexRequestResultDto extends createZodDto(searchIndexRequestResultSchema) {}
