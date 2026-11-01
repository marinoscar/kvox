/**
 * The canvas layouts (#775), as plain G6 layout options. PURE: no G6 runtime
 * import, so the options are unit tests.
 *
 * The public mode names stay what the explorer has always offered (`?layout=`):
 *
 * | mode         | G6 layout   | moves                                             |
 * | ------------ | ----------- | ------------------------------------------------- |
 * | `forceatlas` | `d3-force`  | only new nodes; every laid-out node is fixed      |
 * | `concentric` | `radial`    | every unpinned node, in rings around the seed     |
 * | `static`     | none        | nothing: the model's own `x`/`y`                  |
 *
 * ⚠ NEVER `enableWorker`. G6 would spawn its layout worker from a `blob:` URL,
 * and the production and Desktop CSPs (`worker-src 'self'`, no `blob:`) refuse
 * it. Every layout runs on the main thread, time-boxed by its iteration count.
 */

import type { MultiDirectedGraph, UndirectedGraph } from 'graphology';

import { DEFAULT_LAYOUT_TIME_BOX_MS } from '../shell/explorerBudgets.js';

type AnyGraph = MultiDirectedGraph | UndirectedGraph;

/**
 * The layouts the canvas offers.
 *
 * @stability experimental
 */
export type CanvasLayout = 'forceatlas' | 'concentric' | 'static';

/** Room kept under a node for its label when nodes are pushed apart, in px. */
export const LABEL_CLEARANCE_PX = 14;

/** The d3-force ticks of a run with the full time box; a shorter box runs proportionally fewer. */
export const FORCE_SETTLE_ITERATIONS = 300;

/** The fewest ticks a run gets, however short its box (a phone still untangles a little). */
export const FORCE_MIN_ITERATIONS = 80;

/** Distance of one ring of the radial (`concentric`) layout, in px. */
export const RADIAL_UNIT_RADIUS = 150;

/** The G6 node datum the layout callbacks receive (only the part read here). */
interface LayoutNodeLike {
  data?: { diameter?: unknown } | null;
}

/** A node's collision radius: half its diameter plus room for its label. */
export function collideRadius(node: LayoutNodeLike): number {
  const diameter = typeof node?.data?.diameter === 'number' ? (node.data.diameter as number) : 30;
  return diameter / 2 + LABEL_CLEARANCE_PX;
}

/** The ticks a run gets for a time box: {@link FORCE_SETTLE_ITERATIONS} at the default box, scaled down for a shorter one. */
export function forceIterations(budgetMs: number = DEFAULT_LAYOUT_TIME_BOX_MS): number {
  const share = Math.min(1, Math.max(0, budgetMs / DEFAULT_LAYOUT_TIME_BOX_MS));
  return Math.max(FORCE_MIN_ITERATIONS, Math.round(FORCE_SETTLE_ITERATIONS * share));
}

/**
 * The `d3-force` options: links pull, nodes repel, `collide` keeps discs and
 * labels apart. No centring force: with laid-out nodes fixed, a centre force
 * would drag the new ones away from their parent.
 */
export function forceLayoutOptions(budgetMs?: number): Record<string, unknown> {
  return {
    type: 'd3-force',
    animation: false,
    iterations: forceIterations(budgetMs),
    center: false,
    link: { distance: 120, strength: 0.6 },
    manyBody: { strength: -320, distanceMax: 600 },
    collide: { radius: collideRadius, strength: 1, iterations: 2 },
  };
}

/** The `radial` options of the concentric mode: the first seed on the canvas in the middle. */
export function radialLayoutOptions(
  graph: AnyGraph,
  seedIds: readonly string[] = [],
  budgetMs?: number,
): Record<string, unknown> {
  const focus = seedIds.find((id) => graph.hasNode(id)) ?? null;
  const short = (budgetMs ?? DEFAULT_LAYOUT_TIME_BOX_MS) < DEFAULT_LAYOUT_TIME_BOX_MS;
  return {
    type: 'radial',
    animation: false,
    focusNode: focus,
    unitRadius: RADIAL_UNIT_RADIUS,
    linkDistance: RADIAL_UNIT_RADIUS,
    preventOverlap: true,
    strictRadial: false,
    maxPreventOverlapIteration: short ? 80 : 200,
    nodeSize: (node: LayoutNodeLike) => collideRadius(node) * 2,
  };
}

/**
 * Which nodes a run may move (never a pinned one).
 *
 * @param graph - The graph.
 * @param laidOut - Ids that already have a laid-out position.
 * @param options - `all` moves every unpinned node ("Re-layout all", a change of layout).
 * @returns The ids allowed to move.
 */
export function movableNodes(
  graph: AnyGraph,
  laidOut: ReadonlySet<string>,
  options: { all?: boolean } = {},
): Set<string> {
  const movable = new Set<string>();
  graph.forEachNode((id, attrs) => {
    if (attrs.fixed === true) return;
    if (options.all || !laidOut.has(id)) movable.add(id);
  });
  return movable;
}

/** What the canvas needs to know to decide a run. */
export interface LayoutDecisionInput {
  layout: CanvasLayout;
  /** The layout of the previous run, `null` before the first. */
  previous: CanvasLayout | null;
  /** "Re-layout all" was asked since the previous run. */
  relayout: boolean;
  /** How many nodes may move. */
  movable: number;
}

/** Whether a sync runs a layout at all: never for `static`, and only when something may move. */
export function shouldRunLayout(input: LayoutDecisionInput): boolean {
  if (input.layout === 'static') return false;
  return input.movable > 0;
}

/** Whether the run moves every unpinned node rather than only the new ones. */
export function movesEverything(input: Pick<LayoutDecisionInput, 'layout' | 'previous' | 'relayout'>): boolean {
  return input.relayout || (input.previous !== null && input.previous !== input.layout) || input.layout === 'concentric';
}

