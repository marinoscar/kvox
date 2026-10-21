/**
 * The canvas's `nodeReducer` and `edgeReducer` (#667, epic #661), as pure
 * builders. NO SIGMA IMPORT, so a unit test drives them with a plain graphology
 * graph, and `GraphCanvas` only hands the result to `setSettings`.
 *
 * WHY REDUCERS. Sigma lets a reducer change how a node or edge DRAWS without
 * touching the graph. Hover, first tap, selection and rings are all view state
 * that changes many times a second; writing them into node attributes would
 * mutate the model on every mouse move and make the model depend on the view.
 * So the graph holds only facts (type, size, colour, `isSeed`, `fixed`), and the
 * reducers add what the current interaction says.
 *
 * The rules, each pinned by `explorerReducers.test.ts`:
 *   - nothing outside `visibleIds` is drawn;
 *   - with a FOCUS (hover, else first tap, else selection) the focus, its
 *     neighbours and the edges between them are lit and labelled, and everything
 *     else is dimmed to `DIM_OPACITY` — dimmed, never hidden;
 *   - the focus's own edges, and any hovered edge, show their label; no other
 *     edge ever does;
 *   - a seed, a pinned and the selected node get a ring, each a different shape
 *     (`ringFor`);
 *   - a node with a pictogram draws with the `pictogram` program, an edge with a
 *     curvature with the `curvedArrow` one. A graph with neither (the overview's)
 *     draws exactly as before.
 */

import { alpha } from '@mui/material/styles';
import type { MultiDirectedGraph, UndirectedGraph } from 'graphology';

import { DIM_OPACITY, highlightSet, type HighlightSet } from './explorerModel.js';
import { ringFor } from './explorerEncoding.js';

/** The names of the node and edge programs `GraphCanvas` registers. */
export const PICTOGRAM_PROGRAM = 'pictogram';
export const CURVED_ARROW_PROGRAM = 'curvedArrow';

/** Above this many incident edges, a focus does not label them (a hub would paint a wall of text). */
export const MAX_FOCUS_EDGE_LABELS = 12;

type Display = Record<string, unknown>;

/** What a reducer reads. */
export interface ReducerContext {
  /** The graph being drawn (the explorer's or the overview's). */
  graph: MultiDirectedGraph | UndirectedGraph;
  /** Ids to draw; every other node is hidden. */
  visibleIds: ReadonlySet<string>;
  /** The inspector's node. */
  selectedId: string | null;
  /** The node under the pointer, or the one a first tap lit. */
  focusId: string | null;
  /** The edge under the pointer. */
  hoveredEdgeId?: string | null;
  /** Nodes marked in "Select" mode: drawn highlighted and never dimmed. */
  markedIds?: ReadonlySet<string>;
  /** Ring colour. */
  accent: string;
  /** Fallback for a colour `alpha()` cannot parse. */
  dimColor: string;
  /** Compact window: the seeds and the focus keep their labels while others thin out. */
  compact?: boolean;
}

/** `colour` at `DIM_OPACITY`; `fallback` when the string is not a colour MUI can read. */
export function dimmed(color: unknown, fallback: string): string {
  if (typeof color !== 'string') return fallback;
  try {
    return alpha(color, DIM_OPACITY);
  } catch {
    return fallback;
  }
}

/** The focus that drives highlighting: hover or first tap, else the selection. */
export function activeFocus(ctx: Pick<ReducerContext, 'focusId' | 'selectedId'>): string | null {
  return ctx.focusId ?? ctx.selectedId;
}

/** Builds the `nodeReducer` for the current interaction. */
export function buildNodeReducer(ctx: ReducerContext): (node: string, data: Display) => Display {
  const focus = activeFocus(ctx);
  const lit: HighlightSet | null = highlightSet(ctx.graph, focus);
  return (node, data) => {
    if (!ctx.visibleIds.has(node)) return { ...data, hidden: true };

    const out: Display = { ...data };
    if (typeof data.image === 'string' && data.image) out.type = PICTOGRAM_PROGRAM;

    const ring = ringFor({
      isSeed: data.isSeed === true,
      pinned: data.fixed === true,
      selected: node === ctx.selectedId,
    });
    if (ring) {
      out.ringSize = ring.ringSize;
      out.gapSize = ring.gapSize;
      out.ringColor = ctx.accent;
    }

    const isStub = data.isStub === true;
    const marked = ctx.markedIds?.has(node) === true;
    if (marked) {
      out.highlighted = true;
      out.zIndex = 4;
    }
    if (!lit) {
      if (isStub || (ctx.compact && data.isSeed === true)) out.forceLabel = true;
      return out;
    }
    if (marked) {
      out.forceLabel = true;
      return out;
    }
    if (lit.nodes.has(node)) {
      out.forceLabel = true;
      out.zIndex = node === focus ? 3 : 2;
      if (node === focus) out.highlighted = true;
      return out;
    }
    out.color = dimmed(data.color, ctx.dimColor);
    if (typeof data.iconColor === 'string') out.iconColor = dimmed(data.iconColor, ctx.dimColor);
    out.label = '';
    out.ringSize = 0;
    out.gapSize = 0;
    out.zIndex = 0;
    return out;
  };
}

/** Builds the `edgeReducer` for the current interaction. */
export function buildEdgeReducer(ctx: ReducerContext): (edge: string, data: Display) => Display {
  const focus = activeFocus(ctx);
  const lit = highlightSet(ctx.graph, focus);
  const labelFocusEdges = lit !== null && lit.edges.size <= MAX_FOCUS_EDGE_LABELS;
  return (edge, data) => {
    const [source, target] = ctx.graph.extremities(edge);
    if (!ctx.visibleIds.has(source) || !ctx.visibleIds.has(target)) return { ...data, hidden: true };

    const out: Display = { ...data, label: '' };
    if (typeof data.curvature === 'number' && data.curvature !== 0) out.type = CURVED_ARROW_PROGRAM;

    const hovered = ctx.hoveredEdgeId === edge;
    if (hovered || (labelFocusEdges && lit!.edges.has(edge))) {
      out.label = typeof data.label === 'string' ? data.label : '';
    }
    if (hovered) out.zIndex = 3;

    if (!lit) return out;
    if (lit.nodes.has(source) && lit.nodes.has(target)) {
      out.zIndex = Math.max(Number(out.zIndex ?? 0), lit.edges.has(edge) ? 2 : 1);
      return out;
    }
    out.color = dimmed(data.color, ctx.dimColor);
    out.label = hovered && typeof data.label === 'string' ? data.label : '';
    out.zIndex = 0;
    return out;
  };
}
