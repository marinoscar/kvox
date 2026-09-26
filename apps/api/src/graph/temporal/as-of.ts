// =============================================================================
// `as_of` evaluation (issue #353; docs/specs/ontology.md §5.4, §9.1)
// =============================================================================
//
// Which edges were true at a past instant. The instant is always a parameter:
// this module never reads the clock, so "now" is whatever the caller passes.
// =============================================================================

import type { TemporalEdge, TemporalReviewStatus } from './types';
import { isValidAt } from './valid-range';

/**
 * Review statuses that describe the world as the graph believes it was.
 * `superseded` IS history — the manager-change example reads a superseded
 * `REPORTS_TO` edge for a date inside it — so it is kept. `merged`,
 * `rejected` and `unreviewed` never answer an `as_of` question.
 */
export const AS_OF_STATUSES: ReadonlySet<TemporalReviewStatus> = new Set<TemporalReviewStatus>([
  'accepted',
  'edited',
  'superseded',
]);

/**
 * The edges valid at `asOf`, in input order. A `null` range (non-temporal,
 * or `unknown` precision) is valid at every instant — `isValidAt`'s contract,
 * which the SQL `(valid IS NULL OR valid @> $asOf)` mirrors.
 */
export function edgesAsOf(edges: readonly TemporalEdge[], asOf: Date): TemporalEdge[] {
  return edges.filter(
    (edge) => AS_OF_STATUSES.has(edge.reviewStatus) && isValidAt(edge.valid, asOf)
  );
}
