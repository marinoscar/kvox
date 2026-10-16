
/**
 * Why the vector arm did not run.
 *
 * Ordered here as the service evaluates them, cheapest and most
 * deployment-wide first, so that the reason a caller is shown is the FIRST
 * thing that was actually wrong rather than the last thing checked.
 *
 * @stability experimental
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

/**
 * One of {@link SEMANTIC_REASONS}. Published as `semanticReason`.
 *
 * @stability experimental
 */
export type SemanticReason = (typeof SEMANTIC_REASONS)[number];
