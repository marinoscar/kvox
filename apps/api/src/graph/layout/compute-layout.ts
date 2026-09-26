// =============================================================================
// computeLayout — whole-graph clusters and positions (#371, epic #347)
// docs/specs/ontology.md §22.3 "Whole-graph overview"
// =============================================================================
//
// PURE: ids and types in, clusters and coordinates out. No Prisma, no Nest, no
// clock, no `Math.random` — the `kg.graph_layout` handler reads the owner's
// graph and writes the snapshot; this file only computes. That split is what
// lets the determinism test run without a database, and what would let the
// work move to a worker node later without rewriting it.
//
// Pipeline (issue #371's steps):
//   1. A graphology `UndirectedGraph`, no self loops; parallel edges between
//      one pair merge by summing `weight`. Nodes and edges are inserted in
//      SORTED order, so the database's row order cannot change the picture.
//   2. Louvain (`graphology-communities-louvain`, resolution 1, seeded rng).
//      Singleton communities — isolated nodes — pool into cluster −1
//      ("Unconnected"). Communities are renumbered by size (desc), then by
//      their smallest member id, so the numbering is stable too.
//   3. Seeded random initial positions, then ForceAtlas2, then a
//      shape-preserving normalization into `[-1000, 1000]`.
//   4. Cluster rows: label candidate, centroid, radius, type counts, sample.
//   5. Above `maxPositioned` nodes only the top nodes by degree get positions;
//      above `LOUVAIN_MAX_NODES` nothing is computed (`tooLarge`).
//
// Labels are never an input and never an output: the snapshot stores ids and
// coordinates only, and the overview joins labels live (spec §15 — a forgotten
// person's name must not survive in a cache).
// =============================================================================

import { UndirectedGraph } from 'graphology';
import louvain from 'graphology-communities-louvain';
import random from 'graphology-layout/random';
import forceAtlas2 from 'graphology-layout-forceatlas2';

import { mulberry32, seedFrom } from './seeded-rng';

/** Cluster id every singleton community pools into. */
export const UNCONNECTED_CLUSTER_ID = -1;

/** Default ceiling on nodes that get ForceAtlas2 positions. */
export const LAYOUT_MAX_POSITIONED = 20_000;

/** Beyond this, even Louvain is not attempted: `tooLarge`. */
export const LOUVAIN_MAX_NODES = 100_000;

/** Coordinates are normalized into `[-LAYOUT_EXTENT, LAYOUT_EXTENT]`. */
export const LAYOUT_EXTENT = 1000;

/** Most `sampleIds` per cluster. */
export const CLUSTER_SAMPLE_SIZE = 8;

/** Most inter-cluster edges kept. */
export const CLUSTER_EDGES_MAX = 500;

/** Types a cluster is best named after; `Meeting` is the last resort. */
const PREFERRED_LABEL_TYPES = new Set(['Person', 'Organization', 'Project']);
const LAST_RESORT_LABEL_TYPE = 'Meeting';

export interface LayoutInput {
  nodes: { id: string; type: string }[];
  edges: { source: string; target: string; weight: number }[];
}

export interface ClusterRow {
  id: number;
  /** Highest weighted-degree member, preferring Person/Organization/Project. `null` for −1. */
  labelEntityId: string | null;
  size: number;
  x: number;
  y: number;
  radius: number;
  typeCounts: Record<string, number>;
  /** ≤ 8 member ids, highest degree first. */
  sampleIds: string[];
}

/** `[id, x, y, clusterId, typeIndex, degree]` — `typeIndex` indexes `types`. */
export type PositionTuple = [string, number, number, number, number, number];

export interface LayoutOutput {
  clusters: ClusterRow[];
  clusterEdges: { a: number; b: number; weight: number }[];
  modularity: number;
  /** Highest degree first, then id — so a reader can truncate by slicing. */
  positions: PositionTuple[];
  types: string[];
  tooLarge: boolean;
  /** Nodes in the built graph (every input node). */
  nodeCount: number;
  /** Edges in the built graph, after dropping self loops/dangling ends and merging parallels. */
  edgeCount: number;
}

export interface LayoutOptions {
  seed: string;
  /** Nodes kept for positions when the graph is larger (issue #371's `maxNodes`). */
  maxNodes?: number;
  /** Alias of `maxNodes`; the smaller of the two wins. */
  maxPositioned?: number;
}

/** ForceAtlas2 iteration budget by graph size (issue #371). */
export function fa2Iterations(n: number): number {
  if (n < 1000) return 300;
  if (n < 10_000) return 150;
  return 80;
}

/** `20 * sqrt(size)`. */
export function clusterRadius(size: number): number {
  return round2(20 * Math.sqrt(size));
}

function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function labelRank(type: string): number {
  if (PREFERRED_LABEL_TYPES.has(type)) return 0;
  if (type === LAST_RESORT_LABEL_TYPE) return 2;
  return 1;
}

export function computeLayout(input: LayoutInput, opts: LayoutOptions): LayoutOutput {
  const maxPositioned = Math.min(opts.maxNodes ?? LAYOUT_MAX_POSITIONED, opts.maxPositioned ?? LAYOUT_MAX_POSITIONED);

  // --- 1. Build ---------------------------------------------------------------
  const typeOf = new Map<string, string>();
  for (const node of input.nodes) typeOf.set(node.id, node.type);
  const nodeIds = [...typeOf.keys()].sort(byId);
  const types = [...new Set(typeOf.values())].sort(byId);
  const typeIndex = new Map(types.map((t, i) => [t, i]));

  const merged = new Map<string, { a: string; b: string; weight: number }>();
  for (const edge of input.edges) {
    if (edge.source === edge.target) continue;
    if (!typeOf.has(edge.source) || !typeOf.has(edge.target)) continue;
    if (!(edge.weight > 0)) continue;
    const [a, b] = edge.source < edge.target ? [edge.source, edge.target] : [edge.target, edge.source];
    const key = `${a}|${b}`;
    const existing = merged.get(key);
    if (existing) existing.weight += edge.weight;
    else merged.set(key, { a, b, weight: edge.weight });
  }
  const edges = [...merged.values()].sort((x, y) => byId(x.a, y.a) || byId(x.b, y.b));

  const empty: LayoutOutput = {
    clusters: [],
    clusterEdges: [],
    modularity: 0,
    positions: [],
    types,
    tooLarge: false,
    nodeCount: nodeIds.length,
    edgeCount: edges.length,
  };

  if (nodeIds.length === 0) return empty;
  if (nodeIds.length > LOUVAIN_MAX_NODES) return { ...empty, tooLarge: true };

  const graph = new UndirectedGraph<{ type: string; x?: number; y?: number }, { weight: number }>({
    allowSelfLoops: false,
  });
  for (const id of nodeIds) graph.addNode(id, { type: typeOf.get(id) as string });
  for (const e of edges) graph.addEdge(e.a, e.b, { weight: e.weight });

  const degree = new Map<string, number>();
  const weightedDegree = new Map<string, number>();
  for (const id of nodeIds) {
    degree.set(id, graph.degree(id));
    let w = 0;
    graph.forEachEdge(id, (_edge, attrs) => {
      w += attrs.weight;
    });
    weightedDegree.set(id, w);
  }

  const rng = mulberry32(seedFrom(opts.seed));

  // --- 2. Communities -----------------------------------------------------------
  let rawCommunities: Record<string, number>;
  let modularity = 0;
  if (graph.size > 0) {
    const detailed = louvain.detailed(graph, { getEdgeWeight: 'weight', resolution: 1, rng });
    rawCommunities = detailed.communities;
    modularity = Number.isFinite(detailed.modularity) ? detailed.modularity : 0;
  } else {
    // No edges: every node is its own community (and so pools into −1).
    rawCommunities = Object.fromEntries(nodeIds.map((id, i) => [id, i]));
  }

  const members = new Map<number, string[]>();
  for (const id of nodeIds) {
    const c = rawCommunities[id];
    const list = members.get(c);
    if (list) list.push(id);
    else members.set(c, [id]);
  }
  const groups = [...members.values()];
  const real = groups.filter((g) => g.length > 1).sort((x, y) => y.length - x.length || byId(x[0], y[0]));
  const clusterOf = new Map<string, number>();
  real.forEach((g, i) => g.forEach((id) => clusterOf.set(id, i)));
  const unconnected = groups.filter((g) => g.length === 1).flat().sort(byId);
  unconnected.forEach((id) => clusterOf.set(id, UNCONNECTED_CLUSTER_ID));

  // --- 3. Positions ---------------------------------------------------------------
  const byDegree = (x: string, y: string): number =>
    (degree.get(y) as number) - (degree.get(x) as number) ||
    (weightedDegree.get(y) as number) - (weightedDegree.get(x) as number) ||
    byId(x, y);
  const ranked = [...nodeIds].sort(byDegree);
  const positioned = ranked.length > maxPositioned ? ranked.slice(0, maxPositioned) : ranked;

  let layoutGraph = graph;
  if (positioned.length < nodeIds.length) {
    const keep = new Set(positioned);
    layoutGraph = new UndirectedGraph({ allowSelfLoops: false });
    for (const id of nodeIds) if (keep.has(id)) layoutGraph.addNode(id, { type: typeOf.get(id) as string });
    for (const e of edges) if (keep.has(e.a) && keep.has(e.b)) layoutGraph.addEdge(e.a, e.b, { weight: e.weight });
  }

  const n = layoutGraph.order;
  random.assign(layoutGraph, { rng, scale: LAYOUT_EXTENT });
  forceAtlas2.assign(layoutGraph, {
    iterations: fa2Iterations(n),
    getEdgeWeight: 'weight',
    settings: {
      ...forceAtlas2.inferSettings(layoutGraph),
      barnesHutOptimize: n > 2000,
      strongGravityMode: true,
    },
  });

  const coords = normalize(layoutGraph);

  const positions: PositionTuple[] = positioned.map((id) => {
    const [x, y] = coords.get(id) as [number, number];
    return [
      id,
      x,
      y,
      clusterOf.get(id) as number,
      typeIndex.get(typeOf.get(id) as string) as number,
      degree.get(id) as number,
    ];
  });

  // --- 4. Cluster rows ----------------------------------------------------------
  const clusterMembers: Array<{ id: number; ids: string[] }> = real.map((g, i) => ({ id: i, ids: g }));
  if (unconnected.length > 0) clusterMembers.push({ id: UNCONNECTED_CLUSTER_ID, ids: unconnected });

  const clusters: ClusterRow[] = clusterMembers.map(({ id, ids }) => {
    const typeCounts: Record<string, number> = {};
    for (const m of ids) {
      const t = typeOf.get(m) as string;
      typeCounts[t] = (typeCounts[t] ?? 0) + 1;
    }
    const sortedTypeCounts = Object.fromEntries(Object.entries(typeCounts).sort(([a], [b]) => byId(a, b)));

    let sx = 0;
    let sy = 0;
    let placed = 0;
    for (const m of ids) {
      const c = coords.get(m);
      if (!c) continue;
      sx += c[0];
      sy += c[1];
      placed += 1;
    }

    let labelEntityId: string | null = null;
    if (id !== UNCONNECTED_CLUSTER_ID) {
      labelEntityId = [...ids].sort(
        (x, y) =>
          labelRank(typeOf.get(x) as string) - labelRank(typeOf.get(y) as string) ||
          (weightedDegree.get(y) as number) - (weightedDegree.get(x) as number) ||
          byId(x, y),
      )[0];
    }

    return {
      id,
      labelEntityId,
      size: ids.length,
      x: placed ? round2(sx / placed) : 0,
      y: placed ? round2(sy / placed) : 0,
      radius: clusterRadius(ids.length),
      typeCounts: sortedTypeCounts,
      sampleIds: [...ids].sort(byDegree).slice(0, CLUSTER_SAMPLE_SIZE),
    };
  });

  // --- Inter-cluster edges ------------------------------------------------------
  const between = new Map<string, { a: number; b: number; weight: number }>();
  for (const e of edges) {
    const ca = clusterOf.get(e.a) as number;
    const cb = clusterOf.get(e.b) as number;
    if (ca === cb) continue;
    const [a, b] = ca < cb ? [ca, cb] : [cb, ca];
    const key = `${a}|${b}`;
    const existing = between.get(key);
    if (existing) existing.weight += e.weight;
    else between.set(key, { a, b, weight: e.weight });
  }
  const clusterEdges = [...between.values()]
    .sort((x, y) => y.weight - x.weight || x.a - y.a || x.b - y.b)
    .slice(0, CLUSTER_EDGES_MAX)
    .map((e) => ({ ...e, weight: round2(e.weight) }));

  return {
    clusters,
    clusterEdges,
    modularity: Math.round(modularity * 1e6) / 1e6,
    positions,
    types,
    tooLarge: false,
    nodeCount: nodeIds.length,
    edgeCount: edges.length,
  };
}

/**
 * Center the bounding box on the origin and scale its longer side to
 * `2 * LAYOUT_EXTENT`, preserving the aspect ratio. A single node (or a
 * degenerate layout) lands on the origin.
 */
function normalize(graph: UndirectedGraph): Map<string, [number, number]> {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  graph.forEachNode((_id, attrs) => {
    const x = attrs.x as number;
    const y = attrs.y as number;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  });
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const half = Math.max(maxX - minX, maxY - minY) / 2;
  const scale = half > 0 && Number.isFinite(half) ? LAYOUT_EXTENT / half : 0;

  const out = new Map<string, [number, number]>();
  graph.forEachNode((id, attrs) => {
    const x = Number.isFinite(attrs.x) ? ((attrs.x as number) - cx) * scale : 0;
    const y = Number.isFinite(attrs.y) ? ((attrs.y as number) - cy) * scale : 0;
    out.set(id, [clamp(round2(x)), clamp(round2(y))]);
  });
  return out;
}

function clamp(v: number): number {
  return Math.max(-LAYOUT_EXTENT, Math.min(LAYOUT_EXTENT, v));
}
