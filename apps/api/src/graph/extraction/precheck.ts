// =============================================================================
// applyPrecheck (#363; docs/specs/ontology.md §8 "pre-check rule", §19)
// =============================================================================
//
// PURE. Decides which proposal rows arrive ticked (`accept`) and which wait for
// a person (`pending`). Runs once, after every pipeline stage, so it sees the
// final resolutions and flags. A pre-check is only a default — nothing enters
// the graph until the reviewer commits (#366).
//
//   - `resolution.mode === 'review_all'` → everything pending.
//   - entity: accept iff (linked with `score ≥ autoLinkThreshold` and an
//     adjudication that is not `uncertain`) or (new with no candidates, or a
//     top candidate below `newThreshold`) — and never with a
//     `possible_duplicate`, `ambiguous` or `model_claimed_match` flag.
//   - relation / item: accept iff every entity endpoint is an existing entity
//     or a proposal entity that is itself `accept`, the kind is not
//     `person_fact`, and no blocking flag is set.
//   - `person_fact` and `closing`: never pre-checked.
//   - #365: a relation/item flagged `known` (the graph already holds it; the
//     commit only appends evidence) is accepted whenever its endpoints are —
//     whatever other flag it carries, `person_fact` included — except a
//     `sensitive` PersonFact (§5.6). A row flagged `previously_rejected` is
//     defaulted to `reject` (visible, collapsed; the reviewer can flip it).
// =============================================================================

import type { GraphPreferences } from '../preferences/graph-preferences.defaults';
import type {
  EndpointRef,
  ProposalItemFlag,
  ProposalResolution,
} from '../proposals/proposal-payload.schema';

export type PrecheckDecision = 'accept' | 'pending' | 'reject';

/** The part of a proposal item the pre-check reads, and the one field it writes. */
export interface PrecheckItem {
  kind: 'entity' | 'relation' | 'item' | 'closing';
  payload: Record<string, unknown>;
  resolution: ProposalResolution | null;
  flags: readonly (ProposalItemFlag | string)[];
  decision: PrecheckDecision | string;
}

const ENTITY_BLOCKING: readonly string[] = ['possible_duplicate', 'ambiguous', 'model_claimed_match'];
const ROW_BLOCKING: readonly string[] = [
  'possible_duplicate',
  'overlaps',
  'unordered',
  'supersedes',
  'previously_rejected',
  'stale_ontology',
];

function entityAccepted(item: PrecheckItem, prefs: GraphPreferences): boolean {
  if (item.flags.some((f) => ENTITY_BLOCKING.includes(f))) return false;
  const res = item.resolution;
  const { autoLinkThreshold, newThreshold } = prefs.resolution;
  if (res?.ref) {
    return res.score !== null && res.score >= autoLinkThreshold && res.adjudication?.verdict !== 'uncertain';
  }
  const candidates = res?.candidates ?? [];
  if (candidates.length === 0) return true;
  const top = Math.max(...candidates.map((c) => c.score));
  return top < newThreshold;
}

function endpoints(item: PrecheckItem): EndpointRef[] {
  const keys = item.kind === 'relation' ? ['from', 'to'] : ['subject', 'owner', 'counterparty', 'meeting'];
  return keys
    .map((k) => item.payload[k])
    .filter((v): v is EndpointRef => typeof v === 'object' && v !== null);
}

/** Sets `decision` on every item, in place. Entities are decided first. */
export function applyPrecheck(items: PrecheckItem[], prefs: GraphPreferences): void {
  if (prefs.resolution.mode === 'review_all') {
    for (const item of items) item.decision = 'pending';
    return;
  }

  const acceptedRefs = new Set<string>();
  for (const item of items) {
    if (item.kind !== 'entity') continue;
    const ok = entityAccepted(item, prefs);
    item.decision = ok ? 'accept' : 'pending';
    const ref = item.payload.ref;
    if (ok && typeof ref === 'string') acceptedRefs.add(ref);
  }

  for (const item of items) {
    if (item.kind === 'entity') continue;
    if (item.kind === 'closing') {
      item.decision = 'pending';
      continue;
    }
    const endpointsAccepted = endpoints(item).every((e) => ('entityId' in e ? true : acceptedRefs.has(e.ref)));
    if (item.flags.includes('known')) {
      const sensitive = item.kind === 'item' && item.payload.sensitivity === 'sensitive';
      item.decision = !sensitive && endpointsAccepted ? 'accept' : 'pending';
      continue;
    }
    if (item.flags.includes('previously_rejected')) {
      item.decision = 'reject';
      continue;
    }
    if (item.kind === 'item' && item.payload.kind === 'person_fact') {
      item.decision = 'pending';
      continue;
    }
    const blocked = item.flags.some((f) => ROW_BLOCKING.includes(f));
    item.decision = !blocked && endpointsAccepted ? 'accept' : 'pending';
  }
}
