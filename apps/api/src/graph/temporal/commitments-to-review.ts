// =============================================================================
// The company-change side effect (issue #353; docs/specs/ontology.md §5.4,
// third worked example)
// =============================================================================
//
// When a person's WORKS_FOR edge closes, every OPEN commitment where they are
// owner or counterparty is flagged for a second look — not voided, not
// changed. Closing a HAS_ROLE or REPORTS_TO edge flags nothing: a promotion
// or a new manager does not put an employee's commitments in question the
// way leaving the employer does. PersonFacts are untouched by any close.
// =============================================================================

import type { TemporalEdge, TemporalPlan } from './types';

/** The one relation type whose close puts commitments in question. */
export const COMMITMENT_REVIEW_RELATION = 'WORKS_FOR';

/**
 * Commitment ids to flag `closing_affects_commitments`, sorted and unique.
 * `closedEdges` supplies the edges `plan.closes` names (extra edges are
 * ignored); `openCommitments` is the caller's pre-filtered open set.
 */
export function commitmentsToReview(
  plan: TemporalPlan,
  closedEdges: readonly TemporalEdge[],
  openCommitments: readonly {
    id: string;
    ownerPersonId: string | null;
    counterpartyId: string | null;
  }[]
): string[] {
  if (plan.action !== 'create' || plan.closes.length === 0) return [];
  const closing = new Set(plan.closes.map((c) => c.edgeId));
  const people = new Set(
    closedEdges
      .filter((e) => closing.has(e.id) && e.type === COMMITMENT_REVIEW_RELATION)
      .map((e) => e.fromId)
  );
  if (people.size === 0) return [];
  const ids = openCommitments
    .filter(
      (c) =>
        (c.ownerPersonId !== null && people.has(c.ownerPersonId)) ||
        (c.counterpartyId !== null && people.has(c.counterpartyId))
    )
    .map((c) => c.id);
  return [...new Set(ids)].sort();
}
