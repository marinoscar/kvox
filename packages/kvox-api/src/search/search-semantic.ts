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
 * The cosine similarity a document's best chunk must reach to enter the
 * semantic candidate list at all.
 *
 * ⚠ WITHOUT A FLOOR, "NO RESULTS" STOPS BEING AN ANSWER THIS ENDPOINT CAN GIVE.
 * The lexical arm is self-limiting - a document either contains a lexeme or it
 * does not - but nearest-neighbour search has no such boundary: EVERY embedded
 * document has a distance from the query vector, so an unfloored vector arm
 * returns the caller's entire indexed corpus on every search, ordered by how
 * little it has to do with the question. Three things break at once, and none
 * of them looks like a bug in the fusion: a query about nothing returns 200
 * documents instead of an empty list; `matchedDocuments` becomes "how much have
 * you indexed" rather than "how much matched"; and `truncated` is permanently
 * `true` for anybody with more than {@link MAX_CANDIDATE_DOCUMENTS} documents,
 * which makes the honest count the DTO exists to publish permanently a floor.
 *
 * ⚠ IT IS A CUTOFF, NOT A TUNING KNOB, AND IT IS THE ONE ARBITRARY NUMBER ON
 * THIS PATH. It does not order anything - RRF does that, from ranks - and
 * raising or lowering it cannot make a relevant document outrank an irrelevant
 * one. All it decides is where "related enough to mention" sits. 0.25 is
 * deliberately permissive: for the normalised embeddings this application
 * stores, unrelated text pairs sit near zero and anything a person would call
 * "about the same thing" sits well above it, so the floor removes the long tail
 * without adjudicating the head. If it is ever tuned, it must be tuned against
 * measured recall on a real corpus - and it belongs in
 * `RANKING_MODEL_VERSION`'s list of things a change to invalidates cursors
 * over, because it changes which documents are reachable at all.
 *
 * ⚠ THIS IS THE DEFAULT, NOT THE ONLY FLOOR. Similarity baselines differ by model:
 * bge-style models (and others trained with a contrastive temperature) place even
 * unrelated text at 0.4-0.6 cosine, so 0.25 would admit the whole corpus. A host
 * whose model needs another cut-off declares `capabilities().embeddings.minSimilarity`;
 * the gate carries it and the SQL uses `minSimilarity ?? MIN_SEMANTIC_SIMILARITY`.
 *
 * @stability experimental
 */
export const MIN_SEMANTIC_SIMILARITY = 0.25;

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
  /**
   * The id the INDEX stores vectors under (`search_embeddings.model`): the
   * gate's model, NOT {@link SemanticQueryPlanOk.model}. The vector SQL filters
   * on this, because a gateway may report a dated id the indexer never wrote.
   * It is not part of the cursor fingerprint (the reported `model` is).
   */
  indexModel: string;
  /** The cosine floor for this model's candidates (the capability's, else the default). */
  minSimilarity: number;
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
