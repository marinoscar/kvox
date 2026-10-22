// =============================================================================
// GraphActivityService (GIC-15, #676; docs/specs/ontology.md §12)
// =============================================================================
//
// "When did this happen?" — evidence counts per week or month for a set of
// entities and the relations among them, stacked by entity type, for the
// explorer's TimeBar.
//
// WHAT IS COUNTED. One unit per (evidence row, entity) pair:
//
//   - a citation of an entity counts once for that entity;
//   - a citation of a relation whose BOTH ends are in `ids` counts once for each
//     end (the relation is activity of both entities).
//
// `byType[T]` sums those units over the entities of type T (an item counts as
// its kind) and `total` is the sum of `byType`, so a stacked bar always adds up.
//
// WHEN. A transcript's `recorded_at` or a note's `created_at` (the meeting
// date), falling back to the citation's own `created_at` when the source is
// gone or soft-deleted. The note has no separate occurred-at column.
//
// WHAT IS READABLE. Entities pass `readableEntitySql`, relations
// `readableRelationSql`, items `readableItemSql` + `notSensitiveSql`: a
// `sensitive` person fact contributes nothing. Every id must be a readable node
// of the caller or the whole request is the shared 404 (never 403).
//
// Bounded: one aggregate statement inside `withGraphStatementTimeout` (3 s,
// 503 `graph_query_timeout`), driven by the `(subject_kind, subject_id)` index.
// =============================================================================

import { Inject, Injectable, Logger } from '@nestjs/common';

import { Prisma } from '../../core/index.js';
import { KVOX_PRISMA } from '../../ports/index.js';
import type { KvoxGraphDb } from '../data/graph-db.js';
import type { GraphActivityQuery, GraphActivityResponse } from './dto/graph-read.dto.js';
import { GraphNeighborhoodService } from './graph-neighborhood.service.js';
import { withGraphStatementTimeout } from './graph-query-timeout.js';
import { asOfOr400 } from './read-params.js';
import { notSensitiveSql, readableEntitySql, readableItemSql, readableRelationSql, uuidArray } from './read-sql.js';

interface ActivityRow {
  start: string;
  entity_id: string;
  etype: string;
  n: number;
}

/** Test and tuning hooks; the HTTP route never sets them. */
export interface GraphActivityOptions {
  /** Overrides the 3 s statement budget. */
  timeoutMs?: number;
}

/**
 * GraphActivityService: wiring the slice registers itself; a host configures it through the slice module's `forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class GraphActivityService {
  private readonly logger = new Logger(GraphActivityService.name);

  constructor(
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxGraphDb,
    private readonly neighborhood: GraphNeighborhoodService,
  ) {}

  /** Evidence counts per bucket for `query.ids`; any unreadable id is the shared 404. */
  async activity(
    user: { id: string },
    query: GraphActivityQuery,
    options: GraphActivityOptions = {},
  ): Promise<GraphActivityResponse> {
    const ownerId = user.id;
    const ids = [...new Set(query.ids)];
    await this.neighborhood.assertReadableNodes(ownerId, ids);
    const from = query.from ? asOfOr400(query.from) : null;
    const to = query.to ? asOfOr400(query.to) : null;
    // The unit is a SQL literal chosen from a closed enum, never request text.
    const unit = Prisma.raw(query.bucket === 'week' ? `'week'` : `'month'`);
    const owner = Prisma.sql`${ownerId}::uuid`;
    const idArr = uuidArray(ids);

    const rows = await withGraphStatementTimeout(
      this.prisma,
      this.logger,
      { ownerId, ids: ids.length, bucket: query.bucket },
      (tx) => tx.$queryRaw<ActivityRow[]>`
        WITH units AS (
          SELECT ev.id, e.id AS entity_id, e.type AS etype,
                 coalesce(CASE WHEN t.deleted_at IS NULL THEN t.recorded_at END,
                          CASE WHEN n.deleted_at IS NULL THEN n.created_at END, ev.created_at) AS at
            FROM kg_evidence ev
            JOIN kg_entities e ON e.id = ev.subject_id AND e.owner_id = ${owner} AND ${readableEntitySql('e')}
            LEFT JOIN transcripts t ON t.id = ev.transcript_id
            LEFT JOIN notes n ON n.id = ev.note_id
           WHERE ev.owner_id = ${owner} AND ev.subject_kind = 'entity'::kg_evidence_subject_kind
             AND ev.subject_id = ANY(${idArr})
          UNION ALL
          SELECT ev.id, i.id, i.kind::text,
                 coalesce(CASE WHEN t.deleted_at IS NULL THEN t.recorded_at END,
                          CASE WHEN n.deleted_at IS NULL THEN n.created_at END, ev.created_at)
            FROM kg_evidence ev
            JOIN kg_items i ON i.id = ev.subject_id AND i.owner_id = ${owner}
                 AND ${readableItemSql('i')} AND ${notSensitiveSql('i')}
            LEFT JOIN transcripts t ON t.id = ev.transcript_id
            LEFT JOIN notes n ON n.id = ev.note_id
           WHERE ev.owner_id = ${owner} AND ev.subject_kind = 'item'::kg_evidence_subject_kind
             AND ev.subject_id = ANY(${idArr})
          UNION ALL
          SELECT ev.id, e.id, e.type,
                 coalesce(CASE WHEN t.deleted_at IS NULL THEN t.recorded_at END,
                          CASE WHEN n.deleted_at IS NULL THEN n.created_at END, ev.created_at)
            FROM kg_evidence ev
            JOIN kg_relations r ON r.id = ev.subject_id AND r.owner_id = ${owner} AND ${readableRelationSql('r')}
                 AND r.from_id = ANY(${idArr}) AND r.to_id = ANY(${idArr})
            CROSS JOIN LATERAL (VALUES (r.from_id), (r.to_id)) AS ends(entity_id)
            JOIN kg_entities e ON e.id = ends.entity_id AND e.owner_id = ${owner} AND ${readableEntitySql('e')}
            LEFT JOIN transcripts t ON t.id = ev.transcript_id
            LEFT JOIN notes n ON n.id = ev.note_id
           WHERE ev.owner_id = ${owner} AND ev.subject_kind = 'relation'::kg_evidence_subject_kind
        )
        SELECT to_char(date_trunc(${unit}, u.at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS start,
               u.entity_id::text AS entity_id, u.etype, count(*)::int AS n
          FROM units u
         WHERE (${from}::timestamptz IS NULL OR u.at >= ${from}::timestamptz)
           AND (${to}::timestamptz IS NULL OR u.at < ${to}::timestamptz)
         GROUP BY 1, 2, 3
         ORDER BY 1, 2`,
      options.timeoutMs,
    );

    return shapeActivity(query.bucket, rows);
  }
}

/** Folds `(bucket, entity, type, n)` rows into the wire shape; pure. */
export function shapeActivity(bucket: GraphActivityResponse['bucket'], rows: readonly ActivityRow[]): GraphActivityResponse {
  const series = new Map<string, { start: string; total: number; byType: Record<string, number> }>();
  const byEntity: GraphActivityResponse['byEntity'] = {};
  for (const r of rows) {
    const b = series.get(r.start) ?? { start: r.start, total: 0, byType: {} };
    b.total += r.n;
    b.byType[r.etype] = (b.byType[r.etype] ?? 0) + r.n;
    series.set(r.start, b);
    (byEntity[r.entity_id] ??= []).push({ start: r.start, count: r.n });
  }
  return {
    bucket,
    series: [...series.values()].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)),
    byEntity,
  };
}
