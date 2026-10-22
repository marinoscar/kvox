// =============================================================================
// GraphPathsService (GIC-12, #673; docs/specs/ontology.md §12, §22)
// =============================================================================
//
// "How is Joe connected to the Copilot rollout?" — the top k evidence-weighted
// paths between two nodes, as ids plus the graph slice they cover.
//
// THE SEARCH IS A BIDIRECTIONAL BFS, one SQL statement per level:
//
//   - the forward search starts at `from`, the backward one at `to`; each step
//     expands the side with the smaller frontier, until the two have taken
//     `maxHops` levels together. Every path of at most `maxHops` edges then has
//     each of its edges discovered by at least one side;
//   - a level reads the edges of its frontier with the neighbourhood walk's
//     predicates (`readable.ts`, `as-of.ts`, the type and relation filters,
//     `IDENTIFIED_AS` never an edge, a `sensitive` PersonFact never a node), so
//     it is driven by the same `(owner_id, from_id, type)` / `(owner_id, to_id,
//     type)` indexes and stays proportional to the frontier;
//   - each level is `LIMIT`ed to `HOP_ROW_CAP + 1` rows INSIDE the query: a hub
//     with thousands of edges stops being read, and the response says
//     `truncated`;
//   - an item is only ever an endpoint (§9.1): it is never put on a frontier
//     and never an intermediate node of a path;
//   - the whole thing runs inside `withGraphStatementTimeout` (3 s, 503
//     `graph_query_timeout`).
//
// The discovered subgraph is then ranked in memory (`graph-path-ranking.ts`).
// Direction is irrelevant to connectivity (a directed relation is walked both
// ways) but every returned edge keeps its stored direction.
// =============================================================================

import { Inject, Injectable, Logger } from '@nestjs/common';

import { Prisma } from '../../core/index.js';
import { KVOX_PRISMA, type KvoxSql } from '../../ports/index.js';
import type { KvoxGraphDb, KvoxGraphTx } from '../data/graph-db.js';
import { GraphOntologyService } from '../ontology/graph-ontology.service.js';
import { asOfRelationSql } from './read-sql.js';
import { relationValidAtSql } from './as-of.js';
import {
  GRAPH_NODE_CAP,
  type GraphEdge,
  type GraphNode,
  type GraphPath,
  type GraphPathsQuery,
  type GraphPathsResponse,
} from './dto/graph-read.dto.js';
import {
  MAX_CANDIDATE_PATHS,
  buildAdjacency,
  distancesFrom,
  enumeratePaths,
  scorePath,
  selectTopPaths,
  type PathEdgeInput,
  type ScoredPath,
} from './graph-path-ranking.js';
import { GraphNeighborhoodService, mergeEdgeRows, type EdgeRow } from './graph-neighborhood.service.js';
import { withGraphStatementTimeout } from './graph-query-timeout.js';
import { asOfOr400, resolveNodeTypes, resolveRelationTypes, type NodeTypeFilter } from './read-params.js';
import {
  ident,
  literalList,
  readableEntitySql,
  textArray,
  uuidArray,
} from './read-sql.js';
import { ITEM_COLUMN_EDGES } from './virtual-edges.js';

/** The most edge rows one BFS level reads; the frontier of the next level is at most this big. */
export const HOP_ROW_CAP = 2000;

/** Test and tuning hooks; the HTTP route never sets them. */
export interface GraphPathsOptions {
  /** Overrides the 3 s statement budget (a test forces a tiny one). */
  timeoutMs?: number;
}

interface Search {
  frontier: string[];
  visited: Set<string>;
  depth: number;
}

/**
 * GraphPathsService: wiring the slice registers itself; a host configures it through the slice module's `forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class GraphPathsService {
  private readonly logger = new Logger(GraphPathsService.name);

  constructor(
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxGraphDb,
    private readonly ontology: GraphOntologyService,
    private readonly neighborhood: GraphNeighborhoodService,
  ) {}

  /**
   * The top `k` distinct paths between two of the caller's readable nodes.
   * Either end unreadable or not theirs is the same 404, naming neither.
   */
  async paths(
    user: { id: string },
    query: GraphPathsQuery,
    options: GraphPathsOptions = {},
  ): Promise<GraphPathsResponse> {
    const started = Date.now();
    const { from, to } = query;
    await this.neighborhood.assertReadableNodes(user.id, [from, to]);
    const schema = await this.ontology.effectiveSchemaFor(user.id);
    const types = resolveNodeTypes(schema, query.types, 'types');
    const relationTypes = resolveRelationTypes(schema, query.relationTypes, 'relationTypes');
    const asOf = asOfOr400(query.as_of);
    const ownerId = user.id;

    const result = await withGraphStatementTimeout(
      this.prisma,
      this.logger,
      { ownerId, hops: query.maxHops, k: query.k },
      async (tx) => {
        // ---- 1. discover the subgraph, level by level ---------------------------
        const pool = new Map<string, EdgeRow>();
        const items = new Set<string>();
        let capped = false;
        const fwd: Search = { frontier: [from], visited: new Set([from]), depth: 0 };
        const bwd: Search = { frontier: [to], visited: new Set([to]), depth: 0 };
        const roots = [from, to];

        while (fwd.depth + bwd.depth < query.maxHops) {
          const open = [fwd, bwd].filter((s) => s.frontier.length > 0);
          if (open.length === 0) break;
          const side = open.length === 1 || fwd.frontier.length <= bwd.frontier.length ? open[0] : open[1];
          const { rows, overflow } = await this.expandLevel(tx, ownerId, side.frontier, roots, { types, relationTypes, asOf });
          capped = capped || overflow;
          const next = new Set<string>();
          for (const r of rows) {
            pool.set(r.id, r);
            if (r.virtual) items.add(r.source);
            for (const n of [r.source, r.target]) {
              if (items.has(n) || side.visited.has(n)) continue;
              next.add(n);
            }
          }
          // An item found later in the batch must not slip into the frontier.
          for (const n of next) if (items.has(n)) next.delete(n);
          for (const n of next) side.visited.add(n);
          side.frontier = [...next];
          side.depth += 1;
        }

        const edges = mergeEdgeRows([...pool.values()], (t) => schema.relationType(t));
        const isLeaf = (n: string): boolean => items.has(n);

        // ---- 2. keep the edges some path of <= maxHops could use ----------------
        const plain = buildAdjacency(edges.map((e) => ({ id: e.id, a: e.source, b: e.target, evidence: 0 })));
        const dFrom = distancesFrom(plain, from, isLeaf);
        const dTo = distancesFrom(plain, to, isLeaf);
        const reach = (a: string, b: string): boolean =>
          (dFrom.get(a) ?? Infinity) + 1 + (dTo.get(b) ?? Infinity) <= query.maxHops;
        const useful = edges.filter((e) => reach(e.source, e.target) || reach(e.target, e.source));
        const enriched = await this.neighborhood.enrichEdges(tx, ownerId, useful);
        const edgeById = new Map(enriched.map((e) => [e.id, e]));

        // ---- 3. enumerate, score, pick -------------------------------------------
        const adj = buildAdjacency(enriched.map(edgeInput));
        const found = enumeratePaths(adj, from, to, query.maxHops, isLeaf, MAX_CANDIDATE_PATHS);
        const nodeIds = new Set<string>([from, to]);
        for (const p of found.paths) for (const n of p.nodeIds) nodeIds.add(n);
        const degree = await this.neighborhood.degrees(tx, ownerId, [...nodeIds], asOf);

        const scored: ScoredPath[] = found.paths.map((p) => ({
          ...p,
          hops: p.edgeIds.length,
          score: scorePath(
            p.edgeIds.map((id) => edgeById.get(id)?.evidenceCount ?? 0),
            p.nodeIds.slice(1, -1).map((n) => degree.get(n) ?? 0),
          ),
        }));
        const top = selectTopPaths(scored, query.k);

        // ---- 4. the slice of the winners -----------------------------------------
        const chosenNodes = new Set<string>([from, to]);
        const chosenEdges = new Set<string>();
        for (const p of top) {
          for (const n of p.nodeIds) chosenNodes.add(n);
          for (const e of p.edgeIds) chosenEdges.add(e);
        }
        const nodes = await this.loadNodes(tx, ownerId, [...chosenNodes], from, to, degree);
        const sliceEdges = enriched.filter((e) => chosenEdges.has(e.id));

        return { top, nodes, sliceEdges, truncated: capped || found.truncated };
      },
      options.timeoutMs,
    );

    const paths: GraphPath[] = result.top.map((p) => ({
      nodeIds: p.nodeIds,
      edgeIds: p.edgeIds,
      hops: p.hops,
      score: Number(p.score.toFixed(4)),
    }));
    this.logger.debug({
      msg: 'graph paths',
      ownerId,
      paths: paths.length,
      truncated: result.truncated,
      ms: Date.now() - started,
    });
    return {
      from,
      to,
      asOf: query.as_of ? asOf.toISOString() : null,
      paths,
      slice: {
        seedIds: [from, to],
        asOf: asOf.toISOString(),
        nodes: result.nodes,
        edges: result.sliceEdges,
        truncated: result.truncated,
        cap: GRAPH_NODE_CAP,
      },
      truncated: result.truncated,
    };
  }

  // ---------------------------------------------------------------------------
  // SQL
  // ---------------------------------------------------------------------------

  /**
   * Every readable, as-of-valid edge touching `frontier`, at most
   * `HOP_ROW_CAP` of them (`overflow` says there were more). The neighbour must
   * pass the node-type filter unless it is an endpoint of the question.
   */
  private async expandLevel(
    tx: KvoxGraphTx,
    ownerId: string,
    frontier: string[],
    roots: string[],
    f: { types?: NodeTypeFilter; relationTypes?: string[]; asOf: Date },
  ): Promise<{ rows: EdgeRow[]; overflow: boolean }> {
    const owner = Prisma.sql`${ownerId}::uuid`;
    const front = uuidArray(frontier);
    const rootArr = uuidArray(roots);
    const typeOk = (a: string): KvoxSql =>
      f.types
        ? Prisma.sql`(${ident(a)}.type = ANY(${textArray(f.types.entityTypes)}) OR ${ident(a)}.id = ANY(${rootArr}))`
        : Prisma.sql`TRUE`;
    const relType = (a: string): KvoxSql => this.neighborhood.relationTypeSql(a, f.relationTypes);

    const parts: KvoxSql[] = [
      Prisma.sql`SELECT r.id::text AS id, r.type, r.from_id::text AS source, r.to_id::text AS target,
          lower(r.valid) AS vfrom, upper(r.valid) AS vto, (r.valid IS NULL) AS vnull,
          r.valid_precision::text AS precision, r.confidence, false AS virtual, r.props
        FROM kg_relations r
        JOIN kg_entities o ON o.id = r.to_id AND o.owner_id = ${owner} AND ${readableEntitySql('o')} AND ${typeOk('o')}
        WHERE r.owner_id = ${owner} AND r.from_id = ANY(${front}) AND ${asOfRelationSql('r')}
          AND ${relationValidAtSql('r', f.asOf)} AND ${relType('r')}`,
      Prisma.sql`SELECT r.id::text, r.type, r.from_id::text, r.to_id::text,
          lower(r.valid), upper(r.valid), (r.valid IS NULL),
          r.valid_precision::text, r.confidence, false, r.props
        FROM kg_relations r
        JOIN kg_entities o ON o.id = r.from_id AND o.owner_id = ${owner} AND ${readableEntitySql('o')} AND ${typeOk('o')}
        WHERE r.owner_id = ${owner} AND r.to_id = ANY(${front}) AND r.from_id IS NOT NULL AND ${asOfRelationSql('r')}
          AND ${relationValidAtSql('r', f.asOf)} AND ${relType('r')}`,
    ];
    for (const v of ITEM_COLUMN_EDGES.filter((e) => !f.relationTypes || f.relationTypes.includes(e.type))) {
      const col = ident(v.column);
      // entity -> an item ENDPOINT whose column names it (an item between is never a hop)
      parts.push(Prisma.sql`SELECT 'virt:' || i.id::text || ':' || ${v.type}::text, ${v.type}::text, i.id::text, i.${col}::text,
          NULL::timestamptz, NULL::timestamptz, true, NULL::text, NULL::float8, true, NULL::jsonb
        FROM kg_items i
        WHERE i.owner_id = ${owner} AND i.${col} = ANY(${front}) AND i.id = ANY(${rootArr})
          AND i.kind IN ${literalList(v.kinds)} AND ${this.neighborhood.itemOk('i', f.asOf)}`);
      // an item endpoint on the frontier -> the entity its column names
      parts.push(Prisma.sql`SELECT 'virt:' || i.id::text || ':' || ${v.type}::text, ${v.type}::text, i.id::text, i.${col}::text,
          NULL::timestamptz, NULL::timestamptz, true, NULL::text, NULL::float8, true, NULL::jsonb
        FROM kg_items i
        JOIN kg_entities o ON o.id = i.${col} AND o.owner_id = ${owner} AND ${readableEntitySql('o')} AND ${typeOk('o')}
        WHERE i.owner_id = ${owner} AND i.id = ANY(${front}) AND i.id = ANY(${rootArr})
          AND i.kind IN ${literalList(v.kinds)} AND ${this.neighborhood.itemOk('i', f.asOf)}`);
    }

    const rows = await tx.$queryRaw<EdgeRow[]>`
      SELECT * FROM (${Prisma.join(parts, ' UNION ALL ')}) x ORDER BY x.id LIMIT ${HOP_ROW_CAP + 1}`;
    return rows.length > HOP_ROW_CAP ? { rows: rows.slice(0, HOP_ROW_CAP), overflow: true } : { rows, overflow: false };
  }

  /** The chosen nodes as wire nodes: the endpoints at depth 0, the rest at 1; enriched like a neighbourhood's. */
  private async loadNodes(
    tx: KvoxGraphTx,
    ownerId: string,
    ids: string[],
    from: string,
    to: string,
    degree: Map<string, number>,
  ): Promise<GraphNode[]> {
    const [entities, items] = await Promise.all([
      this.neighborhood.loadEntities(tx, ownerId, ids, [from, to], undefined),
      this.neighborhood.loadItems(tx, ownerId, ids, [from, to], undefined),
    ]);
    const rank = (id: string): number => (id === from ? 0 : id === to ? 1 : 2);
    const nodes: GraphNode[] = [...entities, ...items]
      .map((n) => ({ ...n, depth: n.id === from || n.id === to ? 0 : 1, degree: degree.get(n.id) ?? 0 }))
      .sort((a, b) => rank(a.id) - rank(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return this.neighborhood.enrichNodes(tx, ownerId, nodes);
  }
}

function edgeInput(e: GraphEdge): PathEdgeInput {
  return { id: e.id, a: e.source, b: e.target, evidence: e.evidenceCount ?? 0 };
}
