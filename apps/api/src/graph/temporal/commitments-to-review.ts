// =============================================================================
// Company change side effect (docs/specs/ontology.md §5.4, third worked example)
// =============================================================================
//
// When a person's `WORKS_FOR` edge closes, every OPEN `Commitment` where that
// person is owner or counterparty is flagged `closing_affects_commitments`
// for a reviewer's second look. It is never voided automatically. A
// `HAS_ROLE` or `REPORTS_TO` close flags nothing, and `PersonFact`s carry over
// untouched — neither has anything to do with the employer changing.
// =============================================================================

import type { TemporalEdge, TemporalPlan } from './types';

/** The one relation whose closing puts commitments up for review. */
export const EMPLOYMENT_RELATION = 'WORKS_FOR';

export interface OpenCommitmentRef {
  id: string;
  ownerPersonId: string | null;
  counterpartyId: string | null;
}

/**
 * Commitment ids to flag, sorted and de-duplicated. `closedEdges` is how the
 * caller supplies the edges `plan.closes` names (the plan carries only ids);
 * an edge in it that the plan does not close is ignored.
 */
export function commitmentsToReview(
  plan: TemporalPlan,
  closedEdges: readonly TemporalEdge[],
  openCommitments: readonly OpenCommitmentRef[]
): string[] {
  if (plan.action !== 'create' || plan.closes.length === 0) return [];
  const closing = new Set(plan.closes.map((c) => c.edgeId));
  const people = new Set(
    closedEdges
      .filter((e) => closing.has(e.id) && e.type === EMPLOYMENT_RELATION)
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
  return [...new Set(ids)].sort(byString);
}

function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
