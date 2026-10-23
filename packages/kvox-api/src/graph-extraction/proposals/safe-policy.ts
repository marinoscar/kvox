// =============================================================================
// The safe policy (#717, epic #708; ADR-0007)
// =============================================================================
//
// PURE. Decides which rows of ONE draft proposal a batch commit or an
// auto-commit may accept without a person. Everything it does not accept
// "waits": it stays in the draft for review.
//
// NEVER accepted, whatever the options:
//   - a sensitive person fact (`person_fact` whose sensitivity is not
//     `business`, or flagged `sensitive`) — INVARIANT: no code path, no option,
//     no id list can make this function return such a row in `accept`
//   - a closing
//   - an entity row that would link to / merge into an existing entity
//   - an ambiguous resolution (`ambiguous`, `possible_duplicate`,
//     `model_claimed_match` flags, an `uncertain` adjudication)
//   - a row below `minConfidence`
//   - a row of a review-only type (the personal domain, §15)
//   - a relation / item / closing whose endpoint entity is not itself accepted
//
// Decisions a person (or the pre-check) already made are kept as they are: a
// rejected row stays rejected, an accepted / edited / merged row counts as
// accepted. This function returns the rows to ADD to the accepted set.
// =============================================================================

/**
 * Why the safe policy leaves a row for a person.
 *
 * @stability experimental
 */
export type SafePolicyWaitReason =
  | 'sensitive'
  | 'closing'
  | 'ambiguous'
  | 'merge'
  | 'low_confidence'
  | 'flagged'
  | 'blocked_endpoint';

/**
 * The adjudicator's verdict on a resolution.
 *
 * @stability experimental
 */
export interface SafePolicyAdjudication {
  /** The verdict. */
  verdict: 'same' | 'different' | 'uncertain';
}

/**
 * A row's resolution, reduced to what the policy reads.
 *
 * @stability experimental
 */
export interface SafePolicyResolution {
  /** The entity the row links to, or `null` for a new entity. */
  ref: string | null;
  /** The resolution score, or `null`. */
  score: number | null;
  /** The adjudicator's verdict, when one ran. */
  adjudication?: SafePolicyAdjudication | null;
}

/**
 * One proposal row, reduced to what the policy reads.
 *
 * @stability experimental
 */
export interface SafePolicyItem {
  /** The row id. */
  id: string;
  /** The row kind. */
  kind: 'entity' | 'relation' | 'item' | 'closing';
  /** The decision so far. */
  decision: 'pending' | 'accept' | 'edit' | 'reject' | 'merge_into';
  /** `payload.ref` of the row (what other rows point to). */
  ref: string | null;
  /** A closing's `closedByRef`: the relation row that closes the edge. */
  closedByRef?: string | null;
  /** The effective payload's `kind` of an `item` row (`person_fact`, `commitment`, ...). */
  itemKind: string | null;
  /** The effective payload's `sensitivity` of an `item` row. */
  sensitivity: string | null;
  /** The effective type is review-only (`reviewOnlyTypes`), e.g. a personal-domain type. */
  reviewOnly: boolean;
  /** The row's flags. */
  flags: readonly string[];
  /** The row's resolution (entity rows). */
  resolution: SafePolicyResolution | null;
  /** Proposal refs this row's endpoints point to (`{ ref }` endpoints). */
  endpointRefs: readonly string[];
}

/**
 * What the safe policy is told.
 *
 * @stability experimental
 */
export interface SafePolicyOptions {
  /** 0..1, from `graph.review.minConfidence`. */
  minConfidence: number;
}

/**
 * A row that stays for a person, and why.
 *
 * @stability experimental
 */
export interface SafePolicyWaiting {
  /** The row id. */
  itemId: string;
  /** Why it waits. */
  reason: SafePolicyWaitReason;
}

/**
 * What the safe policy decided for one proposal.
 *
 * @stability experimental
 */
export interface SafePolicyResult {
  /** Pending rows the policy accepts now. */
  accept: string[];
  /** Pending rows that stay for a person. */
  waiting: SafePolicyWaiting[];
  /** Rows already accepted / edited / merged by a person or the pre-check. */
  alreadyAccepted: string[];
  /** Rows already rejected; they stay rejected. */
  rejected: string[];
}

const AMBIGUOUS_FLAGS: ReadonlySet<string> = new Set(['ambiguous', 'possible_duplicate', 'model_claimed_match']);
const FLAGGED: ReadonlySet<string> = new Set([
  'overlaps',
  'unordered',
  'supersedes',
  'stale_ontology',
  'previously_rejected',
  'type_changed',
  'quote_not_located',
]);
const DECIDED_ACCEPT: ReadonlySet<string> = new Set(['accept', 'edit', 'merge_into']);

/** True for a person fact that must never be bulk-accepted (§5.6, §15). */
export function isSensitivePersonFact(item: Pick<SafePolicyItem, 'kind' | 'itemKind' | 'sensitivity' | 'flags'>): boolean {
  if (item.kind !== 'item' || item.itemKind !== 'person_fact') return false;
  return item.sensitivity !== 'business' || item.flags.includes('sensitive');
}

/**
 * The confidence the policy compares. A link: its score. A new entity: how clearly it is new,
 * `1 - top candidate score` (a near-miss candidate means a person should look). `null` = no signal.
 */
export function confidenceOf(item: Pick<SafePolicyItem, 'resolution'>): number | null {
  const res = item.resolution;
  if (!res || res.score === null) return null;
  return res.ref ? res.score : 1 - res.score;
}

function ownReason(item: SafePolicyItem, minConfidence: number): SafePolicyWaitReason | null {
  if (isSensitivePersonFact(item) || item.reviewOnly) return 'sensitive';
  if (item.kind === 'closing') return 'closing';
  if (item.kind === 'entity' && (item.resolution?.ref || item.decision === 'merge_into')) return 'merge';
  if (item.flags.some((f) => AMBIGUOUS_FLAGS.has(f)) || item.resolution?.adjudication?.verdict === 'uncertain') return 'ambiguous';
  if (item.flags.some((f) => FLAGGED.has(f))) return 'flagged';
  const confidence = confidenceOf(item);
  if (confidence !== null && confidence < minConfidence) return 'low_confidence';
  return null;
}

/** Applies the safe policy to one proposal's rows. */
export function applySafePolicy(items: readonly SafePolicyItem[], options: SafePolicyOptions): SafePolicyResult {
  const result: SafePolicyResult = { accept: [], waiting: [], alreadyAccepted: [], rejected: [] };
  const acceptedRefs = new Set<string>();
  const pending: SafePolicyItem[] = [];

  for (const item of items) {
    if (item.decision === 'reject') result.rejected.push(item.id);
    else if (DECIDED_ACCEPT.has(item.decision)) {
      result.alreadyAccepted.push(item.id);
      if (item.ref && item.kind === 'entity') acceptedRefs.add(item.ref);
    } else pending.push(item);
  }

  // Own verdicts first, then endpoints: an entity's fate decides its dependants.
  const own = new Map<string, SafePolicyWaitReason | null>();
  for (const item of pending) own.set(item.id, ownReason(item, options.minConfidence));

  // A relation a waiting closing points to waits with it: the remainder draft keeps them together
  // (a closing whose `closedByRef` row was committed elsewhere could no longer resolve it).
  const closerRefs = new Set(pending.filter((i) => i.kind === 'closing' && i.closedByRef).map((i) => i.closedByRef as string));
  for (const item of pending) {
    if (own.get(item.id) === null && item.kind === 'relation' && item.ref && closerRefs.has(item.ref)) own.set(item.id, 'flagged');
  }

  // Entities that pass are accepted; a dependant waits on any endpoint that is not accepted.
  for (const item of pending) {
    if (item.kind === 'entity' && own.get(item.id) === null && item.ref) acceptedRefs.add(item.ref);
  }
  for (const item of pending) {
    const reason = own.get(item.id) ?? null;
    if (reason) {
      result.waiting.push({ itemId: item.id, reason });
    } else if (item.kind !== 'entity' && item.endpointRefs.some((r) => !acceptedRefs.has(r))) {
      result.waiting.push({ itemId: item.id, reason: 'blocked_endpoint' });
    } else {
      result.accept.push(item.id);
    }
  }
  return result;
}
