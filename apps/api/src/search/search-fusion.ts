// =============================================================================
// Reciprocal rank fusion (issue #189, epic #165)
// =============================================================================
//
// Two retrieval arms answer `GET /api/search`: the lexical one
// (`ts_rank_cd` over the generated `tsvector` columns, epic #164) and the
// semantic one (cosine distance over `search_embeddings`, epic #165). This file
// is how their two orderings become one ordering, and it is deliberately the
// whole of that decision - nothing outside it looks at a rank, and nothing
// inside it looks at a score.
//
// -----------------------------------------------------------------------------
// WHY RANKS, AND NOT NORMALISED SCORES
// -----------------------------------------------------------------------------
//
// The obvious alternative is to put both arms' scores on a common scale and add
// them: min-max the `ts_rank_cd` values into [0,1], min-max the cosine
// similarities into [0,1], weight, sum. It is rejected, and the reason is not
// tuning difficulty.
//
// `ts_rank_cd` and cosine similarity are INCOMPARABLE QUANTITIES whose
// distributions move per query. `ts_rank_cd` has no absolute scale at all (the
// DTO already says so about `score`): its magnitude depends on how many query
// terms there are, how close together they fall, and how long the matched
// document is. Cosine similarity over a normalised embedding space is bounded
// in [-1,1] but its USEFUL range is narrow and query-dependent - the gap
// between "about this" and "unrelated" might be 0.14 for one query and 0.03 for
// another. There is no fixed mapping between the two, so any blend has to
// manufacture one from the result set at hand.
//
// And that is the actual defect. Min-max (or z-score) normalisation computed
// over the rows a query happened to return makes A DOCUMENT'S SCORE A FUNCTION
// OF WHICH OTHER DOCUMENTS MATCHED. Index one more document somewhere in the
// corpus - an irrelevant one, at the bottom of the list, that nobody will ever
// read - and it moves the minimum or the maximum, which rescales every other
// document's contribution and can reorder the top of the list. A ranking whose
// order depends on the presence of rows nobody looked at is not a ranking; it
// is a ranking plus noise, and the noise is invisible because the results still
// look plausible.
//
// Ranks have none of that. A document's rank in a list depends only on the
// documents that beat it, so adding an irrelevant document to the corpus can
// only push things down by one - it cannot rescale anything. That property is
// exactly why RRF (Cormack, Clarke & Buettcher, SIGIR 2009) is the standard
// fusion for a lexical/semantic pair, and it is why this file has no weights,
// no calibration step and no per-query statistics.
//
// -----------------------------------------------------------------------------
// ALSO REJECTED: A "SEMANTIC / KEYWORD" TOGGLE IN THE UI
// -----------------------------------------------------------------------------
//
// The other way to avoid blending is to make the user choose - a segmented
// control over the search box, keyword on one side, semantic on the other.
// It is rejected outright, and not on grounds of clutter.
//
// Such a control asks the user to know WHICH RETRIEVAL STRATEGY THEIR QUESTION
// NEEDS before they have asked it. That is the question. Somebody typing
// `PROJ-4471` wants a literal token and needs the lexical arm; somebody typing
// "the call where we argued about refunds" wants meaning and needs the semantic
// one - and neither of them is thinking about inverted indexes, nor should they
// have to. A user who picks wrong gets an empty result list that looks exactly
// like "you have nothing about this", with a toggle nearby that they have no
// way of knowing was the problem. One search box, both arms, best available
// ranking: the fusion is the product decision, and this file is where it lives.
// =============================================================================

/**
 * The rank-damping constant, `k`, in `1 / (k + rank)`.
 *
 * 60 is the value the RRF literature settled on (Cormack et al. report it as
 * robust across collections without per-collection tuning), and it is
 * deliberately not a knob this deployment exposes: a fusion constant tuned per
 * installation is a ranking nobody can reason about twice.
 *
 * ⚠ WHAT IT ACTUALLY DOES IS DAMP THE HEAD OF EACH LIST, and that is the whole
 * behaviour worth understanding here. The first few terms are
 * `1/61 ≈ 0.01639`, `1/62 ≈ 0.01613`, `1/63 ≈ 0.01587` - nearly equal. So a
 * document that is RANK 1 IN ONE LIST AND ABSENT FROM THE OTHER scores
 * `0.01639`, while a document that is RANK 2 IN BOTH scores
 * `2 × 0.01613 = 0.03226` and wins comfortably. Agreement between the two arms
 * beats a single arm's confidence, which is the entire reason to run two arms.
 *
 * A small `k` inverts that: at `k = 1`, rank 1 alone scores `0.5` and rank 2 in
 * both scores `0.667` - still ordered correctly, but at `k = 0` rank 1 alone
 * scores `1.0` and rank 2 in both scores `1.0`, a tie, and any `k < 1` makes a
 * single first place unbeatable. Raising `k` far above 60 flattens the whole
 * list towards `n/k` and turns fusion into "how many arms found this at all".
 * 60 sits where a strong single-arm hit still ranks well without being able to
 * outrank cross-arm agreement.
 */
export const RRF_K = 60;

/**
 * Reciprocal-rank-fusion scores for a set of already-ordered lists.
 *
 * Each list is document KEYS in rank order, best first. Rank is 1-based
 * POSITION WITHIN THAT LIST - never a global rank, never a score threshold -
 * so the caller must have done its own roll-up and ordering first. That is not
 * an implementation convenience: it is what makes this function pure and what
 * makes the property in the header ("adding an irrelevant document cannot
 * rescale anything") true.
 *
 * ⚠ A DOCUMENT PRESENT IN ONLY ONE LIST GETS ONE TERM, and no rank is imputed
 * for the list it is missing from. Substituting "the length of the other list
 * plus one", or the cap, or any other stand-in is a NORMALISATION IN DISGUISE:
 * it manufactures a number out of the shape of the result set, which is
 * precisely what the header rejects score blending for. Absence is absence.
 *
 * A key repeated inside one list contributes ONE term, at its best (earliest)
 * position. In this application that cannot happen - both arms roll up to one
 * row per document before they are ranked - but the guard is cheap and the
 * failure it prevents is a document silently double-counted into the top of
 * the fused list.
 *
 * @returns key -> fused score. Higher is better. Ordering (and the tie-break
 *   between equal scores) is the caller's, because the tie-break belongs to
 *   whatever the caller is ranking, not to the arithmetic.
 */
export function reciprocalRankFusion(
  lists: ReadonlyArray<readonly string[]>,
  k: number = RRF_K,
): Map<string, number> {
  const fused = new Map<string, number>();

  for (const list of lists) {
    const counted = new Set<string>();

    for (const [index, key] of list.entries()) {
      if (counted.has(key)) continue;

      counted.add(key);
      fused.set(key, (fused.get(key) ?? 0) + 1 / (k + index + 1));
    }
  }

  return fused;
}
