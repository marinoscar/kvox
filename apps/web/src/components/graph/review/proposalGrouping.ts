/**
 * Pure logic behind the proposal review sheet (#367; ontology.md §8, §19).
 *
 * - Groups rows in #366's `groupKey` order, hiding empty groups, and folds
 *   `known` / `previously_rejected` rows into two collapsed disclosures at the
 *   end of their group.
 * - Decides which rows only an individual "Accept" may tick (sensitive person
 *   facts and closings, §5.6) — the server enforces the same rule on bulk.
 * - `blockingEndpoints()` finds the proposal entity rows a relation/item row
 *   points at that are not (yet) going to be sent: the row cannot be sent
 *   until they are, so its checkbox is disabled and the sheet says why.
 */

import { PROPOSAL_GROUP_ORDER } from '../../../services/graph';
import type {
  BulkDecideResult,
  EndpointRef,
  ProposalDecision,
  ProposalGroupKey,
  ProposalItem,
  RelinkField,
} from '../../../services/graph';

export const GROUP_LABELS: Record<ProposalGroupKey, string> = {
  Person: 'People',
  Organization: 'Organizations',
  Project: 'Projects',
  Meeting: 'Meeting',
  Decision: 'Decisions',
  Commitment: 'Commitments',
  Claim: 'Claims',
  PersonFact: 'Person facts',
  Other: 'Other',
  relations: 'Relations',
  closings: 'Closes',
};

export interface ProposalGroupView {
  key: ProposalGroupKey;
  label: string;
  /** Rows reviewed in the group body. */
  rows: ProposalItem[];
  /** `known` rows — "Already in your graph (n)". */
  known: ProposalItem[];
  /** `previously_rejected` rows — "Rejected before (n)". */
  rejectedBefore: ProposalItem[];
}

export function isKnownRow(item: ProposalItem): boolean {
  return item.flags.includes('known');
}

export function groupProposalItems(items: readonly ProposalItem[]): ProposalGroupView[] {
  const byKey = new Map<ProposalGroupKey, ProposalGroupView>();
  for (const key of PROPOSAL_GROUP_ORDER) {
    byKey.set(key, { key, label: GROUP_LABELS[key], rows: [], known: [], rejectedBefore: [] });
  }
  for (const item of items) {
    const group = byKey.get(item.groupKey) ?? byKey.get('Other');
    if (!group) continue;
    if (isKnownRow(item)) group.known.push(item);
    else if (item.flags.includes('previously_rejected')) group.rejectedBefore.push(item);
    else group.rows.push(item);
  }
  return [...byKey.values()].filter(
    (group) => group.rows.length + group.known.length + group.rejectedBefore.length > 0,
  );
}

const CHECKED: readonly ProposalDecision[] = ['accept', 'edit', 'merge_into'];

/** Checked ⇔ the row will be sent at commit. */
export function isChecked(decision: ProposalDecision): boolean {
  return CHECKED.includes(decision);
}

/** Sensitive person facts and closings: never ticked by a group action (§5.6). */
export function requiresIndividualAccept(item: ProposalItem): boolean {
  if (item.kind === 'closing') return true;
  const payload = item.effectivePayload as { kind?: unknown; sensitivity?: unknown };
  return (
    item.flags.includes('sensitive') ||
    (payload.kind === 'person_fact' && payload.sensitivity === 'sensitive')
  );
}

/** The ids a group's "Accept all" / "Reject all" sends: every non-`known` row. */
export function bulkTargetIds(group: ProposalGroupView): string[] {
  return [...group.rows, ...group.rejectedBefore].map((item) => item.id);
}

export const ENDPOINT_FIELDS: Record<'relation' | 'item', readonly RelinkField[]> = {
  relation: ['from', 'to'],
  item: ['subject', 'owner', 'counterparty', 'meeting'],
};

export function endpointFields(item: ProposalItem): readonly RelinkField[] {
  return item.kind === 'relation' || item.kind === 'item' ? ENDPOINT_FIELDS[item.kind] : [];
}

export function readEndpoint(item: ProposalItem, field: RelinkField): EndpointRef | null {
  const value = (item.effectivePayload as Record<string, unknown>)[field];
  if (typeof value !== 'object' || value === null) return null;
  if ('entityId' in value && typeof (value as { entityId: unknown }).entityId === 'string') {
    return { entityId: (value as { entityId: string }).entityId };
  }
  if ('ref' in value && typeof (value as { ref: unknown }).ref === 'string') {
    return { ref: (value as { ref: string }).ref };
  }
  return null;
}

/** The proposal entity row a `{ ref }` names, if any. */
export function entityRowForRef(items: readonly ProposalItem[], ref: string): ProposalItem | undefined {
  return items.find(
    (row) => row.kind === 'entity' && (row.effectivePayload as { ref?: unknown }).ref === ref,
  );
}

export interface BlockingEndpoint {
  field: RelinkField;
  ref: string;
  label: string;
  itemId: string;
}

/**
 * Endpoint entity rows of this relation/item row that are rejected or still
 * pending — the row cannot be sent until each is accepted or linked.
 */
export function blockingEndpoints(
  item: ProposalItem,
  items: readonly ProposalItem[],
): BlockingEndpoint[] {
  const blocking: BlockingEndpoint[] = [];
  for (const field of endpointFields(item)) {
    const endpoint = readEndpoint(item, field);
    if (!endpoint || !('ref' in endpoint)) continue;
    const row = entityRowForRef(items, endpoint.ref);
    if (!row || isChecked(row.decision)) continue;
    blocking.push({ field, ref: endpoint.ref, label: row.display.title, itemId: row.id });
  }
  return blocking;
}

/** "2 sensitive facts need to be accepted one by one" — or null when nothing was skipped. */
export function describeSkipped(skipped: BulkDecideResult['skipped']): string | null {
  const sensitive = skipped.filter((s) => s.reason === 'sensitive_requires_individual_accept').length;
  const closings = skipped.filter((s) => s.reason === 'closing_requires_individual_accept').length;
  const missing = skipped.filter((s) => s.reason === 'not_found').length;
  const parts: string[] = [];
  if (sensitive > 0) {
    parts.push(
      `${sensitive} sensitive ${sensitive === 1 ? 'fact needs' : 'facts need'} to be accepted one by one`,
    );
  }
  if (closings > 0) {
    parts.push(
      `${closings} ${closings === 1 ? 'closing needs' : 'closings need'} to be accepted one by one`,
    );
  }
  if (missing > 0) parts.push(`${missing} ${missing === 1 ? 'row was' : 'rows were'} no longer there`);
  return parts.length > 0 ? parts.join('; ') : null;
}
