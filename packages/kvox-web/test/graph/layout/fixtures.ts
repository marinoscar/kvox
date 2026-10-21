import { MultiDirectedGraph } from 'graphology';

import { ringPosition } from '../../../src/graph/ui/components/explorer/explorerModel.js';

/** A small deterministic generator (mulberry32), so a fixture is the same everywhere. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A seeded graph: node `n0` is the seed, every other node hangs off an earlier
 * one (a random tree) plus a few extra edges. Nodes are placed on rings around
 * their parent, the way `explorerModel.mergeSlice` seeds them.
 */
export function seededGraph(order: number, seed = 7): MultiDirectedGraph {
  const random = seededRandom(seed);
  const graph = new MultiDirectedGraph();
  graph.addNode('n0', { x: 0, y: 0, size: 6, degree: 0, fixed: false });
  const children = new Map<string, number>();
  for (let i = 1; i < order; i += 1) {
    const parent = `n${Math.floor(random() * i)}`;
    const index = children.get(parent) ?? 0;
    children.set(parent, index + 1);
    const center = graph.getNodeAttributes(parent);
    const position = ringPosition(center.x as number, center.y as number, index);
    graph.addNode(`n${i}`, { ...position, size: 5, degree: 0, fixed: false });
    graph.addDirectedEdge(parent, `n${i}`, { weight: 1 });
  }
  for (let i = 0; i < Math.floor(order / 4); i += 1) {
    const a = `n${Math.floor(random() * order)}`;
    const b = `n${Math.floor(random() * order)}`;
    if (a !== b) graph.addDirectedEdge(a, b, { weight: 1 });
  }
  graph.forEachNode((id) => graph.setNodeAttribute(id, 'degree', graph.degree(id)));
  return graph;
}
