// =============================================================================
// The semantic arm's vocabulary (issue #189, epic #165)
// =============================================================================
//
// A PURE FILE - no Nest, no Prisma, no provider - so that the wire DTO and the
// service that produces these values can both import them without either
// importing the other. The reason strings below are published by
// `GET /api/search` as `semanticReason`, so they are a CONTRACT: renaming one
// is a breaking change to a client that branches on it.
//
// -----------------------------------------------------------------------------
// WHO EMBEDS WHAT, AND WHY THAT ASYMMETRY NEEDS A PUBLISHED REASON AT ALL
// -----------------------------------------------------------------------------
//
// Content is embedded AT INDEX TIME WITH ITS OWNER'S KEY - the same strict
// bring-your-own-key posture `docs/specs/notes.md` §9 establishes, and the
// reason `search_chunks` rows exist at all is that somebody paid their own
// vendor to produce them. The QUERY is embedded with THE SEARCHER'S OWN KEY,
// at request time, because there is no deployment key to fall back to and
// because charging the corpus owner for a stranger's search would be the wrong
// bill.
//
// The consequence is stated rather than hidden: A SEARCHER WITH NO KEY OF
// THEIR OWN GETS LEXICAL RANKING ONLY. That is an acceptable outcome, and it is
// acceptable ONLY BECAUSE IT IS LEGIBLE. The endpoint must never answer such a
// caller with an error and must never answer them with an empty list - the
// full-text arm answers exactly as it did before epic #165 existed, and
// `semantic: false` plus one of these strings is the entire degradation. A
// search box that 500s because a vendor is down, or because the person using it
// has not pasted an API key, is strictly worse than a search box that ranks by
// keywords.
// =============================================================================

import { type SemanticReason } from '@marinoscar/kvox-contract/search';
// The reason vocabulary lives in `@marinoscar/kvox-contract/search` (issue #488) and is re-exported below so no importer changes.
// `embeddings_unavailable` (issue #494) is the reason for a host with no embeddings model, or one whose vectors are not 1536 wide.
// `embedding_unsupported` is still published and still spelled in `search_index_state.reason`; the query side no longer produces it,
// because the AI port folds "the active provider cannot embed" into `capabilities().available` (reported as `ai_not_configured`).
export {
  SEMANTIC_REASONS,
  type SemanticReason,
} from '@marinoscar/kvox-contract/search';

/**
 * The vector arm can run: a query vector that is safe to interpolate into a
 * `vector` literal - right width, every component finite - so the SQL builder
 * never has to re-check. See `SearchQueryEmbedder` for where that is enforced.
 *
 * @stability experimental
 */
export interface SemanticQueryPlanOk {
  /** Discriminant. */
  ok: true;
  /** The label of the host's embeddings provider, e.g. `openai`. */
  provider: string;
  /**
   * The embedding model's id, exactly as the host REPORTED it (never as it was
   * requested - a gateway that substitutes a model is precisely the event this
   * value exists to record).
   *
   * ⚠ THIS STRING GOES INTO THE CURSOR FINGERPRINT, prefixed with the provider
   * label. See `search-cursor.ts`.
   */
  model: string;
  /** `SEARCH_EMBEDDING_DIMENSIONS` finite numbers. */
  vector: number[];
}

/**
 * The vector arm did not run, and why.
 *
 * @stability experimental
 */
export interface SemanticQueryPlanOff {
  /** Discriminant. */
  ok: false;
  /** Why the arm is off: a published `semanticReason`. */
  reason: SemanticReason;
}

/**
 * What the query-embedding step produced.
 *
 * `ok: true` promises a vector that is safe to interpolate into a `vector`
 * literal - right width, every component finite - so the SQL builder never has
 * to re-check. See `SearchQueryEmbedder` for where that is enforced.
 *
 * @stability experimental
 */
export type SemanticQueryPlan = SemanticQueryPlanOk | SemanticQueryPlanOff;

/**
 * The semantic axis of the cursor fingerprint, as one line of text.
 *
 * `null` when the vector arm did not run, so an FTS-only window and a fused
 * window can never share a fingerprint - see `search-cursor.ts`'s header for
 * why that matters more on a relevance list than on a feed. Switching the
 * deployment's embedding model changes this line, which invalidates every
 * in-flight cursor FOR FREE, exactly as bumping `RANKING_MODEL_VERSION` does.
 *
 * @stability experimental
 */
export function semanticAxis(plan: SemanticQueryPlan): string | null {
  return plan.ok ? `${plan.provider}:${plan.model}` : null;
}
