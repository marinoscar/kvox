
/**
 * The two document kinds `GET /api/search` can return.
 *
 * @stability experimental
 */
export const SEARCH_TYPES = ['transcript', 'note'] as const;

/**
 * The `SearchType` type (search type).
 *
 * @stability experimental
 */
export type SearchType = (typeof SEARCH_TYPES)[number];
