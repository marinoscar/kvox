import { createZodDto } from 'nestjs-zod';
import {
  searchQuerySchema,
  searchSnippetSchema,
  searchResultSchema,
  searchResponseSchema,
} from '@marinoscar/kvox-contract/search';

// The wire schemas of this file moved to `@marinoscar/kvox-contract/search` (issue #488, file `search/search.ts`); they are re-exported below so no importer changes.
export {
  MAX_SEARCH_QUERY_LENGTH,
  MAX_SEARCH_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  MAX_CANDIDATE_DOCUMENTS,
  searchQuerySchema,
  type SearchQueryDto,
  searchSnippetSchema,
  searchResultSchema,
  searchResponseSchema,
  type SearchResponse,
} from '@marinoscar/kvox-contract/search';

export class SearchQueryParamsDto extends createZodDto(searchQuerySchema) {}

export class SearchSnippetDto extends createZodDto(searchSnippetSchema) {}

export class SearchResultDto extends createZodDto(searchResultSchema) {}

export class SearchResponseDto extends createZodDto(searchResponseSchema) {}
