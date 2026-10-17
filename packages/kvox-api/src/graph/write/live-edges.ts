// =============================================================================
// The live edges #353's planner reads (#365, moved here for #586)
// =============================================================================
//
// One owner's live (`accepted`/`edited`) relations of one type from one entity,
// as `TemporalEdge`s. The proposal stages (`ItemCandidateService.liveEdges`)
// and the manual relation edit read them through this one query, so both feed
// `planTemporalInsert` the same edge set. For a symmetric type (#383) it also
// returns the edges that END at the entity: the planner reads `(b, a)` as
// `(a, b)` under a symmetric rule.
// =============================================================================

import { fromPgRange, type TemporalEdge, type TemporalReviewStatus, type ValidPrecision } from '../temporal/index.js';
import type { KvoxGraphTx } from '../data/graph-db.js';

/**
 * Live edges of one type from one entity, oldest id first. Runs on whatever
 * client it is given — a transaction, so a write sees its own snapshot.
 *
 * @stability experimental
 */
export async function loadLiveTemporalEdges(
  db: Pick<KvoxGraphTx, '$queryRaw'>,
  ownerId: string,
  type: string,
  fromId: string,
  symmetric = false,
): Promise<TemporalEdge[]> {
  const rows = await db.$queryRaw<
    Array<{
      id: string;
      type: string;
      from_id: string;
      to_id: string;
      props: unknown;
      valid: string | null;
      valid_precision: string | null;
      review_status: string;
    }>
  >`
    SELECT r.id::text AS id, r.type, r.from_id::text AS from_id, r.to_id::text AS to_id, r.props,
           r.valid::text AS valid, r.valid_precision::text AS valid_precision,
           r.review_status::text AS review_status
      FROM kg_relations r
     WHERE r.owner_id = ${ownerId}::uuid
       AND r.type = ${type}
       AND (r.from_id = ${fromId}::uuid OR (${symmetric}::boolean AND r.to_id = ${fromId}::uuid))
       AND r.review_status IN ('accepted', 'edited')
     ORDER BY r.id`;
  return rows.map((r) => {
    let valid: TemporalEdge['valid'] = null;
    if (r.valid !== null && !/^empty$/i.test(r.valid)) {
      try {
        valid = fromPgRange(r.valid);
      } catch {
        valid = null;
      }
    }
    return {
      id: r.id,
      type: r.type,
      fromId: r.from_id,
      toId: r.to_id,
      props: (r.props ?? {}) as Record<string, unknown>,
      valid,
      precision: (r.valid_precision as ValidPrecision | null) ?? null,
      reviewStatus: r.review_status as TemporalReviewStatus,
    };
  });
}
