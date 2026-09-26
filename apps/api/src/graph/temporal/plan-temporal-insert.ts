// =============================================================================
// The insert planner: closing, out-of-order and soft-overlap rules
// (issue #353; docs/specs/ontology.md §5.4, §7)
// =============================================================================
//
// Given the live edges of one type for one owner and a candidate edge, decide
// what the candidate MEANS — never write anything. Every close the plan names
// becomes its own `closing` proposal row a reviewer accepts or rejects (#365);
// nothing here mutates an existing range, and nothing ever rejects a
// candidate: an overlap is a flag, not an error.
//
// Rules (numbered as in issue #353):
//  1. Non-temporal: same from/to/identity → attach (restated), else create.
//  2. Scope: live (accepted|edited) edges of the type from the same `fromId`,
//     plus the same `toId` when `exclusiveScope === 'from_to'`.
//  3. Same fact (same `toId` + identity props, trimmed and case-folded):
//     an unknown or contained candidate range attaches evidence; a range
//     reaching outside it is a different period and continues below.
//  4. Closing: every open, different-fact edge starting before the candidate
//     (or at an unknown start) closes at the candidate's `from`; the candidate
//     supersedes the latest of them.
//  5. Older candidate: an open candidate with a later different-fact edge is
//     proposed already closed at the earliest such start.
//  6. Unknown start: nothing closes; `unordered` when an open (or undated)
//     different-fact edge exists.
//  7. Soft overlap: after 4 and 5, every in-scope edge whose range still
//     overlaps the candidate's is listed and the plan flagged `overlaps`.
//  8. `closes` and `overlapsWith` are sorted by edge id.
//
// PURE: no Prisma, no Nest, no clock read.
// =============================================================================

import type {
  CandidateEdge,
  TemporalEdge,
  TemporalFlag,
  TemporalPlan,
  TemporalReviewStatus,
  TemporalRule,
  ValidRange,
} from './types';
import { rangeContainsRange, rangesEqual, rangesOverlap } from './valid-range';

/** Statuses the planner compares against. Everything else is invisible to it. */
export const LIVE_STATUSES: ReadonlySet<TemporalReviewStatus> = new Set<TemporalReviewStatus>([
  'accepted',
  'edited',
]);

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Identity comparison key: strings trimmed and case-folded; absent ≡ null. */
function identityKey(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (typeof value === 'string') return `s:${value.trim().toLowerCase()}`;
  return `j:${stableStringify(value)}`;
}

function sameIdentity(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  rule: TemporalRule
): boolean {
  return rule.identityProps.every((k) => identityKey(a[k]) === identityKey(b[k]));
}

function isSameFact(edge: TemporalEdge, candidate: CandidateEdge, rule: TemporalRule): boolean {
  return edge.toId === candidate.toId && sameIdentity(edge.props, candidate.props, rule);
}

const byId = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Ascending by `from`, unknown (`null`) first, ties by id. */
function byFromNullsFirst(a: TemporalEdge, b: TemporalEdge): number {
  const af = a.valid?.from?.getTime() ?? Number.NEGATIVE_INFINITY;
  const bf = b.valid?.from?.getTime() ?? Number.NEGATIVE_INFINITY;
  return af !== bf ? af - bf : byId(a, b);
}

/**
 * For an undated restatement of a fact with several periods, the period it
 * most plausibly restates: an open dated edge, then an undated one, then the
 * latest-ending; ties by id.
 */
function preferredForUndated(edges: readonly TemporalEdge[]): TemporalEdge {
  const rank = (e: TemporalEdge) =>
    e.valid !== null && e.valid.to === null ? 0 : e.valid === null ? 1 : 2;
  const end = (e: TemporalEdge) => e.valid?.to?.getTime() ?? Number.POSITIVE_INFINITY;
  return [...edges].sort((a, b) => rank(a) - rank(b) || end(b) - end(a) || byId(a, b))[0];
}

function emptyCreate(): TemporalPlan {
  return {
    action: 'create',
    closes: [],
    supersedes: null,
    candidateTo: null,
    flags: [],
    overlapsWith: [],
  };
}

export function planTemporalInsert(
  existing: readonly TemporalEdge[],
  candidate: CandidateEdge,
  rule: TemporalRule
): TemporalPlan {
  const live = existing.filter(
    (e) =>
      LIVE_STATUSES.has(e.reviewStatus) &&
      e.type === candidate.type &&
      e.fromId === candidate.fromId
  );

  // Rule 1 — a non-temporal relation has no periods: it either exists or not.
  if (!rule.temporal) {
    const same = live.filter((e) => isSameFact(e, candidate, rule)).sort(byId);
    return same.length > 0
      ? { action: 'attach_evidence', edgeId: same[0].id, reason: 'restated' }
      : emptyCreate();
  }

  // Rule 2 — scope.
  const scope =
    rule.exclusiveScope === 'from_to' ? live.filter((e) => e.toId === candidate.toId) : live;
  const same = scope.filter((e) => isSameFact(e, candidate, rule));
  const different = scope.filter((e) => !isSameFact(e, candidate, rule));
  const cv = candidate.valid;

  // Rule 3 — the same fact, restated or inside a known period (out-of-order rule).
  if (same.length > 0) {
    if (cv === null) {
      return {
        action: 'attach_evidence',
        edgeId: preferredForUndated(same).id,
        reason: 'restated',
      };
    }
    const dated = same
      .filter((e): e is TemporalEdge & { valid: ValidRange } => e.valid !== null)
      .sort(byId);
    const equal = dated.find((e) => rangesEqual(e.valid, cv));
    if (equal) return { action: 'attach_evidence', edgeId: equal.id, reason: 'restated' };
    const container = dated.find((e) => rangeContainsRange(e.valid, cv));
    if (container)
      return { action: 'attach_evidence', edgeId: container.id, reason: 'inside_existing' };
    // Reaches outside every known period of this fact: a new period. Never merged.
  }

  // Only a normally-exclusive relation closes, clips or warns.
  if (rule.exclusive !== 'soft') return emptyCreate();

  const flags = new Set<TemporalFlag>();
  const closes: { edgeId: string; newTo: Date }[] = [];
  let supersedes: string | null = null;
  let candidateTo: Date | null = null;
  const candidateFrom = cv?.from ?? null;

  if (candidateFrom === null) {
    // Rule 6 — unknown start: the order cannot be decided here; a reviewer does.
    if (different.some((e) => e.valid === null || e.valid.to === null)) flags.add('unordered');
  } else {
    const start = candidateFrom.getTime();

    // Rule 4 — closing.
    const closable = different
      .filter(
        (e) =>
          e.valid !== null &&
          e.valid.to === null &&
          (e.valid.from === null || e.valid.from.getTime() < start)
      )
      .sort(byFromNullsFirst);
    for (const e of [...closable].sort(byId)) closes.push({ edgeId: e.id, newTo: new Date(start) });
    if (closable.length > 0) supersedes = closable[closable.length - 1].id;

    // Rule 5 — an older, open candidate is proposed already closed.
    if (cv !== null && cv.to === null) {
      const laterStarts = different
        .map((e) => e.valid?.from?.getTime())
        .filter((t): t is number => t !== undefined && t > start);
      if (laterStarts.length > 0) candidateTo = new Date(Math.min(...laterStarts));
    }

    // An undated different-fact edge cannot be ordered against a dated candidate.
    if (different.some((e) => e.valid === null)) flags.add('unordered');
  }

  // Rule 7 — soft overlap, against post-close ranges.
  const overlapsWith: string[] = [];
  if (cv !== null) {
    const finalRange: ValidRange = { from: cv.from, to: candidateTo ?? cv.to };
    const closedIds = new Set(closes.map((c) => c.edgeId));
    for (const e of scope) {
      if (e.valid === null) continue;
      const post: ValidRange = closedIds.has(e.id)
        ? { from: e.valid.from, to: candidateFrom }
        : e.valid;
      if (rangesOverlap(post, finalRange)) overlapsWith.push(e.id);
    }
  }
  if (overlapsWith.length > 0) flags.add('overlaps');

  // Rule 8 — deterministic output.
  return {
    action: 'create',
    closes,
    supersedes,
    candidateTo,
    flags: [...flags].sort(),
    overlapsWith: overlapsWith.sort(),
  };
}
