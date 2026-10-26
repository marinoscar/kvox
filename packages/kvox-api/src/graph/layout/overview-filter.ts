// =============================================================================
// Overview filters (#768): the time window and the per-type counts
// =============================================================================
//
// WHICH SIGNAL. An entity is "in the window" when it has evidence dated in it:
// the same `kg_evidence` date rule `GET /api/graph/activity` uses (a live
// transcript's `recorded_at`, else a live note's `created_at`, else the
// citation's own `created_at`). Evidence on a relation counts for both ends and
// evidence on an item for its subject entity. It is the cheapest correct signal:
// one indexed scan of the owner's evidence, no per-entity joins, and it matches
// what the explorer's TimeBar shows, so a bar and the graph never disagree.
//
// Read-only SQL, owner-scoped, readable entities only. Nothing here is a label.
// =============================================================================

import { Prisma } from '../../core/index.js';
import { readableEntitySql, readableRelationSql, uuidArray } from '../read/read-sql.js';
import { relationValidAtSql } from '../read/as-of.js';
import type { KvoxGraphDb } from '../data/graph-db.js';

/** A parsed `from`/`to` window; `null` ends are open. */
export interface OverviewWindow {
  from: Date | null;
  to: Date | null;
}

/** Whether any end of the window is set. */
export function isWindowed(w: OverviewWindow): boolean {
  return w.from !== null || w.to !== null;
}

/** The CTE chain ending in `active(eid)`: the owner's entity ids with evidence in the window. */
function activeEntitiesCte(ownerId: string, w: OverviewWindow) {
  const owner = Prisma.sql`${ownerId}::uuid`;
  return Prisma.sql`
    ev_at AS (
      SELECT ev.subject_kind::text AS kind, ev.subject_id AS sid,
             coalesce(CASE WHEN t.deleted_at IS NULL THEN t.recorded_at END,
                      CASE WHEN n.deleted_at IS NULL THEN n.created_at END, ev.created_at) AS at
        FROM kg_evidence ev
        LEFT JOIN transcripts t ON t.id = ev.transcript_id
        LEFT JOIN notes n ON n.id = ev.note_id
       WHERE ev.owner_id = ${owner}
    ),
    win AS (
      SELECT kind, sid FROM ev_at
       WHERE (${w.from}::timestamptz IS NULL OR at >= ${w.from}::timestamptz)
         AND (${w.to}::timestamptz IS NULL OR at < ${w.to}::timestamptz)
    ),
    active AS (
      SELECT sid AS eid FROM win WHERE kind = 'entity'
      UNION
      SELECT i.subject_id FROM win JOIN kg_items i ON i.id = win.sid AND i.owner_id = ${owner}
       WHERE win.kind = 'item' AND i.subject_id IS NOT NULL
      UNION
      SELECT ends.eid FROM win JOIN kg_relations r ON r.id = win.sid AND r.owner_id = ${owner}
       CROSS JOIN LATERAL (VALUES (r.from_id), (r.to_id)) AS ends(eid)
       WHERE win.kind = 'relation' AND ends.eid IS NOT NULL
    )`;
}

/** Of `ids`, those with evidence in the window. */
export async function readEntityIdsInWindow(
  db: KvoxGraphDb,
  ownerId: string,
  w: OverviewWindow,
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    WITH ${activeEntitiesCte(ownerId, w)}
    SELECT a.eid::text AS id FROM active a WHERE a.eid = ANY(${ids}::uuid[])`;
  return new Set(rows.map((r) => r.id));
}

/** Live readable entities per type; restricted to the window when one is set. One GROUP BY. */
export async function readTypeCounts(db: KvoxGraphDb, ownerId: string, w: OverviewWindow): Promise<Record<string, number>> {
  const owner = Prisma.sql`${ownerId}::uuid`;
  const rows = isWindowed(w)
    ? await db.$queryRaw<Array<{ type: string; n: number }>>`
        WITH ${activeEntitiesCte(ownerId, w)}
        SELECT e.type, count(*)::int AS n
          FROM kg_entities e
         WHERE e.owner_id = ${owner} AND ${readableEntitySql('e')}
           AND e.id IN (SELECT eid FROM active)
         GROUP BY e.type`
    : await db.$queryRaw<Array<{ type: string; n: number }>>`
        SELECT e.type, count(*)::int AS n
          FROM kg_entities e
         WHERE e.owner_id = ${owner} AND ${readableEntitySql('e')}
         GROUP BY e.type`;
  return Object.fromEntries(rows.map((r) => [r.type, r.n]));
}

export interface OverviewEdgeRow {
  id: string;
  source: string;
  target: string;
  type: string;
}

/**
 * Live relations valid at `now` with BOTH ends in `ids`, strongest first (confidence, then newest), at most
 * `limit`; `truncated` says more matched. Item-derived layout edges are not returned: they have no relation
 * id or type, and the explorer expands items through `explore/expand`.
 */
export async function readOverviewEdges(
  db: KvoxGraphDb,
  ownerId: string,
  ids: string[],
  now: Date,
  limit: number,
): Promise<{ edges: OverviewEdgeRow[]; truncated: boolean }> {
  if (ids.length === 0) return { edges: [], truncated: false };
  const owner = Prisma.sql`${ownerId}::uuid`;
  const arr = uuidArray(ids);
  const rows = await db.$queryRaw<OverviewEdgeRow[]>`
    SELECT r.id::text AS id, r.from_id::text AS source, r.to_id::text AS target, r.type
      FROM kg_relations r
     WHERE r.owner_id = ${owner} AND ${readableRelationSql('r')}
       AND r.from_id = ANY(${arr}) AND r.to_id = ANY(${arr})
       AND ${relationValidAtSql('r', now)}
     ORDER BY r.confidence DESC NULLS LAST, r.created_at DESC, r.id
     LIMIT ${limit + 1}`;
  return { edges: rows.slice(0, limit), truncated: rows.length > limit };
}
