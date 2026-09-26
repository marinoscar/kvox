// =============================================================================
// The commit contract for #365's rows (issue #365 defines it, #366 applies it)
// =============================================================================
//
// PURE. What `POST /api/graph/proposals/:id/commit` does with a row that
// `work-item-dedup` / `temporal-closing` / `rejection-memory` shaped, as code
// rather than prose, so #366's transaction and #365's tests read one table:
//
//   item  dedup `known`       append evidence to `targetItemId`; nothing else
//   item  dedup `same`        append evidence to `targetItemId`; a commitment
//                             also applies `changes` (status/dueAt), recording
//                             the `before` values in the commit log
//   item  dedup `supersedes`  insert the new item; target `superseded_by_id =
//                             new.id`, `review_status = 'superseded'`, and
//                             `status = 'superseded'` for a commitment
//   item  dedup `new` / none  insert
//   relation dedup `known`    append evidence to `targetRelationId`
//   relation otherwise        insert, with `valid = proposedRelationRange()` —
//                             closed at `dedup.candidateTo` when set (#353 rule 5)
//   closing                   target `valid = [lower(valid), closeAt)` and
//                             `superseded_by_id` = the committed id of
//                             `closedByRef`; SKIPPED (stats.closingsSkipped)
//                             when that row is rejected / not committed
//   any row decided `reject`  nothing in the graph (the row keeps `reject` —
//                             that is the rejection memory)
// =============================================================================

import type { ClosingPayload, ItemPayload, RelationPayload } from '../proposals/proposal-payload.schema';
import { fromPgRange, rangeFromPrecision, toPgRange, type ValidPrecision, type ValidRange } from '../temporal';
import { proposedRelationRange } from './dedup-core';

export type ItemCommitAction =
  | { action: 'insert' }
  | { action: 'attach_evidence'; targetItemId: string }
  | {
      action: 'attach_and_update';
      targetItemId: string;
      /** Only ever non-empty for a commitment. */
      changes: { status?: 'open' | 'done' | 'dropped'; dueAt?: string | null };
    }
  | { action: 'insert_and_supersede'; targetItemId: string };

export function itemCommitAction(payload: Pick<ItemPayload, 'kind' | 'dedup'>): ItemCommitAction {
  const d = payload.dedup;
  if (!d || !d.targetItemId) return { action: 'insert' };
  switch (d.verdict) {
    case 'known':
      return { action: 'attach_evidence', targetItemId: d.targetItemId };
    case 'same': {
      const changes = payload.kind === 'commitment' ? d.changes : {};
      return Object.keys(changes).length > 0
        ? { action: 'attach_and_update', targetItemId: d.targetItemId, changes }
        : { action: 'attach_evidence', targetItemId: d.targetItemId };
    }
    case 'supersedes':
      return { action: 'insert_and_supersede', targetItemId: d.targetItemId };
    default:
      return { action: 'insert' };
  }
}

export type RelationCommitAction =
  | { action: 'insert'; valid: ValidRange | null; precision: ValidPrecision }
  | { action: 'attach_evidence'; targetRelationId: string };

/**
 * The relation half of the table. `temporal` is the relation type's own flag in
 * the effective schema (a non-temporal type never carries a range).
 */
export function relationCommitAction(payload: RelationPayload, temporal: boolean): RelationCommitAction {
  const d = payload.dedup;
  if (d?.verdict === 'known' && d.targetRelationId) {
    return { action: 'attach_evidence', targetRelationId: d.targetRelationId };
  }
  if (!temporal) return { action: 'insert', valid: null, precision: 'unknown' };
  const { range, precision } = proposedRelationRange(payload, 'state');
  if (range && d?.candidateTo) {
    const to = new Date(`${d.candidateTo}T00:00:00.000Z`);
    if (range.from === null || range.from.getTime() < to.getTime()) {
      return { action: 'insert', valid: { from: range.from, to }, precision };
    }
  }
  return { action: 'insert', valid: range, precision };
}

/**
 * The target edge's new range once a `closing` row is accepted: its own lower
 * bound (and precision) kept, the upper bound set to `closeAt`. `current` is
 * the edge's `valid` as Postgres prints it (`valid::text`); returns the
 * `tstzrange` literal to write. Throws (#353's `TemporalInputError`) when
 * `closeAt` is not after the edge's start — an edge a reviewer re-dated since
 * the proposal was built; #366 skips such a closing rather than write an
 * empty range.
 */
export function closedRangeLiteral(current: string, closing: Pick<ClosingPayload, 'closeAt'>): string {
  const range = fromPgRange(current);
  const closeAt = rangeFromPrecision(closing.closeAt, null, 'day').range!.from!;
  return toPgRange({ from: range.from, to: closeAt });
}
