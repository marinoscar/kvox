/**
 * `GET /api/search`, as the web app sees it — issue #176, epic #164.
 *
 * The backend half is `apps/api/src/search/search.controller.ts` and
 * `dto/search.dto.ts`; every type below is a hand-written mirror of a Zod
 * schema in that file, named identically so the two can be diffed by eye —
 * the same arrangement the notes and transcripts clients have with their own
 * controllers.
 *
 * =============================================================================
 * THERE IS NO `total`, AND THIS CLIENT MUST NOT INVENT ONE
 * =============================================================================
 *
 * The endpoint reads a BOUNDED candidate window and pages by offset into it,
 * so it publishes two honest facts instead of one dishonest one:
 * {@link SearchResponse.matchedDocuments} (how many documents are in the
 * window) and {@link SearchResponse.truncated} (whether the window filled up).
 * `truncated: false` makes the count exact; `truncated: true` makes it a CAP.
 * A UI that renders `matchedDocuments` as "200 results" in the truncated case
 * is stating the size of this endpoint's internal window as if it were a
 * property of the user's corpus. See the DTO's own header for the argument.
 *
 * =============================================================================
 * THE CURSOR IS OPAQUE, AND A 400 FROM ONE IS A BRANCH, NOT AN ERROR
 * =============================================================================
 *
 * A cursor is tied to the exact search that produced it — the query text, the
 * type filter, the caller, and the ranking model version. This client passes it
 * back VERBATIM and never constructs, parses, inspects or compares one; the
 * shape is the server's business and nothing here may grow an opinion about it.
 *
 * Presented against a different search, the server answers **400 rather than
 * silently restarting**, and that refusal is deliberate: on a relevance-ordered
 * list, page one served again is indistinguishable from a real page two, so a
 * silent restart would leave a user scrolling the same rows forever believing
 * they were making progress. {@link isStaleCursorError} is the one place this
 * client recognises that answer, so `useSearch` can start over from page one
 * instead of putting a red alert on screen — see the hook for the handling.
 */

import { KvoxApiError, kvoxGet } from '../../core/headless/index.js';
import type { KvoxWebHost } from '../../core/headless/index.js';
import type {
  SearchType,
  SemanticReason as ContractSemanticReason,
  SearchResponse,
} from '@marinoscar/kvox-contract/search';

// =============================================================================
// The shapes (mirrors of `dto/search.dto.ts`)
// =============================================================================

/**
 * The document types this endpoint can search. Mirrors `SEARCH_TYPES`.
 *
 * @stability experimental
 */
export type { SearchType };

/**
 * Which field a snippet came out of.
 *
 * @stability experimental
 */
export type SearchSnippetField = 'title' | 'body' | 'segment';

/**
 * Why the semantic arm did not run. Mirrors `SEMANTIC_REASONS` in
 * `@marinoscar/kvox-contract/search`, which states in its own header that
 * these strings are a published contract — so this list is exhaustive on
 * purpose and a new server value is a deliberate, compiler-visible change here
 * rather than something that silently widens.
 *
 * @stability experimental
 */
export type SemanticReason = ContractSemanticReason;

/**
 * One search snippet, rendered as text and `<mark>` elements, never as HTML.
 *
 * @stability experimental
 */
export interface SearchSnippet {
  /**
   * `ts_headline` output, **already HTML-escaped at the server**, with
   * `<mark>`/`</mark>` as the only markup in it.
   *
   * ⚠ NEVER RENDER THIS WITH `dangerouslySetInnerHTML`. It is parsed into
   * alternating text and `<mark>` ELEMENTS by
   * `ui/SearchSnippet.tsx`, which explains at length why the
   * server's guarantee is not on its own a reason to trust the string.
   */
  html: string;
  /**
   * Where in the recording this line starts, so a client can say when it was
   * said. `null` for a note, and for a transcript's title match.
   */
  startMs: number | null;
  /** Where the snippet came from. */
  field: SearchSnippetField;
}

/**
 * One ranked document in a search response.
 *
 * @stability experimental
 */
export interface SearchResult {
  /** The document type. */
  type: SearchType;
  /** The document id. */
  id: string;
  /** The document title. */
  title: string;
  /**
   * `ts_rank_cd` relevance. Comparable WITHIN one response and meaningless
   * across two, which is why nothing in this app renders it.
   */
  score: number;
  /** When the document last changed, ISO-8601. */
  updatedAt: string;
  /** The document's own status enum, as its own module defines it. */
  status: string;
  /** Why it matched, most relevant first. At most three. */
  snippets: SearchSnippet[];
}

/**
 * The body of `GET /api/search`, as the contract defines it.
 *
 * @stability experimental
 */
export type { SearchResponse };

/**
 * What {@link search} sends.
 *
 * @stability experimental
 */
export interface SearchParams {
  /** The search text. */
  q: string;
  /** The types to search. Sent as the CSV the endpoint documents. */
  types?: SearchType[];
  /** The page size. */
  limit?: number;
  /** Opaque, from a previous response. Never built here. */
  cursor?: string;
  /**
   * Cancels the request. Passed straight through to `fetch` by
   * the host's HTTP transport, so a superseded keystroke's request is genuinely
   * aborted rather than merely ignored on arrival.
   */
  signal?: AbortSignal;
}

// =============================================================================
// The call
// =============================================================================

/**
 * `GET /api/search`.
 *
 * @stability experimental
 */
export async function search(host: KvoxWebHost, params: SearchParams): Promise<SearchResponse> {
  const query: Record<string, string> = { q: params.q };
  if (params.types && params.types.length > 0) query.types = params.types.join(',');
  if (params.limit !== undefined) query.limit = String(params.limit);
  // Verbatim. See the file header: this client has no opinion about a cursor's
  // contents and must never acquire one.
  if (params.cursor) query.cursor = params.cursor;

  return kvoxGet<SearchResponse>(host, '/search', { query, signal: params.signal });
}

/**
 * Is this the server refusing a cursor that belongs to a different search?
 *
 * A **400 carrying a cursor** is the only 400 this endpoint answers that a
 * client can recover from by itself, and the recovery is "ask for page one
 * again". Recognised HERE rather than at the call site so no hook spells the
 * condition for itself, exactly as `noteConflictReason` is the one place
 * the notes client reads a 409's `details.reason`.
 *
 * ⚠ It takes `hadCursor` rather than sniffing the message, because the other
 * 400s this endpoint answers (an empty `q`, an unrecognised `types`, a `limit`
 * out of range) are the CALLER's bugs and must stay visible as errors. Only a
 * request that actually carried a cursor can have been refused for having a
 * stale one.
 *
 * @stability experimental
 */
export function isStaleCursorError(err: unknown, hadCursor: boolean): boolean {
  return hadCursor && err instanceof KvoxApiError && err.status === 400;
}
