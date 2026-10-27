/**
 * What the G6 canvas draws, as PURE functions of the graphology model (#775).
 *
 * NO G6 RUNTIME IMPORT (type imports only), so every rule is a plain unit test
 * and `GraphCanvas.tsx` stays the one file that loads `@antv/g6`:
 *
 *   - {@link buildCanvasData}: the visible nodes and edges as G6 data. Each
 *     datum carries its own style (position, size, colour, icon, label), so a
 *     theme change or a merge is one `setData`;
 *   - {@link computeElementStates}: the interaction state of every element
 *     (`dim`, `active`, `selected`, `seed`, `pinned`, `self`, `path`, `marked`,
 *     `labelled`, `nolabel`), derived from the SAME reducers the explorer has
 *     always used (`explorerReducers.ts`), plus the level-of-detail rule;
 *   - {@link nodeStateStyles} / {@link edgeStateStyles}: what each state looks like.
 *
 * The model keeps its units (radius `size`, model `curvature`, edge `size`);
 * the canvas maps them with `nodeDiameter`, `edgeCurveOffset` and
 * `edgeLineWidth` from `explorerEncoding.ts`.
 */

import type { EdgeData, GraphData, NodeData } from '@antv/g6';
import type { MultiDirectedGraph, UndirectedGraph } from 'graphology';

import {
  clusterDiameter,
  edgeCurveOffset,
  edgeLineWidth,
  LABEL_LOD_ZOOM,
  nodeDiameter,
  type ExplorerMode,
} from '../explorerEncoding.js';
import { DIM_OPACITY } from '../explorerModel.js';
import { activeFocus, buildEdgeReducer, buildNodeReducer, type ReducerContext } from '../explorerReducers.js';

type AnyGraph = MultiDirectedGraph | UndirectedGraph;
type Attributes = Record<string, unknown>;

/**
 * The theme tokens the canvas reads (from the MUI theme), so light and dark both read.
 *
 * @stability experimental
 */
export interface CanvasTheme {
  /** Which variant is drawn. */
  mode: ExplorerMode;
  /** The canvas ground and the label pill. */
  paper: string;
  /** Label text. */
  text: string;
  /** Edge label text. */
  textSecondary: string;
  /** Selection, seed and path accent. */
  accent: string;
  /** The ring of the user's own node. */
  self: string;
  /** Marked ("Select" mode) halo. */
  marked: string;
  /** The theme's font family. */
  fontFamily: string;
}

/** Nodes always draw above edges (an edge never runs over a label); node states stack above this. */
export const NODE_Z = 10;

/** The node label's font size in px, on screen. */
export const NODE_LABEL_FONT_SIZE = 12;
/** The edge label's font size in px. */
export const EDGE_LABEL_FONT_SIZE = 11;
/** How much of the node a pictogram covers. */
export const ICON_SCALE = 0.55;
/** An item (`nodeKind: 'item'`) is a rounded rectangle this much wider than tall. */
export const ITEM_ASPECT = 1.35;

const tinted = new Map<string, string>();

/** The node's icon in `iconColor`: the model's white data URL, re-filled when the colour differs. */
export function iconSource(image: unknown, iconColor: unknown): string | undefined {
  if (typeof image !== 'string' || !image) return undefined;
  if (typeof iconColor !== 'string' || iconColor.toLowerCase() === '#ffffff') return image;
  const prefix = 'data:image/svg+xml;base64,';
  if (!image.startsWith(prefix)) return image;
  const key = `${image}|${iconColor}`;
  const hit = tinted.get(key);
  if (hit) return hit;
  try {
    const svg = atob(image.slice(prefix.length)).replace(/fill="#ffffff"/gi, `fill="${iconColor}"`);
    const uri = prefix + btoa(svg);
    tinted.set(key, uri);
    return uri;
  } catch {
    return image;
  }
}

/** The drawn diameter of a node, in px: an overview cluster by its member count, anything else by the model's size. */
export function diameterOf(attrs: Attributes): number {
  if (typeof attrs.memberCount === 'number') return clusterDiameter(attrs.memberCount);
  return nodeDiameter(attrs.size as number | undefined, attrs.isSeed === true);
}

/** The zoom range over which label text keeps its screen size; beyond it the text scales with the camera. */
export const LABEL_SCREEN_ZOOM_RANGE: readonly [number, number] = [0.4, 2.5];

/**
 * The label styles (font, padding, offset, pill radius) that keep label text
 * at the same size ON SCREEN whatever the zoom: a canvas size of `px / zoom`.
 * The zoom is quantised (quarter steps of log2) so a pinch restyles a few
 * times, not on every frame, and clamped to {@link LABEL_SCREEN_ZOOM_RANGE}.
 */
export interface LabelScale {
  node: Record<string, unknown>;
  edge: Record<string, unknown>;
  /** `1 / zoom` (stepped and clamped): what a canvas length is multiplied by to stay the same on screen. */
  factor: number;
}

/** The label styles for a zoom. */
export function labelScale(zoom: number): LabelScale {
  const stepped = 2 ** (Math.round(Math.log2(Math.max(1e-3, zoom)) * 4) / 4);
  const z = Math.min(LABEL_SCREEN_ZOOM_RANGE[1], Math.max(LABEL_SCREEN_ZOOM_RANGE[0], stepped));
  const k = (value: number) => Math.round((value / z) * 100) / 100;
  return {
    factor: Math.round((1 / z) * 1000) / 1000,
    node: {
      labelFontSize: k(NODE_LABEL_FONT_SIZE),
      labelOffsetY: k(3),
      labelMaxWidth: k(180),
      labelBackgroundRadius: k(6),
      labelPadding: [k(1), k(6)],
      badgeFontSize: k(10),
      badgePadding: [k(1), k(4)],
    },
    edge: {
      labelFontSize: k(EDGE_LABEL_FONT_SIZE),
      labelBackgroundRadius: k(4),
      labelPadding: [k(1), k(4)],
    },
  };
}

const UNSCALED = labelScale(1);

/**
 * The drawn size of an overview cluster: its diameter kept constant ON SCREEN
 * (an overview is fitted far out, where a canvas-sized disc would shrink to a dot).
 */
export function clusterSize(memberCount: number, scale: LabelScale): number {
  return Math.round(clusterDiameter(memberCount) * scale.factor * 100) / 100;
}

/** One node as a G6 datum. */
export function toNodeDatum(id: string, attrs: Attributes, theme: CanvasTheme, scale: LabelScale = UNSCALED): NodeData {
  const diameter = diameterOf(attrs);
  const item = attrs.nodeKind === 'item';
  const label = typeof attrs.label === 'string' ? attrs.label : '';
  const icon = iconSource(attrs.image, attrs.iconColor);
  const stubCount = typeof attrs.stubCount === 'number' ? attrs.stubCount : null;
  const style: Record<string, unknown> = {
    x: typeof attrs.x === 'number' ? attrs.x : 0,
    y: typeof attrs.y === 'number' ? attrs.y : 0,
    size: item
      ? [Math.round(diameter * ITEM_ASPECT), diameter]
      : typeof attrs.memberCount === 'number'
        ? clusterSize(attrs.memberCount, scale)
        : diameter,
    fill: typeof attrs.color === 'string' ? attrs.color : theme.textSecondary,
    stroke: theme.paper,
    lineWidth: 1.5,
    labelText: label,
    labelPlacement: 'bottom',
    labelFill: theme.text,
    labelFontFamily: theme.fontFamily,
    labelWordWrap: false,
    // A pill in the paper colour, so text stays readable where an edge runs under it.
    labelBackground: true,
    labelBackgroundFill: theme.paper,
    labelBackgroundOpacity: 0.85,
    zIndex: NODE_Z,
    ...scale.node,
  };
  if (item) style.radius = 6;
  if (icon) {
    style.iconSrc = icon;
    style.iconWidth = Math.round(diameter * ICON_SCALE);
    style.iconHeight = Math.round(diameter * ICON_SCALE);
  } else {
    style.icon = false;
  }
  if (attrs.isStub === true && stubCount !== null) {
    style.badges = [{ text: `+${stubCount}`, placement: 'right-top' }];
    style.badgeFill = theme.paper;
    style.badgeBackgroundFill = theme.accent;
  }
  return {
    id,
    type: item ? 'rect' : 'circle',
    data: {
      diameter,
      label,
      entityType: attrs.entityType,
      isSeed: attrs.isSeed === true,
      isStub: attrs.isStub === true,
      isSelf: attrs.isSelf === true,
      ...(typeof attrs.memberCount === 'number' ? { memberCount: attrs.memberCount } : {}),
    },
    style,
  } as NodeData;
}

/** One edge as a G6 datum. An undirected graph (the overview's) draws no arrow head. */
export function toEdgeDatum(
  id: string,
  source: string,
  target: string,
  attrs: Attributes,
  theme: CanvasTheme,
  directed = true,
  scale: LabelScale = UNSCALED,
): EdgeData {
  const label = typeof attrs.label === 'string' ? attrs.label : '';
  const dashed = attrs.dashed === true || attrs.virtual === true;
  const style: Record<string, unknown> = {
    stroke: typeof attrs.color === 'string' ? attrs.color : theme.textSecondary,
    lineWidth: edgeLineWidth(attrs.size as number | undefined),
    curveOffset: edgeCurveOffset(attrs.curvature as number | undefined),
    endArrow: directed,
    endArrowSize: 7,
    label: false,
    labelText: label,
    labelFill: theme.textSecondary,
    labelFontFamily: theme.fontFamily,
    labelBackground: true,
    labelBackgroundFill: theme.paper,
    labelBackgroundOpacity: 0.9,
    labelAutoRotate: false,
    zIndex: 0,
    ...scale.edge,
  };
  if (dashed) style.lineDash = [6, 4];
  return { id, source, target, type: 'quadratic', data: { relationType: attrs.relationType, label }, style } as EdgeData;
}

/**
 * The G6 data of the visible part of a graph: every node in `visibleIds`, and
 * every edge whose two ends are visible.
 */
export function buildCanvasData(
  graph: AnyGraph,
  visibleIds: ReadonlySet<string>,
  theme: CanvasTheme,
  scale: LabelScale = UNSCALED,
): GraphData {
  const nodes: NodeData[] = [];
  graph.forEachNode((id, attrs) => {
    if (visibleIds.has(id)) nodes.push(toNodeDatum(id, attrs as Attributes, theme, scale));
  });
  const edges: EdgeData[] = [];
  const directed = graph.type !== 'undirected';
  graph.forEachEdge((id, attrs, source, target) => {
    if (visibleIds.has(source) && visibleIds.has(target)) {
      edges.push(toEdgeDatum(id, source, target, attrs as Attributes, theme, directed, scale));
    }
  });
  return { nodes, edges };
}

/**
 * What decides the element states: the reducer context, the zoom and the
 * level-of-detail threshold.
 *
 * @stability experimental
 */
export interface StateContext extends Omit<ReducerContext, 'accent' | 'dimColor'> {
  /** The current zoom (1 = 100%). */
  zoom: number;
  /** Below this zoom only the labels that matter are drawn; default {@link LABEL_LOD_ZOOM}. */
  lodZoom?: number;
  /** With at most this many visible nodes the level-of-detail rule is off (every label stays); default 0. */
  lodMinNodes?: number;
}

/** States per element id, ready for `graph.setElementState`. */
export interface ElementStates {
  nodes: Record<string, string[]>;
  edges: Record<string, string[]>;
}

/**
 * The state of every visible element, from the explorer's reducers.
 *
 * The reducer output is read back as states: a changed colour is `dim`;
 * `highlighted` is `active`; the ring precedence of `ringFor` (selected, then
 * seed, then pinned) picks one of `selected` / `seed` / `pinned`; a lit
 * neighbourhood, a stub, a forced label and the path are `labelled`; below the
 * LOD zoom everything else is `nolabel`. A node with `isSelf` gets `self` and
 * always keeps its label. An edge with a label is `labelled`, a path edge `path`.
 */
export function computeElementStates(ctx: StateContext): ElementStates {
  const reducerContext: ReducerContext = { ...ctx, accent: '#000000', dimColor: '#000000' };
  const nodeReducer = buildNodeReducer(reducerContext);
  const edgeReducer = buildEdgeReducer(reducerContext);
  const lod = ctx.visibleIds.size > (ctx.lodMinNodes ?? 0) && ctx.zoom < (ctx.lodZoom ?? LABEL_LOD_ZOOM);
  const focus = activeFocus(ctx);
  const nodes: Record<string, string[]> = {};
  const edges: Record<string, string[]> = {};

  ctx.graph.forEachNode((id, raw) => {
    const data = raw as Attributes;
    const out = nodeReducer(id, data);
    if (out.hidden === true) return;
    const states: string[] = [];
    const dim = out.color !== data.color;
    const self = data.isSelf === true;
    const onPath = ctx.pathNodeIds?.has(id) === true;
    if (dim) states.push('dim');
    if (out.highlighted === true) states.push(ctx.markedIds?.has(id) === true && id !== focus ? 'marked' : 'active');
    if (!dim) {
      if (id === ctx.selectedId) states.push('selected');
      else if (data.isSeed === true) states.push('seed');
      else if (data.fixed === true) states.push('pinned');
      if (onPath) states.push('path');
    }
    if (self) states.push('self');
    const important =
      self || id === ctx.selectedId || data.isSeed === true || onPath || out.forceLabel === true || data.forceLabel === true;
    if (dim && !self) states.push('nolabel');
    else if (important) states.push('labelled');
    else if (lod) states.push('nolabel');
    nodes[id] = states;
  });

  ctx.graph.forEachEdge((id, raw) => {
    const data = raw as Attributes;
    const out = edgeReducer(id, data);
    if (out.hidden === true) return;
    const states: string[] = [];
    if (out.color !== data.color) states.push('dim');
    if (ctx.hoveredEdgeId === id) states.push('active');
    if (ctx.pathEdgeIds?.has(id) === true && out.color === data.color) states.push('path');
    if (typeof out.label === 'string' && out.label) states.push('labelled');
    edges[id] = states;
  });
  return { nodes, edges };
}

/** The look of each node state. Later states in an element's list win. */
export function nodeStateStyles(theme: CanvasTheme): Record<string, Record<string, unknown>> {
  return {
    dim: { opacity: DIM_OPACITY + 0.1, zIndex: NODE_Z - 1 },
    nolabel: { label: false },
    labelled: { label: true },
    active: { halo: true, haloStroke: theme.text, haloOpacity: 0.18, haloLineWidth: 12, zIndex: NODE_Z + 3 },
    marked: { halo: true, haloStroke: theme.marked, haloOpacity: 0.45, haloLineWidth: 10, zIndex: NODE_Z + 4 },
    path: { halo: true, haloStroke: theme.accent, haloOpacity: 0.3, haloLineWidth: 10, zIndex: NODE_Z + 3 },
    seed: { stroke: theme.accent, lineWidth: 4, zIndex: NODE_Z + 2 },
    pinned: { stroke: theme.accent, lineWidth: 2, lineDash: [3, 2] },
    selected: {
      stroke: theme.accent,
      lineWidth: 3,
      halo: true,
      haloStroke: theme.accent,
      haloOpacity: 0.35,
      haloLineWidth: 12,
      zIndex: NODE_Z + 5,
    },
    self: { stroke: theme.self, lineWidth: 4, label: true, zIndex: NODE_Z + 4 },
  };
}

/** The look of each edge state. */
export function edgeStateStyles(theme: CanvasTheme): Record<string, Record<string, unknown>> {
  return {
    dim: { opacity: DIM_OPACITY, zIndex: 0 },
    labelled: { label: true, zIndex: 1 },
    active: { halo: true, haloStroke: theme.text, haloOpacity: 0.15, haloLineWidth: 8, label: true, zIndex: 2 },
    path: { lineWidth: 4, stroke: theme.accent, label: true, zIndex: 2 },
  };
}
