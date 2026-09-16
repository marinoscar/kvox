// =============================================================================
// `GET /api/search` wire shapes (issue #175, epic #164)
// =============================================================================
//
// THERE IS NO FIELD CALLED `total`, AND THAT IS ON PURPOSE.
// -----------------------------------------------------------------------------
//
// This endpoint reads a BOUNDED candidate window - at most
// {@link MAX_CANDIDATE_DOCUMENTS} documents - and pages by offset INTO that
// window. A field called `total` would therefore be a lie in the only case
// where anybody reads it closely: a corpus with 4,000 matching documents would
// report `total: 200`, a client would render "200 results", and the number
// would be the cap rather than a count of anything.
//
// So the response publishes two honest facts instead, and the client composes
// the sentence:
//
//   - `matchedDocuments` - how many documents are IN the window (never more
//     than the cap).
//   - `truncated` - whether the window filled up, i.e. whether there are more
//     matches than this window can see.
//
// `truncated: false` makes `matchedDocuments` an exact count; `truncated: true`
// makes it a floor ("200+ results"). That is the same posture
// `GET /api/transcripts/:id/search` already takes with its own `truncated`
// flag - see that endpoint's DTO, which keeps `total` EXACT precisely because
// it can (it counts inside one transcript) and says so.
// =============================================================================

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { SEARCH_TYPES } from '../search-query';

/** Longest `q` this endpoint accepts. */
export const MAX_SEARCH_QUERY_LENGTH = 256;

/** Results per page. */
export const MAX_SEARCH_LIMIT = 50;
export const DEFAULT_SEARCH_LIMIT = 20;

/**
 * The candidate window's ceiling, in DOCUMENTS.
 *
 * A relevance search is answered from the top of a ranking, and nobody pages
 * to result 4,000 of a ranked list - they refine the query. Bounding the
 * window keeps the cost of one request a function of this constant rather than
 * of the corpus, and makes `truncated` a meaningful thing to publish.
 *
 * Changing it CHANGES THE RANKING'S OBSERVABLE BEHAVIOUR (which documents are
 * reachable at all), so it is one of the things `RANKING_MODEL_VERSION` exists
 * to invalidate cursors over - see `search-cursor.ts`.
 */
export const MAX_CANDIDATE_DOCUMENTS = 200;

// -----------------------------------------------------------------------------
// Request
// -----------------------------------------------------------------------------

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(MAX_SEARCH_QUERY_LENGTH),
  /**
   * CSV, validated and normalised by `parseTypesParam`.
   *
   * Kept as a raw string here and parsed in the service rather than
   * transformed in place, so the DTO that OpenAPI renders is the string a
   * client actually sends (`?types=transcript,note`) rather than an array
   * shape no client can express in a query string.
   */
  types: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_SEARCH_LIMIT).default(DEFAULT_SEARCH_LIMIT),
  cursor: z.string().min(1).max(500).optional(),
});

export type SearchQueryDto = z.infer<typeof searchQuerySchema>;

export class SearchQueryParamsDto extends createZodDto(searchQuerySchema) {}

// -----------------------------------------------------------------------------
// Response
// -----------------------------------------------------------------------------

export const searchSnippetSchema = z.object({
  /**
   * `ts_headline` output, HTML-ESCAPED at the server, with `<mark>...</mark>`
   * around hits.
   *
   * The ONLY markup in this string is balanced `<mark>` elements. Everything
   * else that came out of the corpus - including any angle bracket a
   * transcript or a note body happened to contain - is escaped text. See
   * `search-snippet.ts` for why the escape has to happen before the marks go
   * in, and what breaks in each of the two obvious orderings.
   */
  html: z.string(),
  /**
   * Where in the recording this line starts, in milliseconds, so a client can
   * seek to it. `null` for a note, and for a transcript's TITLE match - a
   * title is not at a point in the audio.
   */
  startMs: z.number().int().nullable(),
  /** Which field matched. */
  field: z.enum(['title', 'body', 'segment']),
});

export class SearchSnippetDto extends createZodDto(searchSnippetSchema) {}

export const searchResultSchema = z.object({
  type: z.enum(SEARCH_TYPES),
  id: z.string(),
  title: z.string(),
  /**
   * The document's relevance, rolled up as the MAXIMUM of its units' scores.
   *
   * Comparable WITHIN one response and meaningless across two: it is a
   * `ts_rank_cd` value, which has no absolute scale.
   */
  score: z.number(),
  updatedAt: z.string(),
  /** The document's own status enum, as its own module defines it. */
  status: z.string(),
  /** Why it matched, most relevant first. At most three. */
  snippets: z.array(searchSnippetSchema),
});

export class SearchResultDto extends createZodDto(searchResultSchema) {}

export const searchResponseSchema = z.object({
  results: z.array(searchResultSchema),
  /** Documents in the candidate window. Never more than the cap. */
  matchedDocuments: z.number().int(),
  /** True when the window filled up, so `matchedDocuments` is a floor. */
  truncated: z.boolean(),
  nextCursor: z.string().nullable(),
  /**
   * `'stopwords'` when `q` parsed to an empty tsquery and the endpoint fell
   * back to matching titles, so a client can say so rather than presenting
   * title matches as if they were full-text ones. `null` on the normal path.
   */
  degraded: z.enum(['stopwords']).nullable(),
  /**
   * The types actually searched, which is the requested types narrowed to
   * those the caller holds the read permission for.
   *
   * This is how a partial answer announces itself. A caller holding only
   * `notes:read` who asks for both gets `['note']` here and no transcripts -
   * NOT a 403. See `search.controller.ts` for the reasoning.
   */
  searchedTypes: z.array(z.enum(SEARCH_TYPES)),
});

export type SearchResponse = z.infer<typeof searchResponseSchema>;

export class SearchResponseDto extends createZodDto(searchResponseSchema) {}
