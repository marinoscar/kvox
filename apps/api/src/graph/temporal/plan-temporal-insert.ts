// =============================================================================
// The insert planner: closing rule, out-of-order rule, soft overlap
// =============================================================================
//
// docs/specs/ontology.md §5.4 and §7 "Closing a temporal edge is a proposal
// row, not a side effect". The planner decides; it never writes. #365 turns a
// `create` plan's `closes` into `kind: 'closing'` proposal rows and its
// `flags` into item flags — nothing closes an edge except a reviewer
// accepting one of those rows.
//
// The rules, in the order they are applied (issue #353):
//   1. Non-temporal relation: restated or create, nothing else.
//   2. Scope: live (accepted/edited) edges of the same type and `fromId`,
//      plus the same `toId` when `exclusiveScope === 'from_to'`.
//   3. Same fact (same `toId` + identity props): an unknown-range candidate,
//      or one inside the edge's range, attaches evidence (out-of-order rule:
//      never reopen, never split). Anything else is a different period.
//   4. Closing: every open different-fact edge starting before the
//      candidate is closed at the candidate's start; the latest is superseded.
//   5. Older candidate: an open candidate is itself closed at the earliest
//      later different-fact start.
//   6. Unknown start: close nothing, flag `unordered`.
//   7. Soft overlap: flag `overlaps`, never reject.
//   8. `closes` and `overlapsWith` are sorted by edge id.
//
// Two edge cases the issue's rules do not name, decided here:
//   - An existing edge with a `null` range (unknown precision) is UNDATED. It
//     is never closed (closing it would fabricate a lower bound), never
//     compared for overlap, and — like rule 6 from the other side — flags a
//     `create` plan `unordered` when it is in scope. (An undated candidate
//     restating it still attaches under rule 3.)
//   - Rules 4–7 are exclusivity rules: under `exclusive: 'none'` a temporal
//     relation never closes, never back-dates the candidate and never flags.
// =============================================================================

import type {
  CandidateEdge,
  TemporalEdge,
  TemporalPlan,
  TemporalPlanFlag,
  TemporalRule,
  ValidRange,
} from './types';
import { isOpen, rangeContainsRange, rangesEqual, rangesOverlap } from './valid-range';

const LIVE = new Set<TemporalEdge['reviewStatus']>(['accepted', 'edited']);

/** Trim + case-fold a string prop; anything else compares by its JSON form. */
function normalizeIdentity(value: unknown): string {
  if (value === undefined || value === null) return '\u0000null';
  if (typeof value === 'string') return `s:${value.trim().toLowerCase()}`;
  return `j:${JSON.stringify(value)}`;
}

function sameIdentity(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  identityProps: readonly string[]
): boolean {
  return identityProps.every((key) => normalizeIdentity(a[key]) === normalizeIdentity(b[key]));
}

const time = (d: Date | null): number => (d === null ? -Infinity : d.getTime());

function byId(a: { id: string } | string, b: { id: string } | string): number {
  const x = typeof a === 'string' ? a : a.id;
  const y = typeof b === 'string' ? b : b.id;
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Ascending by `from` (nulls first), ties broken by id. */
function byStart(a: TemporalEdge, b: TemporalEdge): number {
  const d = time(a.valid?.from ?? null) - time(b.valid?.from ?? null);
  if (d !== 0 && !Number.isNaN(d)) return d < 0 ? -1 : 1;
  return byId(a, b);
}

function emptyCreate(): Extract<TemporalPlan, { action: 'create' }> {
  return {
    action: 'create',
    closes: [],
    supersedes: null,
    candidateTo: null,
    flags: [],
    overlapsWith: [],
  };
}

/**
 * Plan where a candidate edge goes. `existing` is the owner's edges of the
 * candidate's type (anything else is filtered out defensively).
 */
export function planTemporalInsert(
  existing: readonly TemporalEdge[],
  candidate: CandidateEdge,
  rule: TemporalRule
): TemporalPlan {
  const live = existing.filter(
    (e) => LIVE.has(e.reviewStatus) && e.type === candidate.type && e.fromId === candidate.fromId
  );
  const isSameFact = (e: TemporalEdge): boolean =>
    e.toId === candidate.toId && sameIdentity(e.props, candidate.props, rule.identityProps);

  // ---- Rule 1: a non-temporal relation has no ranges to reason about.
  if (!rule.temporal) {
    const same = live.filter(isSameFact).sort(byId)[0];
    return same
      ? { action: 'attach_evidence', edgeId: same.id, reason: 'restated' }
      : emptyCreate();
  }

  // ---- Rule 2: the comparison scope.
  const scope = live.filter((e) => rule.exclusiveScope === 'from' || e.toId === candidate.toId);
  const cRange = candidate.valid;

  // ---- Rule 3: the same fact.
  const sameFact = scope.filter(isSameFact).sort(byStart);
  if (sameFact.length > 0) {
    if (cRange === null) {
      // Undated restatement: prefer the open edge (the current one), else the latest.
      const open = sameFact.filter((e) => e.valid !== null && isOpen(e.valid));
      const target = open.length > 0 ? open[open.length - 1] : sameFact[sameFact.length - 1];
      return { action: 'attach_evidence', edgeId: target.id, reason: 'restated' };
    }
    const dated = sameFact.filter(
      (e): e is TemporalEdge & { valid: ValidRange } => e.valid !== null
    );
    const equal = dated.find((e) => rangesEqual(e.valid, cRange));
    if (equal) return { action: 'attach_evidence', edgeId: equal.id, reason: 'restated' };
    const container = dated.find((e) => rangeContainsRange(e.valid, cRange));
    if (container) {
      return { action: 'attach_evidence', edgeId: container.id, reason: 'inside_existing' };
    }
    // Extends outside every same-fact edge: a different period. Never merged.
  }

  const plan = emptyCreate();
  if (rule.exclusive !== 'soft') return plan;

  const different = scope.filter((e) => !isSameFact(e));
  const dated = different.filter(
    (e): e is TemporalEdge & { valid: ValidRange } => e.valid !== null
  );
  // Undated edges in scope — same fact or not — cannot be ordered against a
  // dated candidate; a reviewer decides.
  const undated = scope.filter((e) => e.valid === null);
  const flags = new Set<TemporalPlanFlag>();
  if (undated.length > 0) flags.add('unordered');

  const cFrom = cRange?.from ?? null;
  const newTo = new Map<string, Date>();

  if (cFrom === null) {
    // ---- Rule 6: unknown start — a reviewer orders it, not the planner.
    if (dated.some((e) => isOpen(e.valid))) flags.add('unordered');
  } else {
    // ---- Rule 4: the closing rule.
    const closable = dated
      .filter((e) => isOpen(e.valid) && time(e.valid.from) < cFrom.getTime())
      .sort(byStart);
    for (const e of closable) newTo.set(e.id, cFrom);
    plan.closes = closable
      .map((e) => ({ edgeId: e.id, newTo: cFrom }))
      .sort((a, b) => byId(a.edgeId, b.edgeId));
    plan.supersedes = closable.length > 0 ? closable[closable.length - 1].id : null;

    // ---- Rule 5: an older, open candidate is proposed already closed.
    if (cRange !== null && isOpen(cRange)) {
      const laterStarts = dated
        .map((e) => e.valid.from)
        .filter((f): f is Date => f !== null && f.getTime() > cFrom.getTime())
        .sort((a, b) => a.getTime() - b.getTime());
      if (laterStarts.length > 0) plan.candidateTo = laterStarts[0];
    }
  }

  // ---- Rule 7: soft overlap, measured after the closes and candidateTo.
  if (cRange !== null) {
    const finalCandidate: ValidRange = { from: cRange.from, to: plan.candidateTo ?? cRange.to };
    plan.overlapsWith = dated
      .filter((e) => {
        const closedAt = newTo.get(e.id);
        const post: ValidRange = closedAt ? { from: e.valid.from, to: closedAt } : e.valid;
        return rangesOverlap(post, finalCandidate);
      })
      .map((e) => e.id)
      .sort(byId);
    if (plan.overlapsWith.length > 0) flags.add('overlaps');
  }

  // Fixed flag order, independent of the order the rules fired in.
  plan.flags = (['overlaps', 'unordered'] as const).filter((f) => flags.has(f));
  return plan;
}
