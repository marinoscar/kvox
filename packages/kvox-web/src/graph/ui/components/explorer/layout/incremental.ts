/**
 * Incremental layout planning (GIC-07, #668): pure functions that decide which
 * nodes may move and turn a graph into a layout request.
 *
 * THE RULE. Expanding a node never moves a node that was already laid out: the
 * run is built with every earlier node `fixed`, and only the new ones (seeded on a
 * ring around their parent by `explorerModel.mergeSlice`, via `ringPosition`)
 * move. "Re-layout all" is the one way to move everything, and even then a
 * pinned node stays where the user put it.
 */

import type { MultiDirectedGraph, UndirectedGraph } from 'graphology';

import { ringPosition } from '../explorerModel.js';
import {
  BARNES_HUT_THRESHOLD,
  FA2_SETTLE_ITERATIONS,
} from './layoutBudgets.js';
import type { LayoutEdge, LayoutNode, LayoutRequest } from './protocol.js';

type AnyGraph = MultiDirectedGraph | UndirectedGraph;

/** Which nodes a run may move. */
export interface LayoutPlan {
  /** Ids allowed to move (never a pinned node). */
  movable: Set<string>;
}

/**
 * Plans a run.
 *
 * @param graph - The graph.
 * @param laidOut - Ids that already have a laid-out position.
 * @param options - `all` moves every unpinned node ("Re-layout all"); `carry` adds nodes an interrupted run left unsettled.
 * @returns The set of nodes that may move.
 */
export function planLayout(
  graph: AnyGraph,
  laidOut: ReadonlySet<string>,
  options: { all?: boolean; carry?: ReadonlySet<string> } = {},
): LayoutPlan {
  const movable = new Set<string>();
  graph.forEachNode((id, attrs) => {
    if (attrs.fixed === true) return;
    if (options.all || !laidOut.has(id) || options.carry?.has(id)) movable.add(id);
  });
  return { movable };
}

/**
 * Places a node that has no usable position on a ring around its parent, the
 * same golden-angle ring the explorer model uses.
 *
 * @param graph - The graph.
 * @param id - The node.
 * @param parentId - The node it hangs off.
 * @param index - Its index among the parent's new children.
 */
export function seedOnRing(graph: AnyGraph, id: string, parentId: string, index: number): void {
  const parent = graph.getNodeAttributes(parentId);
  const position = ringPosition(parent.x as number, parent.y as number, index);
  graph.mergeNodeAttributes(id, position);
}

/**
 * Builds the layout request for a plan. Every node outside `plan.movable` is
 * `fixed`.
 *
 * @param graph - The graph, with its current `x`, `y` and `size`.
 * @param plan - Which nodes may move.
 * @param budgetMs - The time box.
 * @param iterations - ForceAtlas2 iterations.
 * @returns The request, nodes in `graph.nodes()` order.
 */
export function buildLayoutRequest(
  graph: AnyGraph,
  plan: LayoutPlan,
  budgetMs: number,
  iterations: number = FA2_SETTLE_ITERATIONS,
): LayoutRequest {
  const nodes: LayoutNode[] = [];
  graph.forEachNode((id, attrs) => {
    nodes.push({
      id,
      x: attrs.x as number,
      y: attrs.y as number,
      fixed: !plan.movable.has(id),
      size: typeof attrs.size === 'number' ? attrs.size : 4,
    });
  });
  const edges: LayoutEdge[] = [];
  graph.forEachEdge((_edge, attrs, source, target) => {
    const weight = typeof attrs.weight === 'number' ? attrs.weight : 1;
    edges.push({ s: source, t: target, w: weight });
  });
  return {
    nodes,
    edges,
    budgetMs,
    settings: {
      iterations,
      linLogMode: false,
      barnesHutThreshold: BARNES_HUT_THRESHOLD,
      removeOverlap: true,
    },
  };
}

/**
 * Writes a run's positions back, MOVABLE NODES ONLY: a fixed node's attributes
 * are never touched, so an existing position is exactly what it was.
 *
 * @param graph - The graph.
 * @param request - The request the positions answer.
 * @param positions - `x0, y0, ...` in `request.nodes` order.
 * @returns The ids that were written.
 */
export function applyLayoutPositions(
  graph: AnyGraph,
  request: LayoutRequest,
  positions: Float32Array,
): string[] {
  const written: string[] = [];
  request.nodes.forEach((node, index) => {
    if (node.fixed || !graph.hasNode(node.id)) return;
    graph.mergeNodeAttributes(node.id, { x: positions[index * 2]!, y: positions[index * 2 + 1]! });
    written.push(node.id);
  });
  return written;
}

/** The position of every node, for comparisons. */
export function snapshotPositions(graph: AnyGraph): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  graph.forEachNode((id, attrs) => out.set(id, { x: attrs.x as number, y: attrs.y as number }));
  return out;
}
