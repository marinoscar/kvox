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
 */

export interface ExplorerHandoffNode {
  id: string;
  label: string;
  type: string;
  x: number;
  y: number;
  degree: number;
}

export interface ExplorerHandoff {
  /** At most 50 — #370's cap on one expand's `nodeIds`. */
  seedIds: string[];
  title?: string;
  nodes: ExplorerHandoffNode[];
}

const MAX_SEEDS = 50;

let pending: ExplorerHandoff | null = null;

export function setExplorerHandoff(handoff: ExplorerHandoff): void {
  pending = {
    seedIds: handoff.seedIds.slice(0, MAX_SEEDS),
    title: handoff.title,
    nodes: [...handoff.nodes],
  };
}

/** Returns the hand-off and clears it: a second call gets `null`. */
export function takeExplorerHandoff(): ExplorerHandoff | null {
  const taken = pending;
  pending = null;
  return taken;
}

/** Look without taking — for a render that must not consume it twice under StrictMode. */
export function peekExplorerHandoff(): ExplorerHandoff | null {
  return pending;
}
