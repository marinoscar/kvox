// =============================================================================
// Pure path enumeration and ranking for GET /api/graph/paths (GIC-12, #673)
// =============================================================================
//
// No database, no Nest: the service discovers a bounded subgraph in SQL and
// hands it here as undirected edges. This file
//
//   - collapses parallel edges between the same two nodes to the best one;
//   - enumerates the simple paths from `from` to `to` of at most `maxHops`
//     edges, shortest first, never passing THROUGH an item (an item is only
//     ever an endpoint, §9.1);
//   - scores a path: `Σ log(1 + evidenceCount) / hops`, multiplied by a hub
//     factor per intermediate node, so a well-evidenced route through a meeting
//     beats an equally long one through a company that touches everything;
//   - picks the top k DISTINCT paths (no repeated node set).
// =============================================================================

/** One undirected adjacency entry. */
export interface PathNeighbor {
  node: string;
  edgeId: string;
  evidence: number;
}

/** An edge as the ranker sees it: direction is irrelevant to connectivity. */
export interface PathEdgeInput {
  id: string;
  a: string;
  b: string;
  /** `evidenceCount` of the edge (0 when it has none). */
  evidence: number;
}

/** An enumerated path before scoring. */
export interface RawPath {
  nodeIds: string[];
  edgeIds: string[];
}

/** A scored path. */
export interface ScoredPath extends RawPath {
  hops: number;
  score: number;
}

/** A node with at most this many edges is not penalised as a hub. */
export const HUB_FREE_DEGREE = 10;
/** How steeply the score falls with the log of a hub's excess degree. */
export const HUB_PENALTY = 0.25;
/** The most candidate paths enumerated before the search is declared truncated. */
export const MAX_CANDIDATE_PATHS = 2000;

/** `1` up to {@link HUB_FREE_DEGREE} edges, then `1 / (1 + 0.25 · ln(1 + excess))`. */
export function hubFactor(degree: number): number {
  const excess = Math.max(0, degree - HUB_FREE_DEGREE);
  return 1 / (1 + HUB_PENALTY * Math.log(1 + excess));
}

/**
 * `Σ log(1 + evidence) / hops`, times {@link hubFactor} of every intermediate
 * node (the endpoints are the question, not a detour, so they are not
 * penalised).
 */
export function scorePath(edgeEvidence: readonly number[], intermediateDegrees: readonly number[]): number {
  if (edgeEvidence.length === 0) return 0;
  const sum = edgeEvidence.reduce((acc, n) => acc + Math.log(1 + Math.max(0, n)), 0);
  return intermediateDegrees.reduce((acc, d) => acc * hubFactor(d), sum / edgeEvidence.length);
}

const byString = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

/**
 * Undirected adjacency, with parallel edges between the same pair collapsed
 * to the one with the most evidence (then the lowest id), neighbours sorted
 * by node id so every enumeration is deterministic.
 */
export function buildAdjacency(edges: readonly PathEdgeInput[]): Map<string, PathNeighbor[]> {
  const best = new Map<string, PathEdgeInput>();
  for (const e of edges) {
    if (e.a === e.b) continue;
    const key = e.a < e.b ? `${e.a}|${e.b}` : `${e.b}|${e.a}`;
    const cur = best.get(key);
    if (!cur || e.evidence > cur.evidence || (e.evidence === cur.evidence && e.id < cur.id)) best.set(key, e);
  }
  const adj = new Map<string, PathNeighbor[]>();
  const push = (from: string, node: string, e: PathEdgeInput): void => {
    const list = adj.get(from) ?? [];
    list.push({ node, edgeId: e.id, evidence: e.evidence });
    adj.set(from, list);
  };
  for (const e of best.values()) {
    push(e.a, e.b, e);
    push(e.b, e.a, e);
  }
  for (const list of adj.values()) list.sort((x, y) => byString(x.node, y.node) || byString(x.edgeId, y.edgeId));
  return adj;
}

/**
 * Hop distance from `start` to every node it reaches, never continuing
 * THROUGH a leaf (an item that is not `start`). A leaf still gets a distance.
 */
export function distancesFrom(
  adj: ReadonlyMap<string, readonly PathNeighbor[]>,
  start: string,
  isLeaf: (node: string) => boolean,
): Map<string, number> {
  const dist = new Map<string, number>([[start, 0]]);
  let level = [start];
  while (level.length > 0) {
    const next: string[] = [];
    for (const u of level) {
      if (u !== start && isLeaf(u)) continue;
      for (const n of adj.get(u) ?? []) {
        if (dist.has(n.node)) continue;
        dist.set(n.node, (dist.get(u) as number) + 1);
        next.push(n.node);
      }
    }
    level = next;
  }
  return dist;
}

export interface EnumerateResult {
  paths: RawPath[];
  /** True when {@link MAX_CANDIDATE_PATHS} stopped the enumeration. */
  truncated: boolean;
}

/**
 * Every simple path `from → to` with at most `maxHops` edges, shortest first
 * (iterative deepening), stopping at `limit` paths. Intermediate nodes are
 * never leaves; `from` and `to` may be.
 */
export function enumeratePaths(
  adj: ReadonlyMap<string, readonly PathNeighbor[]>,
  from: string,
  to: string,
  maxHops: number,
  isLeaf: (node: string) => boolean,
  limit: number = MAX_CANDIDATE_PATHS,
): EnumerateResult {
  const toDist = distancesFrom(adj, to, isLeaf);
  const paths: RawPath[] = [];
  let truncated = false;
  if (!toDist.has(from)) return { paths, truncated };

  const nodeIds: string[] = [from];
  const edgeIds: string[] = [];
  const onPath = new Set<string>([from]);

  const dfs = (node: string, exact: number): void => {
    if (truncated) return;
    const depth = edgeIds.length;
    if (depth === exact) {
      if (node === to) {
        if (paths.length >= limit) {
          truncated = true;
          return;
        }
        paths.push({ nodeIds: [...nodeIds], edgeIds: [...edgeIds] });
      }
      return;
    }
    if (node === to) return; // a path ends the first time it reaches `to`
    for (const n of adj.get(node) ?? []) {
      if (onPath.has(n.node)) continue;
      if (n.node !== to && isLeaf(n.node)) continue; // an item is only ever an endpoint
      const rest = toDist.get(n.node);
      if (rest === undefined || depth + 1 + rest > exact) continue;
      nodeIds.push(n.node);
      edgeIds.push(n.edgeId);
      onPath.add(n.node);
      dfs(n.node, exact);
      onPath.delete(n.node);
      edgeIds.pop();
      nodeIds.pop();
      if (truncated) return;
    }
  };

  for (let exact = 1; exact <= maxHops && !truncated; exact++) dfs(from, exact);
  return { paths, truncated };
}

/** The sorted node set of a path: two paths with the same one are the same path. */
export function nodeSetKey(nodeIds: readonly string[]): string {
  return [...nodeIds].sort(byString).join('|');
}

/**
 * Best first (score desc, then fewer hops, then ids for a stable tie), at most
 * `k`, no two sharing a node set.
 */
export function selectTopPaths(scored: readonly ScoredPath[], k: number): ScoredPath[] {
  const sorted = [...scored].sort(
    (x, y) =>
      y.score - x.score || x.hops - y.hops || byString(x.nodeIds.join('>'), y.nodeIds.join('>')) || byString(x.edgeIds.join('>'), y.edgeIds.join('>')),
  );
  const seen = new Set<string>();
  const out: ScoredPath[] = [];
  for (const p of sorted) {
    const key = nodeSetKey(p.nodeIds);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (out.length >= k) break;
  }
  return out;
}
