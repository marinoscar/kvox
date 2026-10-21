/**
 * The message protocol between the explorer canvas and `layout.worker.ts`
 * (GIC-07, #668). Plain structured-clone data; the progress frames carry their
 * positions in a transferable `Float32Array`.
 */

/** A node as the layout sees it. */
export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  /** A fixed node keeps its position exactly. */
  fixed: boolean;
  /** Drawn size, used by `adjustSizes` and the overlap pass. */
  size: number;
}

/** An edge as the layout sees it: end ids and a weight. */
export interface LayoutEdge {
  s: string;
  t: string;
  w: number;
}

/** Tunables of one run. */
export interface LayoutSettings {
  /** Total ForceAtlas2 iterations the run may perform. */
  iterations: number;
  /** Tighter clusters. */
  linLogMode: boolean;
  /** Barnes-Hut approximation switches on above this node count. */
  barnesHutThreshold: number;
  /** Run the final noverlap pass. */
  removeOverlap: boolean;
}

/** One layout run. */
export interface LayoutRequest {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  settings: LayoutSettings;
  /** The run stops, and the layout is kept, after this many milliseconds. */
  budgetMs: number;
}

/** What a finished run reports. */
export interface LayoutResult {
  /** `x0, y0, x1, y1, ...` in `request.nodes` order. */
  positions: Float32Array;
  /** ForceAtlas2 iterations performed. */
  iterations: number;
  /** The time box cut the run short. */
  timedOut: boolean;
}

/** Messages the page sends to the worker. */
export type LayoutWorkerInbound = { type: 'run'; request: LayoutRequest } | { type: 'cancel' };

/** Messages the worker sends back. */
export type LayoutWorkerOutbound =
  | { type: 'frame'; positions: Float32Array }
  | ({ type: 'done' } & LayoutResult)
  | { type: 'error'; message: string };
