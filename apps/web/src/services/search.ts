/**
 * `GET /api/search`, as the web app sees it — issue #176, epic #164.
 *
 * The backend half is `apps/api/src/search/search.controller.ts` and
 * `dto/search.dto.ts`; every type below is a hand-written mirror of a Zod
 * schema in that file, named identically so the two can be diffed by eye —
 * the same arrangement `services/notes.ts` and `services/transcripts.ts`
 * already have with their own controllers.
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

import { api, ApiError } from './api';

// =============================================================================
// The shapes (mirrors of `dto/search.dto.ts`)
// =============================================================================

/** The document types this endpoint can search. Mirrors `SEARCH_TYPES`. */
export type SearchType = 'transcript' | 'note';

/** Which field a snippet came out of. */
export type SearchSnippetField = 'title' | 'body' | 'segment';

/**
 * Why the semantic arm did not run. Mirrors `SEMANTIC_REASONS` in
 * `apps/api/src/search/search-semantic.ts`, which states in its own header that
 * these strings are a published contract — so this list is exhaustive on
 * purpose and a new server value is a deliberate, compiler-visible change here
 * rather than something that silently widens.
 */
export type SemanticReason =
  | 'ai_not_configured'
  | 'embedding_unsupported'
  | 'ai_key_missing'
  | 'no_indexed_content'
  | 'embedding_failed';

export interface SearchSnippet {
  /**
   * `ts_headline` output, **already HTML-escaped at the server**, with
   * `<mark>`/`</mark>` as the only markup in it.
   *
   * ⚠ NEVER RENDER THIS WITH `dangerouslySetInnerHTML`. It is parsed into
   * alternating text and `<mark>` ELEMENTS by
   * `components/search/SearchSnippet.tsx`, which explains at length why the
   * server's guarantee is not on its own a reason to trust the string.
   */
  html: string;
  /**
   * Where in the recording this line starts, so a client can say when it was
   * said. `null` for a note, and for a transcript's title match.
   */
  startMs: number | null;
  field: SearchSnippetField;
}

export interface SearchResult {
  type: SearchType;
  id: string;
  title: string;
  /**
   * `ts_rank_cd` relevance. Comparable WITHIN one response and meaningless
   * across two, which is why nothing in this app renders it.
   */
  score: number;
  updatedAt: string;
  /** The document's own status enum, as its own module defines it. */
  status: string;
  /** Why it matched, most relevant first. At most three. */
  snippets: SearchSnippet[];
}

export interface SearchResponse {
  results: SearchResult[];
  /** Documents in the candidate window. Never more than the server's cap. */
  matchedDocuments: number;
  /** True when the window filled up, so `matchedDocuments` is a floor. */
  truncated: boolean;
  /** Opaque. Pass it back verbatim or not at all. */
  nextCursor: string | null;
  /**
   * `'stopwords'` when `q` was entirely common words, so the server fell back
   * to matching titles. Not an error — a different kind of answer.
   */
  degraded: 'stopwords' | null;
  /**
   * The types actually searched: what was asked for, narrowed to those the
   * caller holds the read permission for. A view that asked for `transcript`
   * and does not find it here was not merely unlucky — it lacks
   * `transcripts:read`, and should say so rather than render an empty list.
   */
  searchedTypes: SearchType[];
  /**
   * Whether the SEMANTIC (embedding) arm ran and was fused into this ranking.
   *
   * ⚠ REQUIRED, NOT OPTIONAL. The server always sends it (#189), so there is
   * no third "the server did not say" state for a client to reason about —
   * `false` means the full-text arm answered alone, which is a correct HTTP 200
   * answer with the same rows in the same order the pre-#189 ranking produced.
   * Typing it optional would re-create exactly the "did the server tell us?"
   * ambiguity this field exists to remove.
   */
  semantic: boolean;
  /**
   * Why {@link SearchResponse.semantic} is `false`, and `null` when it is true.
   *
   * The union is `SEMANTIC_REASONS` in `apps/api/src/search/search-semantic.ts`
   * verbatim — that file calls these strings a contract, so this mirror must be
   * the real list rather than a widened `string`. Two of them name something
   * the reader can act on themselves (`ai_key_missing`, `no_indexed_content`);
   * the rest are an administrator's or a vendor's problem.
   */
  semanticReason: SemanticReason | null;
  /**
   * How many of the caller's OWN documents, among the types actually searched,
   * are absent from the semantic index.
   *
   * ⚠ REQUIRED, and ⚠ OWN rather than visible-to-you: a document somebody
   * shared with this caller is indexed on ITS OWNER's key, so counting it would
   * report a number the reader has no way to move. `0` is the good case, not a
   * missing value.
   */
  unindexedCount: number;
}

export interface SearchParams {
  q: string;
  /** The types to search. Sent as the CSV the endpoint documents. */
  types?: SearchType[];
  limit?: number;
  /** Opaque, from a previous response. Never built here. */
  cursor?: string;
  /**
   * Cancels the request. Passed straight through to `fetch` by
   * `services/api.ts`, so a superseded keystroke's request is genuinely
   * aborted rather than merely ignored on arrival.
   */
  signal?: AbortSignal;
}

// =============================================================================
// The call
// =============================================================================

/** `GET /api/search`. */
export async function search(params: SearchParams): Promise<SearchResponse> {
  const query = new URLSearchParams();
  query.set('q', params.q);
  if (params.types && params.types.length > 0) query.set('types', params.types.join(','));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  // Verbatim. See the file header: this client has no opinion about a cursor's
  // contents and must never acquire one.
  if (params.cursor) query.set('cursor', params.cursor);

  return api.get<SearchResponse>(`/search?${query.toString()}`, { signal: params.signal });
}

/**
 * Is this the server refusing a cursor that belongs to a different search?
 *
 * A **400 carrying a cursor** is the only 400 this endpoint answers that a
 * client can recover from by itself, and the recovery is "ask for page one
 * again". Recognised HERE rather than at the call site so no hook spells the
 * condition for itself, exactly as `noteConflictReason` is the one place
 * `services/notes.ts` reads a 409's `details.reason`.
 *
 * ⚠ It takes `hadCursor` rather than sniffing the message, because the other
 * 400s this endpoint answers (an empty `q`, an unrecognised `types`, a `limit`
 * out of range) are the CALLER's bugs and must stay visible as errors. Only a
 * request that actually carried a cursor can have been refused for having a
 * stale one.
 */
export function isStaleCursorError(err: unknown, hadCursor: boolean): boolean {
  return hadCursor && err instanceof ApiError && err.status === 400;
}
