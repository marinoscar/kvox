/**
 * Explorer history (GIC-17, #678): the bounded Undo / Redo stack.
 *
 * A SNAPSHOT is what Undo needs to put the explorer back: the graph (membership,
 * edges and positions), which nodes are seeds or expanded, the filters and the
 * `as of` date. Focus (the selected node) lives in the URL and the focus trail
 * (`useFocusTrail`), not here. Pure and framework-free: `useGraphExplorer` owns
 * WHEN a snapshot is taken.
 *
 * The stack holds at most {@link HISTORY_LIMIT} undo steps; the oldest is dropped.
 * A new step clears Redo. Snapshots share their attribute strings (pictogram
 * `data:` URLs) with the live graph, so fifty of them cost the structure only.
 */

import type { ExplorerGraph, ExplorerState } from '../explorerModel.js';

/**
 * Most Undo steps kept; older ones are dropped.
 *
 * @stability experimental
 */
export const HISTORY_LIMIT = 50;

/**
 * The explorer as it was before one step.
 *
 * @stability experimental
 */
export interface ExplorerSnapshot {
  /** The graph, serialised: nodes, edges and their attributes (positions included). */
  graph: ReturnType<ExplorerGraph['export']>;
  /** Ids the exploration starts from. */
  seedIds: string[];
  /** Nodes whose neighbourhood was requested. */
  expanded: string[];
  /** Node types hidden by the filters. */
  hiddenTypes: string[];
  /** Relation types hidden by the filters. */
  hiddenRelationTypes: string[];
  /** The `as of` date, or `null` for now. */
  asOf: string | null;
  /** Whether the slice was cut off. */
  truncated: boolean;
}

/**
 * What the page must mirror into the URL after an Undo or Redo: the filters and seeds the restored snapshot carries.
 *
 * @stability experimental
 */
export interface RestoredView {
  /** Seed ids of the restored snapshot. */
  seedIds: string[];
  /** Hidden node types of the restored snapshot. */
  hiddenTypes: string[];
  /** Hidden relation types of the restored snapshot. */
  hiddenRelationTypes: string[];
  /** The `as of` date of the restored snapshot. */
  asOf: string | null;
}

/**
 * The two halves of the history.
 *
 * @stability experimental
 */
export interface HistoryStacks {
  /** Snapshots Undo steps back to, oldest first. */
  past: ExplorerSnapshot[];
  /** Snapshots Redo steps forward to, next one last. */
  future: ExplorerSnapshot[];
}

/** An empty history. */
export function emptyHistory(): HistoryStacks {
  return { past: [], future: [] };
}

/** Captures the explorer's current state. */
export function takeSnapshot(state: ExplorerState): ExplorerSnapshot {
  return {
    graph: state.graph.export(),
    seedIds: [...state.seedIds],
    expanded: [...state.expanded],
    hiddenTypes: [...state.hiddenTypes],
    hiddenRelationTypes: [...state.hiddenRelationTypes],
    asOf: state.asOf,
    truncated: state.truncated,
  };
}

/** Puts a snapshot back into `state`, in place (the canvas holds the graph object). */
export function restoreSnapshot(state: ExplorerState, snapshot: ExplorerSnapshot): RestoredView {
  state.graph.clear();
  state.graph.import(snapshot.graph);
  state.seedIds = [...snapshot.seedIds];
  state.expanded = new Set(snapshot.expanded);
  state.hiddenTypes = new Set(snapshot.hiddenTypes);
  state.hiddenRelationTypes = new Set(snapshot.hiddenRelationTypes);
  state.asOf = snapshot.asOf;
  state.truncated = snapshot.truncated;
  return {
    seedIds: [...snapshot.seedIds],
    hiddenTypes: [...snapshot.hiddenTypes],
    hiddenRelationTypes: [...snapshot.hiddenRelationTypes],
    asOf: snapshot.asOf,
  };
}

/** A new step: `before` becomes the next Undo, and Redo is cleared. Returns the (bounded) history. */
export function pushStep(history: HistoryStacks, before: ExplorerSnapshot): HistoryStacks {
  const past = [...history.past, before];
  while (past.length > HISTORY_LIMIT) past.shift();
  return { past, future: [] };
}

/**
 * One Undo: the last step comes off `past`, and `current` goes onto `future`.
 *
 * @returns The snapshot to restore and the new history, or `null` when there is nothing to undo.
 */
export function stepBack(
  history: HistoryStacks,
  current: ExplorerSnapshot,
): { restore: ExplorerSnapshot; history: HistoryStacks } | null {
  const restore = history.past[history.past.length - 1];
  if (!restore) return null;
  const future = [...history.future, current];
  while (future.length > HISTORY_LIMIT) future.shift();
  return { restore, history: { past: history.past.slice(0, -1), future } };
}

/**
 * One Redo: the next step comes off `future`, and `current` goes back onto `past`.
 *
 * @returns The snapshot to restore and the new history, or `null` when there is nothing to redo.
 */
export function stepForward(
  history: HistoryStacks,
  current: ExplorerSnapshot,
): { restore: ExplorerSnapshot; history: HistoryStacks } | null {
  const restore = history.future[history.future.length - 1];
  if (!restore) return null;
  const past = [...history.past, current];
  while (past.length > HISTORY_LIMIT) past.shift();
  return { restore, history: { past, future: history.future.slice(0, -1) } };
}
