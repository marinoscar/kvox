// =============================================================================
// GraphNeighborhoodService (#370, epic #347; docs/specs/ontology.md §9.1, §10, §22)
// =============================================================================
//
// A bounded walk out from one or more seeds — the entity page's neighbourhood
// and the explorer's expand-on-click — returned as a graph SLICE (nodes +
// induced edges) that #374's sigma.js view and #377's agent tools consume.
//
// THE WALK IS ONE RECURSIVE CTE, bounded in the database:
//
//   - `hops` ≤ 2 (§9.1). A walk never continues THROUGH an item node: an item
//     reached at depth 1 is a leaf (§9.1 — "Joe's commitments", not "everyone
//     else those commitments mention").
//   - Each step looks up its neighbours with a LATERAL subquery per edge kind,
//     keyed on the node id, so the work is driven by §10's
//     `(owner_id, from_id, type)` / `(owner_id, to_id, type)` indexes and the
//     `kg_items` column indexes — proportional to the neighbourhood, never to
//     the size of the owner's graph.
//   - The walk's rows are `LIMIT`ed to `4 × cap` INSIDE the query. A recursive
//     CTE is evaluated lazily and breadth-first, so that limit bounds the WORK
//     (a hub with a thousand edges stops being expanded), not only the output.
//   - `SET LOCAL statement_timeout = '3s'`; a timeout is a 503
//     `graph_query_timeout`, never a 500.
//
// WHAT AN EDGE IS. Stored `kg_relations` rows always join two `kg_entities`
// (#351's FKs) — `IDENTIFIED_AS` starts at a speaker, not an entity, so it is
// never an edge here (§5.1: a speaker is not a node). Every edge touching an
// item is DERIVED from an item column (`virtual: true`), projected from the
// ontology registry (`virtual-edges.ts`). A stored relation with the same
// `(type, from, to)` as a derived one wins.
//
// WHAT IS READABLE: `readable.ts`. Relations are evaluated `as_of` with
// #353's `AS_OF_STATUSES` (a superseded edge is history an as-of question must
// still find); items and entities are the curated set only. A `sensitive`
// person fact is NEVER a node, in any slice, under any parameter (§5.6).
//
// ORDER WHEN TRUNCATING: depth ascending, then degree descending, then id —
// so the seeds, then the best-connected neighbours, survive the cap.
// =============================================================================

import { Injectable, Logger, NotFoundException, Inject } from '@nestjs/common';
import type { EffectiveRelationType, EffectiveSchema } from '@marinoscar/kvox-contract/ontology';

import { GRAPH_NOT_FOUND_MESSAGES, GraphAccessService } from '../access/graph-access.service.js';
import { GraphOntologyService } from '../ontology/graph-ontology.service.js';
import { itemValidAtSql, relationValidAtSql } from './as-of.js';
import type {
  ExpandRequest,
  GraphEdge,
  GraphNode,
  GraphSlice,
  NeighborhoodQuery,
} from './dto/graph-read.dto.js';
import { withGraphStatementTimeout } from './graph-query-timeout.js';
import { asOfOr400, resolveNodeTypes, resolveRelationTypes, type NodeTypeFilter } from './read-params.js';
import {
  asOfRelationSql,
  ident,
  literalList,
  notSensitiveSql,
  readableEntitySql,
  readableItemSql,
  readableMentionSql,
  textArray,
  uuidArray,
} from './read-sql.js';
import { ITEM_COLUMN_EDGES, virtualEdgeId, type ItemColumnEdge } from './virtual-edges.js';
import { KVOX_PRISMA, type KvoxSql } from '../../ports/index.js';
import type { KvoxGraphDb, KvoxGraphTx } from '../data/graph-db.js';
import { Prisma } from '../../core/index.js';

/** How many walk rows the CTE may produce per node of the cap (§22: bounds work, not just output). */
export const WALK_ROW_FACTOR = 4;

export interface WalkOptions {
  hops: 1 | 2;
  /** Node filter; the seeds are always kept. `undefined` = everything. */
  types?: NodeTypeFilter;
  /** Edge-type filter, applied to stored and derived edges alike. */
  relationTypes?: string[];
  asOf: Date;
  cap: number;
  /**
   * The owner's effective schema, when the caller already has it; decides
   * which relation props an edge carries (#440). Fetched when absent.
   */
  schema?: EffectiveSchema;
}

interface WalkRow {
  node_id: string;
  depth: number;
  walk_rows: bigint | number;
}

export interface EdgeRow {
  id: string;
  type: string;
  source: string;
  target: string;
  vfrom: Date | null;
  vto: Date | null;
  vnull: boolean;
  precision: string | null;
  confidence: number | null;
  virtual: boolean;
  /** `kg_relations.props` for a stored edge; absent/null for a derived one. */
  props?: unknown;
}

/** One aggregate row of the enrichment queries. */
interface AggRow {
  id: string;
  n: number;
  last: Date | null;
}

type Tx = KvoxGraphTx;

const PRECISIONS = new Set(['day', 'month', 'year', 'unknown']);

/**
 * GraphNeighborhoodService: wiring the slice registers itself; a host configures it through the slice module's `forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class GraphNeighborhoodService {
  private readonly logger = new Logger(GraphNeighborhoodService.name);

  constructor(
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxGraphDb,
    private readonly access: GraphAccessService,
    private readonly ontology: GraphOntologyService,
  ) {}

  // ===========================================================================
  // GET /api/graph/entities/:id/neighborhood
  // ===========================================================================

  /**
   * Neighborhood.
   */
  async neighborhood(user: { id: string }, entityId: string, query: NeighborhoodQuery): Promise<GraphSlice> {
    await this.access.require(user.id, 'entity', entityId, 'view');
    const schema = await this.ontology.effectiveSchemaFor(user.id);
    return this.walk(user.id, [entityId], {
      schema,
      hops: query.hops as 1 | 2,
      types: resolveNodeTypes(schema, query.types, 'types'),
      relationTypes: resolveRelationTypes(schema, query.relationTypes, 'relationTypes'),
      asOf: asOfOr400(query.as_of),
      cap: query.limit,
    });
  }

  // ===========================================================================
  // POST /api/graph/explore/expand
  // ===========================================================================

  /** One hop from every seed. ALL seeds must be the caller's readable nodes, or a 404 that names none. */
  async expand(user: { id: string }, body: ExpandRequest): Promise<GraphSlice> {
    const seeds = [...new Set(body.nodeIds)];
    const schema = await this.ontology.effectiveSchemaFor(user.id);
    const types = resolveNodeTypes(schema, body.types, 'types');
    const relationTypes = resolveRelationTypes(schema, body.relationTypes, 'relationTypes');
    const asOf = asOfOr400(body.as_of);
    await this.assertReadableNodes(user.id, seeds);
    return this.walk(user.id, seeds, { schema, hops: 1, types, relationTypes, asOf, cap: body.cap });
  }

  /**
   * Every id must be a readable entity (not merged) or a readable,
   * non-sensitive item of this owner. All-or-nothing: one bad id is the same
   * 404 as all of them, and the message never says which.
   */
  async assertReadableNodes(ownerId: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const rows = await this.prisma.$queryRaw<{ n: number }[]>`
      SELECT (
        (SELECT count(*) FROM kg_entities e
          WHERE e.owner_id = ${ownerId}::uuid AND e.id = ANY(${uuidArray(ids)}) AND ${readableEntitySql('e')})
        +
        (SELECT count(*) FROM kg_items i
          WHERE i.owner_id = ${ownerId}::uuid AND i.id = ANY(${uuidArray(ids)})
            AND ${readableItemSql('i')} AND ${notSensitiveSql('i')})
      )::int AS n`;
    if ((rows[0]?.n ?? 0) !== ids.length) throw new NotFoundException(GRAPH_NOT_FOUND_MESSAGES.entity);
  }

  // ===========================================================================
  // The walk (exported for #372 and #377)
  // ===========================================================================

  /**
   * ⚠ Seeds are NOT authorised here — callers check them first
   * (`GraphAccessService.require` / `assertReadableNodes`). Every statement is
   * still owner-scoped, so a foreign seed can only ever produce an empty walk.
   */
  async walk(ownerId: string, seedIds: readonly string[], opts: WalkOptions): Promise<GraphSlice> {
    const started = Date.now();
    const seeds = [...new Set(seedIds)];
    const virtualEdges = this.virtualEdgesFor(opts.relationTypes);
    const rowCap = opts.cap * WALK_ROW_FACTOR;
    const schema = opts.schema ?? (await this.ontology.effectiveSchemaFor(ownerId));

    const slice = await withGraphStatementTimeout(
      this.prisma,
      this.logger,
      { ownerId, seeds: seeds.length, hops: opts.hops, cap: opts.cap },
      async (tx) => {
        const walked = await this.runWalk(tx, ownerId, seeds, opts, virtualEdges, rowCap);
        const walkRows = Number(walked[0]?.walk_rows ?? 0);
        const depthById = new Map(walked.map((r) => [r.node_id, Number(r.depth)]));
        const candidateIds = [...depthById.keys()];

        const [entities, items] = await Promise.all([
          this.loadEntities(tx, ownerId, candidateIds, seeds, opts.types),
          this.loadItems(tx, ownerId, candidateIds, seeds, opts.types),
        ]);
        const kept = [...entities, ...items];
        const degree = await this.degrees(tx, ownerId, kept.map((n) => n.id), opts.asOf);

        const sorted = kept
          .map((n) => ({ ...n, depth: depthById.get(n.id) ?? 0, degree: degree.get(n.id) ?? 0 }))
          .sort((a, b) => a.depth - b.depth || b.degree - a.degree || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

        const truncated = sorted.length > opts.cap || walkRows > rowCap;
        const nodes: GraphNode[] = sorted.slice(0, opts.cap);
        const induced = await this.inducedEdges(tx, ownerId, nodes.map((n) => n.id), opts, virtualEdges, schema);
        // Enrichment runs on the FINAL page only (after the cap), never on the walk.
        const [enrichedNodes, edges] = await Promise.all([
          this.enrichNodes(tx, ownerId, nodes),
          this.enrichEdges(tx, ownerId, induced),
        ]);

        return {
          seedIds: seeds,
          asOf: opts.asOf.toISOString(),
          nodes: enrichedNodes,
          edges,
          truncated,
          cap: opts.cap,
        } satisfies GraphSlice;
      },
    );

    const ms = Date.now() - started;
    // Ids and counts only — never a label.
    this.logger.debug({
      msg: 'graph walk',
      ownerId,
      seeds: seeds.length,
      hops: opts.hops,
      nodes: slice.nodes.length,
      truncated: slice.truncated,
      ms,
    });
    return slice;
  }

  // ---------------------------------------------------------------------------
  // SQL
  // ---------------------------------------------------------------------------

  private virtualEdgesFor(relationTypes: string[] | undefined): ItemColumnEdge[] {
    return ITEM_COLUMN_EDGES.filter((v) => !relationTypes || relationTypes.includes(v.type));
  }

  /** `r.type = ANY(...)` when filtered, else TRUE. */
  /** @internal Shared with GraphPathsService. */
  relationTypeSql(a: string, relationTypes: string[] | undefined): KvoxSql {
    return relationTypes ? Prisma.sql`${ident(a)}.type = ANY(${textArray(relationTypes)})` : Prisma.sql`TRUE`;
  }

  /** @internal Shared with GraphPathsService. */
  itemOk(a: string, asOf: Date): KvoxSql {
    return Prisma.sql`${readableItemSql(a)} AND ${notSensitiveSql(a)} AND ${itemValidAtSql(a, asOf)}`;
  }

  private async runWalk(
    tx: Tx,
    ownerId: string,
    seeds: string[],
    opts: WalkOptions,
    virtualEdges: ItemColumnEdge[],
    rowCap: number,
  ): Promise<WalkRow[]> {
    const owner = Prisma.sql`${ownerId}::uuid`;
    const branches: KvoxSql[] = [
      // entity → entity, stored, outgoing
      Prisma.sql`SELECT r.to_id AS nxt FROM kg_relations r
        JOIN kg_entities o ON o.id = r.to_id AND o.owner_id = ${owner} AND ${readableEntitySql('o')}
        WHERE r.owner_id = ${owner} AND r.from_id = w.node_id AND ${asOfRelationSql('r')}
          AND ${relationValidAtSql('r', opts.asOf)} AND ${this.relationTypeSql('r', opts.relationTypes)}`,
      // entity ← entity, stored, incoming (never from a speaker)
      Prisma.sql`SELECT r.from_id FROM kg_relations r
        JOIN kg_entities o ON o.id = r.from_id AND o.owner_id = ${owner} AND ${readableEntitySql('o')}
        WHERE r.owner_id = ${owner} AND r.to_id = w.node_id AND r.from_id IS NOT NULL AND ${asOfRelationSql('r')}
          AND ${relationValidAtSql('r', opts.asOf)} AND ${this.relationTypeSql('r', opts.relationTypes)}`,
    ];
    for (const v of virtualEdges) {
      const col = ident(v.column);
      // entity → the items whose column names it
      branches.push(Prisma.sql`SELECT i.id FROM kg_items i
        WHERE i.owner_id = ${owner} AND i.${col} = w.node_id AND i.kind IN ${literalList(v.kinds)}
          AND ${this.itemOk('i', opts.asOf)}`);
      // item → the entity its column names (only ever taken from a depth-0 item)
      branches.push(Prisma.sql`SELECT i.${col} FROM kg_items i
        JOIN kg_entities o ON o.id = i.${col} AND o.owner_id = ${owner} AND ${readableEntitySql('o')}
        WHERE i.owner_id = ${owner} AND i.id = w.node_id AND i.kind IN ${literalList(v.kinds)}
          AND ${this.itemOk('i', opts.asOf)}`);
    }

    return tx.$queryRaw<WalkRow[]>`
      WITH RECURSIVE walk(node_id, depth, path) AS (
        SELECT s, 0, ARRAY[s] FROM unnest(${uuidArray(seeds)}) AS s
        UNION ALL
        SELECT n.nxt, w.depth + 1, w.path || n.nxt
        FROM walk w
        CROSS JOIN LATERAL (${Prisma.join(branches, ' UNION ALL ')}) n
        WHERE w.depth < ${opts.hops}
          AND NOT n.nxt = ANY(w.path)
          -- never walk THROUGH an item (§9.1): an item beyond the seeds is a leaf
          AND (w.depth = 0 OR NOT EXISTS (SELECT 1 FROM kg_items it WHERE it.id = w.node_id))
      ),
      bounded AS (SELECT node_id, depth FROM walk LIMIT ${rowCap + 1})
      SELECT b.node_id::text AS node_id, min(b.depth)::int AS depth, (SELECT count(*) FROM bounded) AS walk_rows
      FROM bounded b
      GROUP BY b.node_id`;
  }

  /** @internal Shared with GraphPathsService. */
  async loadEntities(
    tx: Tx,
    ownerId: string,
    ids: string[],
    seeds: string[],
    types: NodeTypeFilter | undefined,
  ): Promise<Omit<GraphNode, 'depth' | 'degree'>[]> {
    if (ids.length === 0) return [];
    const typeOk = types
      ? Prisma.sql`(e.type = ANY(${textArray(types.entityTypes)}) OR e.id = ANY(${uuidArray(seeds)}))`
      : Prisma.sql`TRUE`;
    const rows = await tx.$queryRaw<{ id: string; type: string; label: string; occurred_at: Date | null }[]>`
      SELECT e.id::text AS id, e.type, e.label, e.occurred_at
      FROM kg_entities e
      WHERE e.owner_id = ${ownerId}::uuid AND e.id = ANY(${uuidArray(ids)}) AND ${readableEntitySql('e')} AND ${typeOk}`;
    return rows.map((r) => ({
      id: r.id,
      nodeKind: 'entity' as const,
      type: r.type,
      label: r.label,
      status: null,
      occurredAt: r.occurred_at ? r.occurred_at.toISOString() : null,
    }));
  }

  /** @internal Shared with GraphPathsService. */
  async loadItems(
    tx: Tx,
    ownerId: string,
    ids: string[],
    seeds: string[],
    types: NodeTypeFilter | undefined,
  ): Promise<Omit<GraphNode, 'depth' | 'degree'>[]> {
    if (ids.length === 0) return [];
    const kindOk = types
      ? Prisma.sql`(i.kind::text = ANY(${textArray(types.itemKinds)}) OR i.id = ANY(${uuidArray(seeds)}))`
      : Prisma.sql`TRUE`;
    const rows = await tx.$queryRaw<
      { id: string; kind: string; title: string | null; statement: string; status: string; occurred_at: Date | null }[]
    >`
      SELECT i.id::text AS id, i.kind::text AS kind, i.title, i.statement, i.status, i.occurred_at
      FROM kg_items i
      WHERE i.owner_id = ${ownerId}::uuid AND i.id = ANY(${uuidArray(ids)})
        AND ${readableItemSql('i')} AND ${notSensitiveSql('i')} AND ${kindOk}`;
    return rows.map((r) => ({
      id: r.id,
      nodeKind: 'item' as const,
      type: r.kind,
      label: itemLabel(r.title, r.statement),
      status: r.status,
      occurredAt: r.occurred_at ? r.occurred_at.toISOString() : null,
    }));
  }

  /** Readable, as-of-valid edges in the WHOLE graph per id (for node size) — one grouped query. */
  async degrees(tx: Tx | KvoxGraphDb, ownerId: string, ids: string[], asOf: Date): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const owner = Prisma.sql`${ownerId}::uuid`;
    const idArr = uuidArray(ids);
    const parts: KvoxSql[] = [
      Prisma.sql`SELECT r.from_id AS id FROM kg_relations r
        JOIN kg_entities o ON o.id = r.to_id AND o.owner_id = ${owner} AND ${readableEntitySql('o')}
        WHERE r.owner_id = ${owner} AND r.from_id = ANY(${idArr}) AND ${asOfRelationSql('r')} AND ${relationValidAtSql('r', asOf)}`,
      Prisma.sql`SELECT r.to_id FROM kg_relations r
        JOIN kg_entities o ON o.id = r.from_id AND o.owner_id = ${owner} AND ${readableEntitySql('o')}
        WHERE r.owner_id = ${owner} AND r.to_id = ANY(${idArr}) AND r.from_id IS NOT NULL
          AND ${asOfRelationSql('r')} AND ${relationValidAtSql('r', asOf)}`,
    ];
    for (const v of ITEM_COLUMN_EDGES) {
      const col = ident(v.column);
      parts.push(Prisma.sql`SELECT i.${col} FROM kg_items i
        WHERE i.owner_id = ${owner} AND i.${col} = ANY(${idArr}) AND i.kind IN ${literalList(v.kinds)} AND ${this.itemOk('i', asOf)}`);
      parts.push(Prisma.sql`SELECT i.id FROM kg_items i
        JOIN kg_entities o ON o.id = i.${col} AND o.owner_id = ${owner} AND ${readableEntitySql('o')}
        WHERE i.owner_id = ${owner} AND i.id = ANY(${idArr}) AND i.kind IN ${literalList(v.kinds)} AND ${this.itemOk('i', asOf)}`);
    }
    const rows = await tx.$queryRaw<{ id: string; degree: number }[]>`
      SELECT x.id::text AS id, count(*)::int AS degree FROM (${Prisma.join(parts, ' UNION ALL ')}) x GROUP BY x.id`;
    return new Map(rows.map((r) => [r.id, r.degree]));
  }

  /**
   * `mentionCount` / `lastSeenAt` for the final page of nodes: readable
   * mentions for an entity; latest evidence for an item (no mention count).
   * One LATERAL aggregate per row, driven by `kg_mentions(owner_id, entity_id)`
   * and `kg_evidence(subject_kind, subject_id)`.
   */
  /** @internal Shared with GraphPathsService. */
  async enrichNodes(tx: Tx, ownerId: string, nodes: GraphNode[]): Promise<GraphNode[]> {
    if (nodes.length === 0) return nodes;
    const owner = Prisma.sql`${ownerId}::uuid`;
    const entityIds = nodes.filter((n) => n.nodeKind === 'entity').map((n) => n.id);
    const itemIds = nodes.filter((n) => n.nodeKind === 'item').map((n) => n.id);
    const [mentionRows, evidenceRows] = await Promise.all([
      entityIds.length === 0
        ? Promise.resolve([] as AggRow[])
        : tx.$queryRaw<AggRow[]>`
            SELECT x.id::text AS id, m.n, m.last
            FROM unnest(${uuidArray(entityIds)}) AS x(id)
            CROSS JOIN LATERAL (
              SELECT count(*)::int AS n, max(km.created_at) AS last FROM kg_mentions km
              WHERE km.owner_id = ${owner} AND km.entity_id = x.id AND ${readableMentionSql('km')}
            ) m`,
      itemIds.length === 0 ? Promise.resolve([] as AggRow[]) : this.itemEvidence(tx, ownerId, itemIds),
    ]);
    const mentions = new Map(mentionRows.map((r) => [r.id, r]));
    const evidence = new Map(evidenceRows.map((r) => [r.id, r]));
    return nodes.map((n) => {
      if (n.nodeKind === 'entity') {
        const r = mentions.get(n.id);
        return { ...n, mentionCount: Number(r?.n ?? 0), lastSeenAt: r?.last ? new Date(r.last).toISOString() : null };
      }
      const r = evidence.get(n.id);
      return { ...n, lastSeenAt: r?.last ? new Date(r.last).toISOString() : null };
    });
  }

  /** Evidence count + latest time per readable, non-sensitive item (evidence of a sensitive item is never counted). */
  private itemEvidence(tx: Tx, ownerId: string, itemIds: string[]): Promise<AggRow[]> {
    const owner = Prisma.sql`${ownerId}::uuid`;
    return tx.$queryRaw<AggRow[]>`
      SELECT x.id::text AS id, ev.n, ev.last
      FROM unnest(${uuidArray(itemIds)}) AS x(id)
      JOIN kg_items i ON i.id = x.id AND i.owner_id = ${owner} AND ${readableItemSql('i')} AND ${notSensitiveSql('i')}
      CROSS JOIN LATERAL (
        SELECT count(*)::int AS n, max(e.created_at) AS last FROM kg_evidence e
        WHERE e.owner_id = ${owner} AND e.subject_kind = 'item'::kg_evidence_subject_kind AND e.subject_id = x.id
      ) ev`;
  }

  /** `evidenceCount` / `lastEvidenceAt` for the final edges; a virtual edge carries its item's. */
  /** @internal Shared with GraphPathsService. */
  async enrichEdges(tx: Tx, ownerId: string, edges: GraphEdge[]): Promise<GraphEdge[]> {
    if (edges.length === 0) return edges;
    const owner = Prisma.sql`${ownerId}::uuid`;
    const relationIds = edges.filter((e) => !e.virtual).map((e) => e.id);
    const itemIds = [...new Set(edges.filter((e) => e.virtual).map((e) => e.source))];
    const [relRows, itemRows] = await Promise.all([
      relationIds.length === 0
        ? Promise.resolve([] as AggRow[])
        : tx.$queryRaw<AggRow[]>`
            SELECT x.id::text AS id, ev.n, ev.last
            FROM unnest(${uuidArray(relationIds)}) AS x(id)
            CROSS JOIN LATERAL (
              SELECT count(*)::int AS n, max(e.created_at) AS last FROM kg_evidence e
              WHERE e.owner_id = ${owner} AND e.subject_kind = 'relation'::kg_evidence_subject_kind AND e.subject_id = x.id
            ) ev`,
      itemIds.length === 0 ? Promise.resolve([] as AggRow[]) : this.itemEvidence(tx, ownerId, itemIds),
    ]);
    const rel = new Map(relRows.map((r) => [r.id, r]));
    const item = new Map(itemRows.map((r) => [r.id, r]));
    return edges.map((e) => {
      const r = e.virtual ? item.get(e.source) : rel.get(e.id);
      return { ...e, evidenceCount: Number(r?.n ?? 0), lastEvidenceAt: r?.last ? new Date(r.last).toISOString() : null };
    });
  }

  /** Every readable, as-of-valid edge with BOTH ends in `ids`. */
  private async inducedEdges(
    tx: Tx,
    ownerId: string,
    ids: string[],
    opts: WalkOptions,
    virtualEdges: ItemColumnEdge[],
    schema: EffectiveSchema,
  ): Promise<GraphEdge[]> {
    if (ids.length === 0) return [];
    const owner = Prisma.sql`${ownerId}::uuid`;
    const idArr = uuidArray(ids);
    const parts: KvoxSql[] = [
      Prisma.sql`SELECT r.id::text AS id, r.type, r.from_id::text AS source, r.to_id::text AS target,
          lower(r.valid) AS vfrom, upper(r.valid) AS vto, (r.valid IS NULL) AS vnull,
          r.valid_precision::text AS precision, r.confidence, false AS virtual, r.props
        FROM kg_relations r
        WHERE r.owner_id = ${owner} AND r.from_id = ANY(${idArr}) AND r.to_id = ANY(${idArr})
          AND ${asOfRelationSql('r')} AND ${relationValidAtSql('r', opts.asOf)}
          AND ${this.relationTypeSql('r', opts.relationTypes)}`,
    ];
    for (const v of virtualEdges) {
      const col = ident(v.column);
      parts.push(Prisma.sql`SELECT 'virt:' || i.id::text || ':' || ${v.type}::text, ${v.type}::text, i.id::text, i.${col}::text,
          NULL::timestamptz, NULL::timestamptz, true, NULL::text, NULL::float8, true, NULL::jsonb
        FROM kg_items i
        WHERE i.owner_id = ${owner} AND i.id = ANY(${idArr}) AND i.${col} = ANY(${idArr})
          AND i.kind IN ${literalList(v.kinds)} AND ${this.itemOk('i', opts.asOf)}`);
    }
    const rows = await tx.$queryRaw<EdgeRow[]>`${Prisma.join(parts, ' UNION ALL ')}`;
    return mergeEdgeRows(rows, (type) => schema.relationType(type));
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * #440: the props an edge shows — only those its relation type declares in
 * the owner's effective schema, never a deprecated or `sensitive` one, and
 * never a null value; in declaration order. `{}` for a derived edge, an
 * unknown/disabled relation type, or a relation with no props.
 */
export function visibleRelationProps(
  raw: unknown,
  relationType: EffectiveRelationType | undefined,
): Record<string, unknown> {
  if (!relationType || raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const values = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const prop of relationType.props) {
    if (prop.deprecated || prop.sensitivity === 'sensitive') continue;
    const value = values[prop.key];
    if (value === undefined || value === null) continue;
    out[prop.key] = value;
  }
  return out;
}

/**
 * Edge rows → wire edges: a stored relation with the same `(type, from, to)`
 * as a derived one wins, every id appears once, sorted by id. `relationType`
 * resolves a type key against the owner's effective schema, for the edge's
 * `props` (#440); without it every edge carries `{}`.
 */
export function mergeEdgeRows(
  rows: readonly EdgeRow[],
  relationType: (type: string) => EffectiveRelationType | undefined = () => undefined,
): GraphEdge[] {
  const stored = new Set(rows.filter((r) => !r.virtual).map((r) => `${r.type}|${r.source}|${r.target}`));
  const seen = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const r of rows) {
    if (r.virtual && stored.has(`${r.type}|${r.source}|${r.target}`)) continue;
    const id = r.virtual ? virtualEdgeId(r.source, r.type) : r.id;
    if (seen.has(id)) continue;
    seen.add(id);
    edges.push({
      id,
      type: r.type,
      source: r.source,
      target: r.target,
      valid: edgeValid(r),
      confidence: r.confidence === null ? null : Number(r.confidence),
      virtual: r.virtual,
      props: r.virtual ? {} : visibleRelationProps(r.props, relationType(r.type)),
    });
  }
  return edges.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Item title, or the first 80 characters of its statement. */
export function itemLabel(title: string | null, statement: string): string {
  if (title && title.trim().length > 0) return title;
  const s = statement.trim();
  return s.length > 80 ? `${s.slice(0, 79)}…` : s;
}

/** `valid` as the wire shape; `null` for an edge with no range and no precision. */
export function edgeValid(r: Pick<EdgeRow, 'vfrom' | 'vto' | 'vnull' | 'precision'>): GraphEdge['valid'] {
  if (r.vnull && r.precision === null) return null;
  const precision = (r.precision && PRECISIONS.has(r.precision) ? r.precision : 'unknown') as
    | 'day'
    | 'month'
    | 'year'
    | 'unknown';
  if (r.vnull) return { from: null, to: null, precision };
  return {
    from: r.vfrom ? new Date(r.vfrom).toISOString() : null,
    to: r.vto ? new Date(r.vto).toISOString() : null,
    precision,
  };
}
