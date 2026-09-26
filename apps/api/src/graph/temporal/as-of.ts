// =============================================================================
// `as_of` evaluation (docs/specs/ontology.md §5.4, §9.1)
// =============================================================================
//
// `as_of` changes which EDGES are considered open, by evaluating every `valid`
// range against a past date instead of the present. `since` is a different
// question (which ITEMS are new enough) and does not live here.
// =============================================================================

import type { TemporalEdge, TemporalReviewStatus } from './types';
import { isValidAt } from './valid-range';

/**
 * The review statuses that are part of the graph's history. `superseded` IS
 * history: Jane, closed by the manager change, is the answer to "as of
 * January 2024". `merged`, `rejected` and `unreviewed` never are.
 */
const HISTORICAL: ReadonlySet<TemporalReviewStatus> = new Set(['accepted', 'edited', 'superseded']);

/**
 * The edges that held at `asOf`, in input order. A `null` range (not
 * temporal, or `unknown` precision) holds at every date — `isValidAt`'s
 * contract.
 */
export function edgesAsOf(edges: readonly TemporalEdge[], asOf: Date): TemporalEdge[] {
  return edges.filter((e) => HISTORICAL.has(e.reviewStatus) && isValidAt(e.valid, asOf));
}
