/**
 * The overview → explorer hand-off (#374 ⇄ #375; spec §22.3).
 *
 * A ONE-SHOT, IN-MEMORY store: #375's overview sets it with a cluster's
 * already-loaded nodes (at their overview positions) and navigates to
 * `/graph/explore?cluster=<id>`; the explorer takes it once and renders those
 * nodes immediately, then one expand adds their edges and neighbours. Nothing
 * is persisted — a reload has no hand-off, and the explorer says so.
 *
 * ⚠ A STABLE INTERFACE: #375 builds against these two functions.
 *
 * @stability experimental
 */

export interface ExplorerHandoffNode {
  /** Entity id (UUID). */
  id: string;
  /** Display name. */
  label: string;
  /** Entity type key. */
  type: string;
  /** Horizontal position the node had in the overview. */
  x: number;
  /** Vertical position the node had in the overview. */
  y: number;
  /** Number of relations the entity has in the whole graph, used for its size. */
  degree: number;
}

/**
 * What the overview passes to the explorer: the cluster's seeds and its already-loaded nodes.
 *
 * @stability experimental
 */
export interface ExplorerHandoff {
  /** At most 50 — #370's cap on one expand's `nodeIds`. */
  seedIds: string[];
  /** Heading the explorer shows for the hand-off, such as the cluster's label. */
  title?: string;
  /** The cluster's nodes, at their overview positions. */
  nodes: ExplorerHandoffNode[];
}

const MAX_SEEDS = 50;

let pending: ExplorerHandoff | null = null;

/**
 * Stores the hand-off for the explorer to take, replacing any earlier one.
 *
 * @stability experimental
 */
export function setExplorerHandoff(handoff: ExplorerHandoff): void {
  pending = {
    seedIds: handoff.seedIds.slice(0, MAX_SEEDS),
    title: handoff.title,
    nodes: [...handoff.nodes],
  };
}

/**
 * Returns the hand-off and clears it: a second call gets `null`.
 *
 * @stability experimental
 */
export function takeExplorerHandoff(): ExplorerHandoff | null {
  const taken = pending;
  pending = null;
  return taken;
}

/**
 * Look without taking — for a render that must not consume it twice under StrictMode.
 *
 * @stability experimental
 */
export function peekExplorerHandoff(): ExplorerHandoff | null {
  return pending;
}
