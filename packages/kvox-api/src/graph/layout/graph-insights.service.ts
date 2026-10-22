// =============================================================================
// GraphInsightsService (GIC-16, #677, epic #661; docs/specs/ontology.md §22.3)
// =============================================================================
//
// `GET /api/graph/insights?window=30d|90d|365d` — READ ONLY, owner-scoped.
//
//   Snapshot-backed (no recompute, no enqueue; `stale`/`pending` as the overview):
//     themes      the snapshot's clusters (not the "Unconnected" pool), labels live
//     connectors  the snapshot's betweenness top list, labels live, a sentence each
//
//   Window queries (one transaction, the shared 3 s budget -> 503 `graph_query_timeout`):
//     rising      entities mentioned in >= 3 notes/recordings in the window AND at least
//                 2x as many as in the window just before (a prior count of 0 qualifies).
//                 `Meeting` is left out: every meeting is "new" by construction.
//     fadingTies  pairs of People/Organizations joined by a readable, currently valid
//                 relation that had >= 3 evidence rows before the window and none in it.
//     openRisks   Risk items with status `open`, highest severity first (the work
//                 domain off -> none).
//
// WHEN: a transcript's `recorded_at` or a note's `created_at` (the meeting date),
// falling back to the row's own `created_at`; soft-deleted sources count for nothing.
// Windows end at `now`: [now - days, now) is "the window", [now - 2*days, now - days)
// "the window before".
//
// PRIVACY: labels are always read live (a forgotten entity drops out of every list);
// readable statuses only; `sensitive` person facts are excluded wherever items are read;
// no quote or evidence text is returned.
// =============================================================================

import { Inject, Injectable, Logger } from '@nestjs/common';

import { Prisma } from '../../core/index.js';
import { KVOX_PRISMA } from '../../ports/index.js';
import type { KvoxGraphDb } from '../data/graph-db.js';
import { GraphOntologyService } from '../ontology/graph-ontology.service.js';
import { relationValidAtSql } from '../read/as-of.js';
import { withGraphStatementTimeout } from '../read/graph-query-timeout.js';
import { READABLE_ENTITY_STATUSES } from '../read/readable.js';
import { notSensitiveSql, readableEntitySql, readableItemSql, readableMentionSql, readableRelationSql } from '../read/read-sql.js';
import {
  INSIGHTS_FADING_MIN_EVIDENCE,
  INSIGHTS_RISING_FACTOR,
  INSIGHTS_RISING_MIN_COUNT,
  type GraphInsightsResponse,
  type GraphInsightsWindow,
} from './dto/graph-insights.dto.js';
import { GraphLayoutEnqueuer } from './graph-layout.enqueuer.js';
import { fallbackClusterLabel } from './graph-overview.service.js';
import { storedClustersSchema, storedPositionsSchema } from './layout-snapshot.js';
import { readSourceUpdatedAt } from './layout-source.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;
const WINDOW_DAYS: Record<GraphInsightsWindow, number> = { '30d': 30, '90d': 90, '365d': 365 };

/** Items per list. */
export const INSIGHTS_THEMES_MAX = 8;
export const INSIGHTS_CONNECTORS_MAX = 8;
export const INSIGHTS_LIST_MAX = 10;

/** Entity types whose silence is worth a nudge, and the type rising leaves out. */
const FADING_TYPES = ['Person', 'Organization'] as const;
const RISING_EXCLUDED_TYPE = 'Meeting';

/** Test and tuning hooks; the HTTP route never sets them. */
export interface GraphInsightsOptions {
  /** The instant windows end at. Default: the clock. */
  now?: Date;
  /** Overrides the 3 s statement budget. */
  timeoutMs?: number;
}

interface LiveEntity {
  id: string;
  label: string;
  type: string;
}

interface RisingRow {
  id: string;
  label: string;
  type: string;
  cur: number;
  prev: number;
}

interface FadingRow {
  a_id: string;
  a_label: string;
  a_type: string;
  b_id: string;
  b_label: string;
  b_type: string;
  relation_types: string[];
  before_count: number;
  last_at: Date;
}

interface RiskRow {
  id: string;
  title: string | null;
  statement: string;
  severity: string | null;
  occurred_at: Date | null;
  subject_id: string | null;
  subject_label: string | null;
  subject_type: string | null;
  subject_ok: boolean | null;
}

/**
 * GraphInsightsService: wiring the slice registers itself; a host configures it through the slice module's `forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class GraphInsightsService {
  private readonly logger = new Logger(GraphInsightsService.name);

  constructor(
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxGraphDb,
    private readonly enqueuer: GraphLayoutEnqueuer,
    private readonly ontology: GraphOntologyService,
  ) {}

  async insights(
    ownerId: string,
    window: GraphInsightsWindow,
    options: GraphInsightsOptions = {},
  ): Promise<GraphInsightsResponse> {
    const now = options.now ?? new Date();
    const days = WINDOW_DAYS[window];
    const from = new Date(now.getTime() - days * DAY_MS);
    const previousFrom = new Date(now.getTime() - 2 * days * DAY_MS);

    const [snapshot, windowed, riskEnabled] = await Promise.all([
      this.snapshotParts(ownerId),
      this.windowParts(ownerId, now, from, previousFrom, options.timeoutMs),
      this.riskEnabled(ownerId),
    ]);
    const openRisks = riskEnabled ? await this.openRisks(ownerId, options.timeoutMs) : [];

    return {
      window: { key: window, days, from: from.toISOString(), previousFrom: previousFrom.toISOString() },
      ...snapshot,
      rising: windowed.rising.map((r) => ({
        entity: { id: r.id, label: r.label, type: r.type },
        count: r.cur,
        previous: r.prev,
        reason: risingReason(r.cur, r.prev, days),
      })),
      fadingTies: windowed.fading.map((f) => ({
        from: { id: f.a_id, label: f.a_label, type: f.a_type },
        to: { id: f.b_id, label: f.b_label, type: f.b_type },
        relationTypes: f.relation_types,
        lastEvidenceAt: f.last_at.toISOString(),
        evidenceBefore: f.before_count,
        reason: `You haven't discussed ${f.a_label} with ${f.b_label} since ${formatDay(f.last_at)}.`,
      })),
      openRisks,
    };
  }

  // --- Snapshot-backed: themes and connectors ---------------------------------

  private async snapshotParts(
    ownerId: string,
  ): Promise<Pick<GraphInsightsResponse, 'status' | 'pending' | 'computedAt' | 'stale' | 'tooLarge' | 'connectorsReady' | 'themes' | 'connectors'>> {
    const [latest, active] = await Promise.all([
      this.prisma.kgGraphLayout.findFirst({ where: { ownerId }, orderBy: [{ computedAt: 'desc' }, { id: 'desc' }] }),
      this.enqueuer.findActive(ownerId),
    ]);
    const clusters = latest ? storedClustersSchema.safeParse(latest.clusters) : null;
    const positions = latest ? storedPositionsSchema.safeParse(latest.positions) : null;
    const none = {
      status: 'none' as const,
      pending: active !== null,
      computedAt: null,
      stale: false,
      tooLarge: false,
      connectorsReady: false,
      themes: [],
      connectors: [],
    };
    if (!latest || !clusters?.success || !positions?.success) return none;

    const current = await readSourceUpdatedAt(this.prisma, ownerId);
    const stale =
      current !== null && (latest.sourceUpdatedAt === null || current.getTime() > latest.sourceUpdatedAt.getTime());

    const snap = clusters.data;
    const degreeOf = new Map<string, number>(positions.data.nodes.map((n) => [n[0], n[5]]));
    const themeRows = snap.items.filter((c) => c.id >= 0).slice(0, INSIGHTS_THEMES_MAX);
    const connectorRows = (snap.connectors ?? []).slice(0, INSIGHTS_CONNECTORS_MAX * 2);

    const wanted = new Set<string>();
    for (const c of snap.items) if (c.labelEntityId) wanted.add(c.labelEntityId);
    for (const c of themeRows) c.sampleIds.forEach((id) => wanted.add(id));
    for (const c of connectorRows) wanted.add(c.id);
    const live = await this.readLive(ownerId, [...wanted]);

    const clusterLabel = new Map<number, string>(
      snap.items.map((c) => [c.id, (c.labelEntityId ? live.get(c.labelEntityId)?.label : undefined) ?? fallbackClusterLabel(c.id)]),
    );

    const themes = themeRows.map((c) => {
      const labelEntity = c.labelEntityId ? live.get(c.labelEntityId) : undefined;
      return {
        clusterId: c.id,
        label: clusterLabel.get(c.id) as string,
        labelEntityId: labelEntity ? labelEntity.id : null,
        size: c.size,
        typeCounts: c.typeCounts,
        memberSample: c.sampleIds
          .filter((id) => live.has(id))
          .slice(0, 8)
          .map((id) => {
            const e = live.get(id) as LiveEntity;
            return { id, label: e.label, type: e.type, degree: degreeOf.get(id) ?? 0 };
          }),
      };
    });

    const connectors = connectorRows
      .filter((c) => live.has(c.id))
      .slice(0, INSIGHTS_CONNECTORS_MAX)
      .map((c) => {
        const e = live.get(c.id) as LiveEntity;
        const groups = c.clusterIds.filter((id) => clusterLabel.has(id)).map((id) => ({ id, label: clusterLabel.get(id) as string }));
        return { entity: { id: e.id, label: e.label, type: e.type }, score: c.score, clusters: groups, reason: connectorReason(e.label, groups.map((g) => g.label)) };
      });

    return {
      status: 'ready',
      pending: active !== null,
      computedAt: latest.computedAt.toISOString(),
      stale,
      tooLarge: snap.tooLarge,
      connectorsReady: snap.connectors !== undefined,
      themes,
      connectors,
    };
  }

  // --- Window queries: rising and fading ties ------------------------------------

  private async windowParts(
    ownerId: string,
    now: Date,
    from: Date,
    previousFrom: Date,
    timeoutMs?: number,
  ): Promise<{ rising: RisingRow[]; fading: FadingRow[] }> {
    const owner = Prisma.sql`${ownerId}::uuid`;
    const nowTs = Prisma.sql`${now}::timestamptz`;
    const fromTs = Prisma.sql`${from}::timestamptz`;
    const prevTs = Prisma.sql`${previousFrom}::timestamptz`;
    const fadingTypes = [...FADING_TYPES] as string[];

    return withGraphStatementTimeout(
      this.prisma,
      this.logger,
      { ownerId, insights: 'window' },
      async (tx) => {
        const rising = await tx.$queryRaw<RisingRow[]>`
          WITH docs AS (
            SELECT m.entity_id,
                   coalesce(m.note_id, m.transcript_id) AS doc,
                   coalesce(CASE WHEN t.deleted_at IS NULL THEN t.recorded_at END,
                            CASE WHEN n.deleted_at IS NULL THEN n.created_at END, m.created_at) AS at
              FROM kg_mentions m
              LEFT JOIN transcripts t ON t.id = m.transcript_id
              LEFT JOIN notes n ON n.id = m.note_id
             WHERE m.owner_id = ${owner}
               AND ${readableMentionSql('m')}
               AND (m.transcript_id IS NULL OR t.deleted_at IS NULL)
               AND (m.note_id IS NULL OR n.deleted_at IS NULL)
          )
          SELECT e.id::text AS id, e.label, e.type,
                 count(DISTINCT d.doc) FILTER (WHERE d.at >= ${fromTs} AND d.at < ${nowTs})::int AS cur,
                 count(DISTINCT d.doc) FILTER (WHERE d.at >= ${prevTs} AND d.at < ${fromTs})::int AS prev
            FROM docs d
            JOIN kg_entities e ON e.id = d.entity_id AND e.owner_id = ${owner} AND ${readableEntitySql('e')}
           WHERE d.at >= ${prevTs} AND d.at < ${nowTs} AND e.type <> ${RISING_EXCLUDED_TYPE}
           GROUP BY e.id, e.label, e.type
          HAVING count(DISTINCT d.doc) FILTER (WHERE d.at >= ${fromTs} AND d.at < ${nowTs}) >= ${INSIGHTS_RISING_MIN_COUNT}
             AND count(DISTINCT d.doc) FILTER (WHERE d.at >= ${fromTs} AND d.at < ${nowTs})
                 >= ${INSIGHTS_RISING_FACTOR} * count(DISTINCT d.doc) FILTER (WHERE d.at >= ${prevTs} AND d.at < ${fromTs})
           ORDER BY cur DESC, (count(DISTINCT d.doc) FILTER (WHERE d.at >= ${fromTs} AND d.at < ${nowTs})
                               - count(DISTINCT d.doc) FILTER (WHERE d.at >= ${prevTs} AND d.at < ${fromTs})) DESC, e.id
           LIMIT ${INSIGHTS_LIST_MAX}`;

        const fading = await tx.$queryRaw<FadingRow[]>`
          WITH units AS (
            SELECT least(r.from_id, r.to_id) AS lo, greatest(r.from_id, r.to_id) AS hi, r.type AS rtype, ev.id AS ev_id,
                   coalesce(CASE WHEN t.deleted_at IS NULL THEN t.recorded_at END,
                            CASE WHEN n.deleted_at IS NULL THEN n.created_at END, ev.created_at) AS at
              FROM kg_relations r
              JOIN kg_evidence ev ON ev.subject_id = r.id AND ev.owner_id = ${owner}
                   AND ev.subject_kind = 'relation'::kg_evidence_subject_kind
              LEFT JOIN transcripts t ON t.id = ev.transcript_id
              LEFT JOIN notes n ON n.id = ev.note_id
             WHERE r.owner_id = ${owner} AND r.from_id IS NOT NULL AND r.from_id <> r.to_id
               AND ${readableRelationSql('r')} AND ${relationValidAtSql('r', now)}
          ), pairs AS (
            SELECT lo, hi, array_agg(DISTINCT rtype ORDER BY rtype) AS relation_types,
                   count(DISTINCT ev_id) FILTER (WHERE at < ${fromTs})::int AS before_count,
                   count(DISTINCT ev_id) FILTER (WHERE at >= ${fromTs})::int AS in_window,
                   max(at) AS last_at
              FROM units GROUP BY lo, hi
          )
          SELECT a.id::text AS a_id, a.label AS a_label, a.type AS a_type,
                 b.id::text AS b_id, b.label AS b_label, b.type AS b_type,
                 p.relation_types, p.before_count, p.last_at
            FROM pairs p
            JOIN kg_entities a ON a.id = p.lo AND a.owner_id = ${owner} AND ${readableEntitySql('a')} AND a.type = ANY(${fadingTypes}::text[])
            JOIN kg_entities b ON b.id = p.hi AND b.owner_id = ${owner} AND ${readableEntitySql('b')} AND b.type = ANY(${fadingTypes}::text[])
           WHERE p.before_count >= ${INSIGHTS_FADING_MIN_EVIDENCE} AND p.in_window = 0
           ORDER BY p.last_at DESC, p.lo, p.hi
           LIMIT ${INSIGHTS_LIST_MAX}`;

        return { rising, fading };
      },
      timeoutMs,
    );
  }

  // --- Open risks ----------------------------------------------------------------

  private async riskEnabled(ownerId: string): Promise<boolean> {
    const schema = await this.ontology.effectiveSchemaFor(ownerId);
    return schema.entityType('Risk') !== undefined;
  }

  private async openRisks(ownerId: string, timeoutMs?: number): Promise<GraphInsightsResponse['openRisks']> {
    const rows = await withGraphStatementTimeout(
      this.prisma,
      this.logger,
      { ownerId, insights: 'risks' },
      (tx) => tx.$queryRaw<RiskRow[]>`
        SELECT i.id::text AS id, i.title, i.statement, i.props->>'severity' AS severity, i.occurred_at,
               s.id::text AS subject_id, s.label AS subject_label, s.type AS subject_type,
               (s.review_status IN ('accepted','edited') AND s.merged_into_id IS NULL) AS subject_ok
          FROM kg_items i
          LEFT JOIN kg_entities s ON s.id = i.subject_id AND s.owner_id = i.owner_id
         WHERE i.owner_id = ${ownerId}::uuid AND i.kind = 'risk' AND i.status = 'open'
           AND ${readableItemSql('i')} AND ${notSensitiveSql('i')}
         ORDER BY CASE i.props->>'severity' WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END DESC,
                  i.occurred_at DESC NULLS LAST, i.id ASC
         LIMIT ${INSIGHTS_LIST_MAX}`,
      timeoutMs,
    );
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      statement: r.statement,
      severity: r.severity === 'low' || r.severity === 'medium' || r.severity === 'high' ? r.severity : null,
      subject:
        r.subject_ok && r.subject_id && r.subject_label !== null && r.subject_type !== null
          ? { id: r.subject_id, label: r.subject_label, type: r.subject_type }
          : null,
      occurredAt: r.occurred_at ? r.occurred_at.toISOString() : null,
    }));
  }

  /** The still-readable, non-merged entities among `ids`, owner-scoped. One statement. */
  private async readLive(ownerId: string, ids: string[]): Promise<Map<string, LiveEntity>> {
    const valid = ids.filter((id) => UUID.test(id));
    if (valid.length === 0) return new Map();
    const statuses = [...READABLE_ENTITY_STATUSES] as string[];
    const rows = await this.prisma.$queryRaw<LiveEntity[]>`
      SELECT e.id::text AS id, e.label, e.type
        FROM kg_entities e
       WHERE e.owner_id = ${ownerId}::uuid
         AND e.id = ANY(${valid}::uuid[])
         AND e.review_status::text = ANY(${statuses}::text[])
         AND e.merged_into_id IS NULL`;
    return new Map(rows.map((r) => [r.id, r]));
  }
}

/** "Joe connects the Copilot group and the Finance group." */
export function connectorReason(label: string, groups: string[]): string {
  if (groups.length >= 3) {
    return `${label} connects the ${groups[0]} group, the ${groups[1]} group and ${groups.length - 2} more.`;
  }
  if (groups.length === 2) return `${label} connects the ${groups[0]} group and the ${groups[1]} group.`;
  return `${label} links many of the people and topics around them.`;
}

/** "Came up in 7 conversations in the last 30 days, up from 2 before." */
export function risingReason(count: number, previous: number, days: number): string {
  const what = `${count} ${count === 1 ? 'conversation' : 'conversations'}`;
  const span = `the last ${days} days`;
  return previous === 0
    ? `Came up in ${what} in ${span}, and not before.`
    : `Came up in ${what} in ${span}, up from ${previous} before.`;
}

function formatDay(d: Date): string {
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
}
