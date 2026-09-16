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

/**
 * Why the vector arm did not run.
 *
 * Ordered here as the service evaluates them, cheapest and most
 * deployment-wide first, so that the reason a caller is shown is the FIRST
 * thing that was actually wrong rather than the last thing checked.
 */
export const SEMANTIC_REASONS = [
  /**
   * This deployment has no usable AI provider: the master switch is off, no
   * provider is chosen, the chosen one is not registered in this build, or its
   * stored configuration does not parse. An administrator's problem, not the
   * searcher's - and deliberately one string rather than four, because every
   * one of them sends the same person to the same page.
   */
  'ai_not_configured',
  /**
   * The active provider is a perfectly good chat provider that has no
   * embeddings endpoint (`AiProvider.embedding`/`embed` absent - see that
   * interface's EMBEDDINGS section on why a vendor without one is registrable
   * rather than owing this interface a throwing stub). Distinct from
   * `ai_not_configured` because the fix is different: switch providers, not
   * finish configuring this one.
   */
  'embedding_unsupported',
  /**
   * The CALLER has not saved an API key. The one reason on this list whose fix
   * belongs to the person reading it, which is exactly why it is not folded
   * into `ai_not_configured`.
   */
  'ai_key_missing',
  /**
   * Nothing in this deployment has been embedded yet, so there is nothing for a
   * query vector to be near. Checked BEFORE the query is embedded: spending a
   * user's own vendor call to produce a vector that can only be compared
   * against an empty table is a bill for nothing.
   */
  'no_indexed_content',
  /**
   * The provider refused, timed out, throttled, or returned a vector this
   * application cannot use. ⚠ A RATE LIMIT LANDS HERE TOO AND IS NOT DEFERRED:
   * there is no job behind this endpoint and somebody is waiting on a response,
   * so the only two options are "answer with the lexical ranking" and "make
   * them wait for a retry that may also be throttled". The first is obviously
   * right.
   */
  'embedding_failed',
] as const;

/** One of {@link SEMANTIC_REASONS}. Published as `semanticReason`. */
export type SemanticReason = (typeof SEMANTIC_REASONS)[number];

/**
 * What the query-embedding step produced.
 *
 * `ok: true` promises a vector that is safe to interpolate into a `vector`
 * literal - right width, every component finite - so the SQL builder never has
 * to re-check. See `SearchQueryEmbedder` for where that is enforced.
 */
export type SemanticQueryPlan =
  | {
      ok: true;
      /** The provider that produced the vector, e.g. `openai`. */
      provider: string;
      /**
       * The embedding model's id, exactly as the provider REPORTED it (never
       * as it was requested - a gateway that substitutes a model is precisely
       * the event this value exists to record).
       *
       * ⚠ THIS STRING GOES INTO THE CURSOR FINGERPRINT, prefixed with the
       * provider id. See `search-cursor.ts`.
       */
      model: string;
      /** `EMBEDDING_DIMENSIONS` finite numbers. */
      vector: number[];
    }
  | { ok: false; reason: SemanticReason };

/**
 * The semantic axis of the cursor fingerprint, as one line of text.
 *
 * `null` when the vector arm did not run, so an FTS-only window and a fused
 * window can never share a fingerprint - see `search-cursor.ts`'s header for
 * why that matters more on a relevance list than on a feed. Switching the
 * deployment's embedding model changes this line, which invalidates every
 * in-flight cursor FOR FREE, exactly as bumping `RANKING_MODEL_VERSION` does.
 */
export function semanticAxis(plan: SemanticQueryPlan): string | null {
  return plan.ok ? `${plan.provider}:${plan.model}` : null;
}
