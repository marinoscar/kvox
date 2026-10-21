/**
 * Concentric layout by hop (GIC-07, #668): the seed at the centre and every
 * other node on the ring of its hop distance from the nearest seed. Pure.
 *
 * Within a ring nodes are ordered by interest (`doi`, the degree-of-interest of
 * GIC-06, higher first) when the node carries one, otherwise by `degree`
 * (higher first), then by id so the picture is deterministic.
 */

import type { MultiDirectedGraph, UndirectedGraph } from 'graphology';

type AnyGraph = MultiDirectedGraph | UndirectedGraph;

/** Distance between two rings, and the minimum arc between two neighbours on a ring. */
const RING_GAP = 110;
const MIN_ARC = 44;
/** Radius of the ring several seeds share around the centre. */
const SEED_RING_RADIUS = 60;

/** Ordering key of a node: higher first. */
export function interestOf(attrs: Record<string, unknown>): number {
  if (typeof attrs.doi === 'number' && Number.isFinite(attrs.doi)) return attrs.doi;
  if (typeof attrs.degree === 'number' && Number.isFinite(attrs.degree)) return attrs.degree;
  return 0;
}

/** Hop distance of every reachable node from the nearest seed (breadth first). */
export function hopDepths(graph: AnyGraph, seedIds: Iterable<string>): Map<string, number> {
  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const seed of seedIds) {
    if (graph.hasNode(seed) && !depth.has(seed)) {
      depth.set(seed, 0);
      queue.push(seed);
    }
  }
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head]!;
    const next = depth.get(id)! + 1;
    graph.forEachNeighbor(id, (neighbour) => {
      if (!depth.has(neighbour)) {
        depth.set(neighbour, next);
        queue.push(neighbour);
      }
    });
  }
  return depth;
}

/**
 * Computes concentric positions for every node of the graph.
 *
 * @param graph - The graph; `doi` and `degree` node attributes order each ring.
 * @param seedIds - The seeds; the first seed alone sits at the origin, several share a small ring.
 * @returns A position per node id. Nodes not reachable from a seed go on the outermost ring.
 */
export function concentricPositions(
  graph: AnyGraph,
  seedIds: readonly string[],
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const depth = hopDepths(graph, seedIds);
  const rings = new Map<number, string[]>();
  let outer = 0;
  for (const value of depth.values()) outer = Math.max(outer, value);
  const unreachable = graph.order > depth.size;
  graph.forEachNode((id) => {
    const ring = depth.get(id) ?? outer + 1;
    const list = rings.get(ring) ?? [];
    list.push(id);
    rings.set(ring, list);
  });
  if (!unreachable) rings.delete(outer + 1);

  const ordered = [...rings.keys()].sort((a, b) => a - b);
  let previousRadius = 0;
  for (const ring of ordered) {
    const ids = rings.get(ring)!;
    ids.sort((a, b) => {
      const byInterest = interestOf(graph.getNodeAttributes(b)) - interestOf(graph.getNodeAttributes(a));
      return byInterest !== 0 ? byInterest : a < b ? -1 : a > b ? 1 : 0;
    });
    let radius: number;
    if (ring === 0) {
      radius = ids.length > 1 ? Math.max(SEED_RING_RADIUS, (ids.length * MIN_ARC) / (2 * Math.PI)) : 0;
    } else {
      radius = Math.max(previousRadius + RING_GAP, (ids.length * MIN_ARC) / (2 * Math.PI));
    }
    ids.forEach((id, index) => {
      if (radius === 0) {
        out.set(id, { x: 0, y: 0 });
        return;
      }
      // Start at twelve o'clock and go clockwise.
      const angle = -Math.PI / 2 + (index * 2 * Math.PI) / ids.length;
      out.set(id, {
        x: Math.round(radius * Math.cos(angle) * 1000) / 1000,
        y: Math.round(radius * Math.sin(angle) * 1000) / 1000,
      });
    });
    previousRadius = radius;
  }
  return out;
}
