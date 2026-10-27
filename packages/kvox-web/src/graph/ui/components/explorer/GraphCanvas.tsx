/**
 * `GraphCanvas` — the ONE file that imports `@antv/g6` (#775; was sigma, #374).
 *
 * Generic on purpose, so the explorer, the whole-graph overview and the entity
 * page's neighbourhood widget share it: it draws the graphology graph it is
 * given (`x`, `y`, `size`, `color`, `label`, `image` written by `explorerModel`
 * or the overview's model) and computes no styling of its own beyond the
 * mapping in `g6/canvasData.ts`. What it adds:
 *
 *   - element STATES from the explorer's reducers (`explorerReducers.ts`): the
 *     hovered node (on a touch screen, the first-tapped one, else the
 *     selection) lights up with its neighbours and the rest dims; rings for
 *     seed, pin, selection and the user's own node; labels by level of detail
 *     (`LABEL_LOD_ZOOM`);
 *   - the camera: wheel and pinch zoom (`zoom-canvas`, range 0.1 to 6), pan
 *     (`drag-canvas`), drag a node to pin it (`drag-element`), a fit after the
 *     first draw and after every layout UNLESS the user has moved the camera
 *     since (`g6/viewport.ts`), and the on-screen `ZoomControls`;
 *   - the layouts (`layout/canvasLayouts.ts`): `forceatlas` runs an
 *     INCREMENTAL `d3-force` (laid-out nodes fixed with `fx`/`fy`, only new ones
 *     move), `concentric` a `radial` around the first seed, `static` none;
 *   - plugins: `minimap` (into `minimapContainer`, never on a compact window)
 *     and `tooltip` (fine pointers only).
 *
 * ⚠ CSP. G6 draws with its Canvas renderer (no WebGL, no `eval`). NEVER set
 * `enableWorker` on a layout: G6 would start a `blob:` worker, which the
 * production and Desktop CSPs refuse. Icons are `data:` URLs; no remote asset.
 *
 * ⚠ BUNDLE. G6 is about 410 KB gzipped: this module is reached only through
 * the dynamic `import()` in `canvasLoaders.ts`, so `graph/headless` and
 * `graph/ui` load without it (`@antv/g6` is an optional peer).
 *
 * ⚠ REACT 19 STRICT MODE mounts, unmounts and mounts again: the G6 instance is
 * created in a microtask and skipped when the cleanup already ran; the cleanup
 * disconnects the `ResizeObserver` and destroys the instance.
 *
 * jsdom has no canvas: the tests replace `@antv/g6` with a fake `Graph`.
 *
 * THE TOUCH MODEL (GIC-08, #669; the pure parts are `shell/canvasGestures.ts`):
 *   - `touch-action: none` on THIS element only;
 *   - the first tap on a node previews it (`previewId`), the second activates
 *     it; `onNodeClick` fires on every tap and the PAGE decides which it is;
 *   - a 500ms long-press on a node opens the context menu and arms dragging, so
 *     a node is only pinned by long-press then drag, never while panning;
 *   - on a coarse pointer a tap within `budgets.hitTargetPx / 2` of a node hits it;
 *   - `revealInsets` is the part of the canvas the inspector covers: selecting a
 *     node pans it into the rest.
 */

import { Graph } from '@antv/g6';
import Box from '@mui/material/Box';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import type { MultiDirectedGraph, UndirectedGraph } from 'graphology';
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';

import { LassoBehaviour, type LassoTarget } from './connect/LassoBehaviour.js';
import { LABEL_LOD_MIN_NODES, LABEL_LOD_ZOOM, LABEL_LOD_ZOOM_REDUCED } from './explorerEncoding.js';
import { humanizeKey } from '../../../headless/utils/graphDisplay.js';
import {
  buildCanvasData,
  clusterSize,
  computeElementStates,
  diameterOf,
  edgeStateStyles,
  labelScale,
  nodeStateStyles,
  type CanvasTheme,
} from './g6/canvasData.js';
import {
  CAMERA_ANIMATION_MS,
  ZOOM_RANGE,
  ZOOM_STEP,
  cappedPixelRatio,
  createCameraTracker,
  fitTransform,
  unionBounds,
  zoomBucket,
  type Bounds,
} from './g6/viewport.js';
import {
  forceLayoutOptions,
  movableNodes,
  movesEverything,
  radialLayoutOptions,
  shouldRunLayout,
  type CanvasLayout,
} from './layout/canvasLayouts.js';
import { usePins } from './layout/usePins.js';
import { isLive, markDrawn, syncSize, zoomOf } from './g6/lifecycle.js';
import { DEFAULT_LAYOUT_TIME_BOX_MS, type ExplorerBudgets } from './shell/explorerBudgets.js';
import {
  createLongPress,
  pickNearestNode,
  revealDelta,
  type Insets,
  type LongPress,
} from './shell/canvasGestures.js';
import { useReducedMotion } from './shell/useReducedMotion.js';
import { MINIMAP_HEIGHT, MINIMAP_WIDTH } from './ExplorerMinimap.js';
import { ZoomControls } from './ZoomControls.js';

/**
 * Any graph the canvas can draw (the explorer's directed multigraph, the overview's undirected one).
 *
 * @stability experimental
 */
export type GraphCanvasGraph = MultiDirectedGraph | UndirectedGraph;

export { FORCE_SETTLE_ITERATIONS } from './layout/canvasLayouts.js';

/**
 * Imperative controls the canvas hands to its toolbar and keyboard handler.
 *
 * @stability experimental
 */
export interface GraphCanvasControls {
  /** Zoom the camera in one step. */
  zoomIn: () => void;
  /** Zoom the camera out one step. */
  zoomOut: () => void;
  /** Animated fit of every visible node — "Fit" (and the `0` key). */
  fit: () => void;
  /** Moves every unpinned node again ("Re-layout all"). */
  relayoutAll: () => void;
  /** Pins a node where it is, or unpins it. */
  togglePin: (id: string) => void;
  /** Releases every pin. */
  unpinAll: () => void;
  /** Whether a node is pinned. */
  isPinned: (id: string) => boolean;
  /** The camera: the graph point at the centre of the canvas and the zoom ratio (`1 / zoom`). */
  getCamera?: () => CameraSnapshot;
  /** Puts the camera back exactly, without animation. */
  setCamera?: (camera: CameraSnapshot) => void;
  /** Animates the camera to frame these nodes (path mode's "Show on canvas"); ids not on the canvas are ignored. */
  fitTo?: (ids: readonly string[]) => void;
  /** Flies the camera to a node and zooms in to it (the palette's "On canvas" result); a no-op for a node that is not drawn. */
  focusNode?: (id: string) => void;
  /** The rectangle the canvas shows, in graph coordinates, or `null` before the first frame. */
  getViewport?: () => CanvasViewport | null;
  /** Centres the camera on a point in graph coordinates, without changing the zoom. */
  panToGraph?: (x: number, y: number) => void;
  /** Calls `listener` after every frame the canvas draws (camera moves and layouts); returns the unsubscribe function. */
  onFrame?: (listener: () => void) => () => void;
}

/**
 * A point in graph coordinates (the `x` and `y` attributes of the nodes).
 *
 * @stability experimental
 */
export interface CanvasPoint {
  /** Horizontal position in graph coordinates. */
  x: number;
  /** Vertical position in graph coordinates. */
  y: number;
}

/**
 * The part of the graph the canvas shows, as the two opposite corners of its viewport in graph coordinates.
 *
 * @stability experimental
 */
export interface CanvasViewport {
  /** The graph point under the canvas's top-left corner. */
  topLeft: CanvasPoint;
  /** The graph point under the canvas's bottom-right corner. */
  bottomRight: CanvasPoint;
}

/**
 * The camera's state: the centre in graph coordinates and the zoom ratio.
 *
 * @stability experimental
 */
export interface CameraSnapshot {
  /** The graph x under the centre of the canvas. */
  x: number;
  /** The graph y under the centre of the canvas. */
  y: number;
  /** The zoom ratio, `1 / zoom`: smaller is closer. */
  ratio: number;
}

/**
 * What a long-press or a right-click on a node reports.
 *
 * @stability experimental
 */
export interface NodeContextMenuEvent {
  /** The id of the node the menu is for. */
  id: string;
  /** Where to anchor the menu, in client (page) coordinates. */
  clientX: number;
  /** Where to anchor the menu, in client (page) coordinates. */
  clientY: number;
  /** The gesture that asked for it. */
  source: 'long-press' | 'right-click';
}

/**
 * Props of `GraphCanvas`, the G6 drawing surface for an explorer or overview graph.
 *
 * @stability experimental
 */
export interface GraphCanvasProps {
  /** The graph to draw. It is mutated in place; bump `version` after changing it. */
  graph: GraphCanvasGraph;
  /** Increments on every mutation of `graph`; the canvas re-syncs on change. */
  version: number;
  /** Ids of the nodes to show; every other node is hidden. */
  visibleIds: ReadonlySet<string>;
  /** Id of the selected node, which is highlighted, or `null` for none. */
  selectedId: string | null;
  /** `forceatlas` lays out only the new nodes with a force layout; `concentric` rings by hop from `seedIds`; `static` draws the stored `x`/`y` as they are. */
  layout: CanvasLayout;
  /** The seeds, the centre of the concentric layout. */
  seedIds?: readonly string[];
  /** Identifies the view for pin persistence in `sessionStorage`; absent: pins are not persisted. */
  pinsKey?: string;
  /** Called when the number of pinned nodes changes. */
  onPinnedCountChange?: (count: number) => void;
  /** Called with the node id when a node is clicked; `shiftKey` says Shift was held (a multi-select toggle). */
  onNodeClick: (id: string, modifiers?: { shiftKey: boolean }) => void;
  /** Called with the node id when a node is double-clicked. */
  onNodeDoubleClick: (id: string) => void;
  /** Called when empty space is clicked, which clears the selection. */
  onStageClick: () => void;
  /** Called with the edge id when an edge is clicked. */
  onEdgeClick?: (id: string) => void;
  /** Height of the canvas, as a CSS length or a number of pixels. */
  height: number | string;
  /** `false`: no pan, zoom, drag or clicks (the phone widget, which must not trap scroll). */
  interactive?: boolean;
  /** Zoom/fit for keyboard controls and toolbar buttons. */
  controlsRef?: Ref<GraphCanvasControls>;
  /** An accessible name for the drawing surface itself. */
  ariaLabel?: string;
  /** The node a first tap previewed on touch: highlighted with its neighbours, without being selected. */
  previewId?: string | null;
  /** Nodes marked in "Select" mode; drawn highlighted whatever else is dimmed. */
  markedIds?: ReadonlySet<string>;
  /** Nodes the TimeBar dims. A selected, focused or marked node is never dimmed. */
  dimmedIds?: ReadonlySet<string> | null;
  /** Path mode (GIC-13): the nodes of the shown path. Non-empty: they are lit and every other node is dimmed. */
  pathNodeIds?: ReadonlySet<string>;
  /** Path mode (GIC-13): the edges of the shown path, drawn thicker; every other edge is dimmed. */
  pathEdgeIds?: ReadonlySet<string>;
  /** `touch` enables long-press and the enlarged pick radius and disables hover and double-click expand. Default `pointer`. */
  inputModality?: 'touch' | 'pointer';
  /** The performance budgets of the window (GIC-08). Omitted: the roomy defaults, as the overview uses it. */
  budgets?: ExplorerBudgets;
  /** The part of the canvas the inspector covers, in px; a selection is panned out from under it. */
  revealInsets?: Insets;
  /** A long-press (touch) or right-click (pointer) on a node. */
  onNodeContextMenu?: (event: NodeContextMenuEvent) => void;
  /** The Select tool is on and the input is a pointer: a plain drag on the stage draws a lasso (Shift+drag always does). */
  selectTool?: boolean;
  /** A lasso was drawn (GIC-14): the ids of the visible nodes inside it. Absent: no lasso. */
  onLasso?: (ids: string[]) => void;
  /** The element G6's minimap draws into (`ExplorerMinimap`); absent or on a compact window: no minimap. */
  minimapContainer?: HTMLElement | null;
  /** `false` hides the on-screen zoom cluster. Default: shown when `interactive`. */
  showZoomControls?: boolean;
}

/** A G6 pointer event, as far as this file reads it. */
interface CanvasPointerEvent {
  target?: { id?: string } | null;
  targetType?: string;
  shiftKey?: boolean;
  clientX?: number;
  clientY?: number;
  client?: { x: number; y: number };
  nativeEvent?: { shiftKey?: boolean; clientX?: number; clientY?: number; preventDefault?: () => void };
  preventDefault?: () => void;
}

const clientOf = (event: CanvasPointerEvent): { x: number; y: number } => ({
  x: event.client?.x ?? event.clientX ?? event.nativeEvent?.clientX ?? 0,
  y: event.client?.y ?? event.clientY ?? event.nativeEvent?.clientY ?? 0,
});

/** Escapes text for the tooltip, which G6 sets as HTML. Labels are user data. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function GraphCanvas(props: GraphCanvasProps) {
  const { graph, height, interactive = true, ariaLabel } = props;
  const theme = useTheme();
  const windowCompact = useMediaQuery(theme.breakpoints.down('sm'));
  const finePointer = useMediaQuery('(pointer: fine)');
  const coarsePointer = useMediaQuery('(pointer: coarse)');
  const reducedMotion = useReducedMotion();
  const touch = (props.inputModality ?? 'pointer') === 'touch';

  const canvasTheme = useMemo<CanvasTheme>(
    () => ({
      mode: theme.palette.mode === 'dark' ? 'dark' : 'light',
      paper: theme.palette.background.paper,
      text: theme.palette.text.primary,
      textSecondary: theme.palette.text.secondary,
      accent: theme.palette.primary.main,
      self: theme.palette.secondary.main,
      marked: theme.palette.warning.main,
      fontFamily: String(theme.typography.fontFamily ?? 'sans-serif'),
    }),
    [theme],
  );

  const paneRef = useRef<HTMLDivElement | null>(null);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  hostRef.current = host;
  const graphRef = useRef<Graph | null>(null);
  const [ready, setReady] = useState(0);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const [zoomKey, setZoomKey] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [relayoutToken, setRelayoutToken] = useState(0);

  const pinControls = usePins(graph, props.pinsKey);
  const tracker = useRef(createCameraTracker()).current;
  const frameListeners = useRef(new Set<() => void>());
  const longPressRef = useRef<LongPress | null>(null);

  // Everything the G6 event handlers read, kept current without re-registering them.
  const latest = useRef({ props, touch, reducedMotion, canvasTheme, pinControls, hoverId, hoveredEdgeId, relayoutToken });
  latest.current = { props, touch, reducedMotion, canvasTheme, pinControls, hoverId, hoveredEdgeId, relayoutToken };

  const { onPinnedCountChange } = props;
  useEffect(() => {
    onPinnedCountChange?.(pinControls.pinnedCount);
  }, [pinControls.pinnedCount, onPinnedCountChange]);

  const animation = useCallback(
    () => (latest.current.reducedMotion ? false : { duration: CAMERA_ANIMATION_MS, easing: 'ease-in-out' }),
    [],
  );

  // --- Where nodes are drawn, in viewport px ----------------------------------
  const drawnNodes = useCallback((): LassoTarget[] => {
    const g6 = graphRef.current;
    if (!isLive(g6)) return [];
    const { graph: model, visibleIds } = latest.current.props;
    const zoom = zoomOf(g6);
    const out: LassoTarget[] = [];
    for (const id of visibleIds) {
      if (!model.hasNode(id) || !g6.hasNode(id)) continue;
      const attrs = model.getNodeAttributes(id) as Record<string, unknown>;
      if (attrs.isStub === true) continue;
      try {
        const [x, y] = g6.getViewportByCanvas(g6.getElementPosition(id));
        out.push({ id, x: x!, y: y!, radius: (diameterOf(attrs) / 2) * zoom });
      } catch {
        // Not drawn yet.
      }
    }
    return out;
  }, []);

  // --- Framing ----------------------------------------------------------------
  const fitIds = useCallback(
    async (ids: readonly string[], animate: boolean) => {
      const g6 = graphRef.current;
      if (!isLive(g6)) return;
      const drawn = ids.filter((id) => g6.hasNode(id));
      const bounds = unionBounds(
        drawn.map((id): Bounds | null => {
          try {
            return g6.getElementRenderBounds(id) as unknown as Bounds;
          } catch {
            return null;
          }
        }),
      );
      if (!bounds) return;
      const [width, height] = g6.getSize();
      if (!width || !height) return;
      const { zoom } = fitTransform(bounds, [width, height]);
      const effect = animate ? animation() : false;
      await tracker.programmatic(async () => {
        await g6.focusElement(drawn, effect);
        if (!isLive(g6)) return;
        await g6.zoomTo(zoom, effect);
      });
    },
    [animation, tracker],
  );

  const fitVisible = useCallback(
    (animate: boolean) => {
      const g6 = graphRef.current;
      if (!isLive(g6)) return Promise.resolve();
      return fitIds(
        g6.getNodeData().map((node) => String(node.id)),
        animate,
      );
    },
    [fitIds],
  );

  // --- Element states ---------------------------------------------------------
  const syncing = useRef(false);
  const applyStates = useCallback(() => {
    const g6 = graphRef.current;
    if (!isLive(g6) || syncing.current) return;
    const { props: p, touch: isTouch, hoverId: hover, hoveredEdgeId: hoverEdge } = latest.current;
    const focusId = (isTouch ? null : hover) ?? p.previewId ?? null;
    const constrained = p.budgets?.constrained ?? windowCompactRef.current;
    const reduced = p.budgets ? p.budgets.labelDensity === 'reduced' : constrained;
    const states = computeElementStates({
      graph: p.graph,
      visibleIds: p.visibleIds,
      selectedId: p.selectedId,
      focusId,
      hoveredEdgeId: hoverEdge,
      markedIds: p.markedIds,
      dimmedIds: p.dimmedIds,
      pathNodeIds: p.pathNodeIds,
      pathEdgeIds: p.pathEdgeIds,
      compact: constrained,
      zoom: zoomOf(g6),
      lodZoom: reduced ? LABEL_LOD_ZOOM_REDUCED : LABEL_LOD_ZOOM,
      lodMinNodes: LABEL_LOD_MIN_NODES,
    });
    const merged: Record<string, string[]> = {};
    for (const [id, list] of Object.entries(states.nodes)) if (g6.hasNode(id)) merged[id] = list;
    for (const [id, list] of Object.entries(states.edges)) if (g6.hasEdge(id)) merged[id] = list;
    void g6.setElementState(merged, false);
  }, []);
  const windowCompactRef = useRef(windowCompact);
  windowCompactRef.current = windowCompact;

  // --- Data and layout --------------------------------------------------------
  const laidOut = useRef<{ graph: GraphCanvasGraph; ids: Set<string> } | null>(null);
  const lastLayout = useRef<CanvasLayout | null>(null);
  const lastToken = useRef(0);
  const dirty = useRef(false);
  const running = useRef(false);
  /** The label scale the drawn data carries, so a zoom step restyles only when it changes. */
  const appliedScale = useRef('');

  const runSync = useCallback(async () => {
    const g6 = graphRef.current;
    if (!g6 || g6.destroyed) return;
    const { props: p, canvasTheme: tokens, pinControls: pins, relayoutToken: token } = latest.current;
    const model = p.graph;
    if (!laidOut.current || laidOut.current.graph !== model) {
      laidOut.current = { graph: model, ids: new Set() };
      lastLayout.current = null;
    }
    const known = laidOut.current.ids;
    pins.applyPins();

    const relayout = lastToken.current !== token;
    lastToken.current = token;
    const previous = lastLayout.current;
    lastLayout.current = p.layout;
    const all = movesEverything({ layout: p.layout, previous, relayout });
    const movable = p.layout === 'static' ? new Set<string>() : movableNodes(model, known, { all });
    model.forEachNode((id) => known.add(id));

    const scale = labelScale(zoomOf(g6));
    appliedScale.current = JSON.stringify(scale);
    const data = buildCanvasData(model, p.visibleIds, tokens, scale);
    const nodes = data.nodes ?? [];
    const visibleMovable = nodes.filter((node) => movable.has(String(node.id))).length;
    const run =
      shouldRunLayout({ layout: p.layout, previous, relayout, movable: visibleMovable }) && nodes.length >= 2;
    if (run && p.layout === 'forceatlas') {
      for (const node of nodes) {
        if (movable.has(String(node.id))) continue;
        const style = node.style as { x: number; y: number };
        Object.assign(node, { fx: style.x, fy: style.y });
      }
    }

    syncing.current = true;
    try {
      g6.setData(data);
      if (run) {
        const budget = p.budgets?.layoutTimeBoxMs ?? DEFAULT_LAYOUT_TIME_BOX_MS;
        g6.setLayout(
          (p.layout === 'forceatlas'
            ? forceLayoutOptions(budget)
            : radialLayoutOptions(model, p.seedIds, budget)) as Parameters<Graph['setLayout']>[0],
        );
        await g6.render();
        if (g6.destroyed) return;
        // The layout's positions become the model's, so pins, the lasso and the next merge read them.
        const pinned = pins.pins.current;
        const restore: Array<{ id: string; style: { x: number; y: number } }> = [];
        for (const node of nodes) {
          const id = String(node.id);
          const pin = pinned.get(id);
          if (pin) {
            restore.push({ id, style: { x: pin.x, y: pin.y } });
            continue;
          }
          if (!movable.has(id) || !model.hasNode(id)) continue;
          const [x, y] = g6.getElementPosition(id);
          model.mergeNodeAttributes(id, { x, y });
        }
        if (restore.length > 0 && p.layout !== 'forceatlas') {
          g6.updateNodeData(restore);
          await g6.draw();
        }
      } else {
        await g6.draw();
      }
    } finally {
      syncing.current = false;
    }
    if (g6.destroyed) return;
    markDrawn(g6);
    // The pane may have been laid out (or resized) between creating the instance and its first draw.
    const pane = hostRef.current;
    if (pane) syncSize(g6, pane.clientWidth, pane.clientHeight);
    applyStates();
    if (!tracker.moved()) await fitVisible(true);
  }, [applyStates, fitVisible, tracker]);

  /** Restyles the drawn labels for the current zoom when it crossed a step (screen-constant text). */
  const applyLabelScale = useCallback(() => {
    const g6 = graphRef.current;
    if (!isLive(g6) || syncing.current || running.current) return;
    const scale = labelScale(zoomOf(g6));
    const key = JSON.stringify(scale);
    if (key === appliedScale.current) return;
    appliedScale.current = key;
    const nodes = g6.getNodeData().map((node) => {
      const members = (node.data as { memberCount?: unknown } | undefined)?.memberCount;
      // An overview cluster keeps its on-screen size too.
      const style = typeof members === 'number' ? { ...scale.node, size: clusterSize(members, scale) } : scale.node;
      return { id: node.id, style };
    });
    const edges = g6.getEdgeData().map((edge) => ({ id: String(edge.id), style: scale.edge }));
    if (nodes.length > 0) g6.updateNodeData(nodes);
    if (edges.length > 0) g6.updateEdgeData(edges);
    void g6.draw();
  }, []);

  const requestSync = useCallback(() => {
    if (running.current) {
      dirty.current = true;
      return;
    }
    running.current = true;
    void (async () => {
      try {
        do {
          dirty.current = false;
          await runSync();
        } while (dirty.current && graphRef.current && !graphRef.current.destroyed);
      } catch {
        // A run interrupted by an unmount; the next mount starts over.
      } finally {
        running.current = false;
      }
      // The run's own fit moved the camera while it held the canvas: catch the labels up.
      applyLabelScale();
    })();
  }, [runSync, applyLabelScale]);

  // --- Create and destroy the instance ----------------------------------------
  const pixelRatio = cappedPixelRatio(props.budgets?.pixelRatioCap ?? null);
  useEffect(() => {
    if (!host) return undefined;
    let disposed = false;
    let instance: Graph | null = null;
    let observer: ResizeObserver | undefined;
    queueMicrotask(() => {
      if (disposed) return;
      const tokens = latest.current.canvasTheme;
      const behaviors = interactive
        ? [
            { type: 'zoom-canvas', key: 'zoom-canvas', sensitivity: 1 },
            {
              type: 'drag-canvas',
              key: 'drag-canvas',
              enable: (event: CanvasPointerEvent) => {
                if (event.targetType === 'canvas') return true;
                // On touch a plain drag that starts on a node pans; only a long-press arms the node.
                return latest.current.touch && event.targetType === 'node' && !longPressRef.current?.fired();
              },
            },
            {
              type: 'drag-element',
              key: 'drag-element',
              // A state no element ever has: only the node under the pointer moves, never "the selection".
              state: 'drag-group',
              animation: false,
              enable: (event: CanvasPointerEvent) =>
                event.targetType === 'node' && (!latest.current.touch || longPressRef.current?.fired() === true),
              onFinish: (ids: Array<string | number>) => {
                const g6 = graphRef.current;
                const { props: p, pinControls: pins } = latest.current;
                if (!isLive(g6)) return;
                for (const raw of ids) {
                  const id = String(raw);
                  if (!p.graph.hasNode(id)) continue;
                  const [x, y] = g6.getElementPosition(id);
                  pins.pin(id, { x: x!, y: y! });
                }
              },
            },
            {
              type: 'optimize-viewport-transform',
              key: 'optimize-viewport-transform',
              enable: () => {
                const limit = latest.current.props.budgets?.hideEdgesOnMoveAbove;
                return typeof limit === 'number' && latest.current.props.graph.size > limit;
              },
            },
          ]
        : [];
      instance = new Graph({
        container: host,
        width: host.clientWidth || 300,
        height: host.clientHeight || 300,
        autoResize: false,
        zoomRange: [ZOOM_RANGE[0], ZOOM_RANGE[1]],
        animation: latest.current.reducedMotion ? false : { duration: CAMERA_ANIMATION_MS },
        ...(pixelRatio ? { devicePixelRatio: pixelRatio } : {}),
        node: { state: nodeStateStyles(tokens) },
        edge: { state: edgeStateStyles(tokens) },
        behaviors: behaviors as never,
        plugins: [],
      });
      const g6 = instance;
      const frame = () => {
        for (const listener of frameListeners.current) listener();
      };
      g6.on('aftertransform', () => {
        // An animated transform can finish after the instance was destroyed (an unmount, StrictMode).
        if (!isLive(g6)) return;
        tracker.onTransform();
        setZoomKey(zoomBucket(zoomOf(g6)));
        frame();
      });
      const liveFrame = () => {
        if (isLive(g6)) frame();
      };
      g6.on('afterdraw', liveFrame);
      g6.on('afterlayout', liveFrame);
      g6.on('afteranimate', liveFrame);

      if (interactive) {
        const on = (name: string, listener: (event: CanvasPointerEvent) => void) => g6.on(name, listener as never);
        const handlers = () => latest.current.props;
        const isStub = (id: string) => handlers().graph.hasNode(id) && handlers().graph.getNodeAttribute(id, 'isStub') === true;
        on('node:click', (event: CanvasPointerEvent) => {
          const id = event.target?.id;
          if (!id || longPressRef.current?.fired()) return;
          // A "+N more" stub is activated, not selected: activating it expands its type.
          if (isStub(id)) {
            handlers().onNodeDoubleClick(id);
            return;
          }
          handlers().onNodeClick(id, { shiftKey: Boolean(event.shiftKey ?? event.nativeEvent?.shiftKey) });
        });
        on('node:dblclick', (event: CanvasPointerEvent) => {
          const id = event.target?.id;
          if (!id || isStub(id)) return;
          // On touch a quick second tap is the "second tap" that opens the inspector, never an expand.
          if (latest.current.touch) return;
          handlers().onNodeDoubleClick(id);
        });
        on('node:pointerenter', (event: CanvasPointerEvent) => {
          if (!latest.current.touch && event.target?.id) setHoverId(event.target.id);
        });
        on('node:pointerleave', () => setHoverId(null));
        on('edge:pointerenter', (event: CanvasPointerEvent) => {
          if (!latest.current.touch && event.target?.id) setHoveredEdgeId(event.target.id);
        });
        on('edge:pointerleave', () => setHoveredEdgeId(null));
        on('edge:click', (event: CanvasPointerEvent) => {
          if (event.target?.id) handlers().onEdgeClick?.(event.target.id);
        });
        on('canvas:click', (event: CanvasPointerEvent) => {
          if (longPressRef.current?.fired()) return;
          if (latest.current.touch) {
            const rect = host.getBoundingClientRect();
            const point = clientOf(event);
            const radius = (handlers().budgets?.hitTargetPx || 44) / 2;
            const drawn = new Map(drawnNodes().map((node) => [node.id, node]));
            const hit = pickNearestNode(
              drawn.keys(),
              (id) => {
                const node = drawn.get(id);
                return node ? { x: node.x, y: node.y, size: node.radius } : null;
              },
              { x: point.x - rect.left, y: point.y - rect.top },
              radius,
            );
            if (hit && isStub(hit)) handlers().onNodeDoubleClick(hit);
            else if (hit) handlers().onNodeClick(hit);
            else handlers().onStageClick();
            return;
          }
          handlers().onStageClick();
        });
        on('node:contextmenu', (event: CanvasPointerEvent) => {
          const id = event.target?.id;
          if (!id) return;
          event.preventDefault?.();
          event.nativeEvent?.preventDefault?.();
          const point = clientOf(event);
          handlers().onNodeContextMenu?.({ id, clientX: point.x, clientY: point.y, source: 'right-click' });
        });
      }

      observer = new ResizeObserver(() => {
        // Before the first draw there is no canvas to resize: `runSync` syncs the size after it.
        if (!syncSize(instance, host.clientWidth, host.clientHeight)) return;
        if (!tracker.moved()) void fitVisible(false);
      });
      observer.observe(host);
      graphRef.current = g6;
      laidOut.current = null;
      setReady((n) => n + 1);
    });
    return () => {
      disposed = true;
      observer?.disconnect();
      if (instance) {
        if (graphRef.current === instance) graphRef.current = null;
        instance.destroy();
      }
      laidOut.current = null;
    };
    // The instance is rebuilt only for a new host, a change of interactivity or of the pixel-ratio budget.
  }, [host, interactive, pixelRatio, tracker, drawnNodes, fitVisible]);

  // The theme's state styles (light/dark) and the motion preference.
  useEffect(() => {
    const g6 = graphRef.current;
    if (!g6 || g6.destroyed) return;
    g6.setNode({ state: nodeStateStyles(canvasTheme) } as Parameters<Graph['setNode']>[0]);
    g6.setEdge({ state: edgeStateStyles(canvasTheme) } as Parameters<Graph['setEdge']>[0]);
    g6.setOptions({ animation: reducedMotion ? false : { duration: CAMERA_ANIMATION_MS } });
  }, [ready, canvasTheme, reducedMotion]);

  // --- Re-sync on every change of the data, the visibility or the layout -------
  const visibleKey = useMemo(() => [...props.visibleIds].sort().join(','), [props.visibleIds]);
  useEffect(() => {
    if (ready > 0) requestSync();
  }, [ready, graph, props.version, visibleKey, props.layout, relayoutToken, canvasTheme, requestSync]);

  // --- Screen-constant labels: restyle when the zoom crosses a step ------------
  useEffect(() => {
    applyLabelScale();
  }, [ready, zoomKey, applyLabelScale]);

  // --- Interaction states -----------------------------------------------------
  const markedKey = props.markedIds ? [...props.markedIds].sort().join(',') : '';
  const dimmedKey = props.dimmedIds ? [...props.dimmedIds].sort().join(',') : '';
  const pathNodeKey = props.pathNodeIds ? [...props.pathNodeIds].sort().join(',') : '';
  const pathEdgeKey = props.pathEdgeIds ? [...props.pathEdgeIds].sort().join(',') : '';
  useEffect(() => {
    if (ready > 0) applyStates();
  }, [
    ready,
    applyStates,
    props.selectedId,
    props.previewId,
    hoverId,
    hoveredEdgeId,
    markedKey,
    dimmedKey,
    pathNodeKey,
    pathEdgeKey,
    zoomKey,
    touch,
    windowCompact,
  ]);

  // --- Plugins: minimap (not on a compact window) and tooltip (fine pointers) ---
  const minimapContainer = props.minimapContainer ?? null;
  const tooltips = interactive && finePointer && !touch;
  useEffect(() => {
    const g6 = graphRef.current;
    if (!g6 || g6.destroyed) return;
    const plugins: Array<Record<string, unknown>> = [];
    if (minimapContainer && !windowCompact) {
      plugins.push({
        type: 'minimap',
        key: 'minimap',
        container: minimapContainer,
        size: [MINIMAP_WIDTH, MINIMAP_HEIGHT],
        padding: 8,
        delay: 128,
        containerStyle: { border: 'none', background: 'transparent' },
        maskStyle: {
          border: `2px solid ${canvasTheme.accent}`,
          background: 'rgba(127, 127, 127, 0.12)',
          borderRadius: '2px',
        },
      });
    }
    if (tooltips) {
      plugins.push({
        type: 'tooltip',
        key: 'tooltip',
        trigger: 'hover',
        enable: (event: CanvasPointerEvent) => event.targetType === 'node',
        getContent: (_event: unknown, items: Array<{ id?: string | number; data?: Record<string, unknown> }>) => {
          const item = items[0];
          const label = String(item?.data?.label ?? item?.id ?? '');
          const type = typeof item?.data?.entityType === 'string' ? humanizeKey(item.data.entityType as string) : '';
          return Promise.resolve(
            `<div style="font:12px ${escapeHtml(canvasTheme.fontFamily)};color:${canvasTheme.text}">` +
              `<strong>${escapeHtml(label)}</strong>${type ? `<br/><span>${escapeHtml(type)}</span>` : ''}</div>`,
          );
        },
        style: {
          '.tooltip': {
            background: canvasTheme.paper,
            color: canvasTheme.text,
            'border-radius': '6px',
            padding: '6px 8px',
          },
        },
      });
    }
    g6.setPlugins(plugins as Parameters<Graph['setPlugins']>[0]);
  }, [ready, minimapContainer, windowCompact, tooltips, canvasTheme]);

  // --- Keep the selection out from under the inspector --------------------------
  const revealInsets = props.revealInsets;
  const insetsKey = revealInsets
    ? `${revealInsets.top},${revealInsets.right},${revealInsets.bottom},${revealInsets.left}`
    : '';
  const selectedId = props.selectedId;
  useEffect(() => {
    if (!revealInsets || !selectedId || ready === 0) return undefined;
    const frame = requestAnimationFrame(() => {
      const g6 = graphRef.current;
      if (!isLive(g6) || !g6.hasNode(selectedId)) return;
      const [width, height] = g6.getSize();
      if (!width || !height) return;
      const [x, y] = g6.getViewportByCanvas(g6.getElementPosition(selectedId));
      const delta = revealDelta({ x: x!, y: y! }, { width, height }, revealInsets);
      if (!delta) return;
      void tracker.programmatic(() => g6.translateBy([delta.x, delta.y], animation()));
    });
    return () => cancelAnimationFrame(frame);
    // The insets are compared by value (`insetsKey`), not identity.
  }, [selectedId, insetsKey, ready, tracker, animation]);

  // --- Touch: long-press for the context menu (and to arm dragging) -------------
  useEffect(() => {
    if (!host || !interactive || !touch) return undefined;
    let pressed: string | null = null;
    const longPress = createLongPress({
      onLongPress: (point) => {
        if (!pressed) return;
        const rect = host.getBoundingClientRect();
        latest.current.props.onNodeContextMenu?.({
          id: pressed,
          clientX: rect.left + point.x,
          clientY: rect.top + point.y,
          source: 'long-press',
        });
      },
    });
    longPressRef.current = longPress;
    const local = (event: PointerEvent) => {
      const rect = host.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const pointers = new Set<number>();
    const onDown = (event: PointerEvent) => {
      pointers.add(event.pointerId);
      if (event.pointerType !== 'touch' || pointers.size !== 1) {
        longPress.cancel();
        return;
      }
      const point = local(event);
      const radius = (latest.current.props.budgets?.hitTargetPx || 44) / 2;
      const drawn = new Map(drawnNodes().map((node) => [node.id, node]));
      pressed = pickNearestNode(
        drawn.keys(),
        (id) => {
          const node = drawn.get(id);
          return node ? { x: node.x, y: node.y, size: node.radius } : null;
        },
        point,
        radius,
      );
      if (pressed) longPress.start(point);
    };
    const onMove = (event: PointerEvent) => {
      if (pointers.size !== 1) longPress.cancel();
      else longPress.move(local(event));
    };
    const onUp = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      longPress.cancel();
    };
    host.addEventListener('pointerdown', onDown, true);
    host.addEventListener('pointermove', onMove, true);
    host.addEventListener('pointerup', onUp, true);
    host.addEventListener('pointercancel', onUp, true);
    return () => {
      longPress.cancel();
      longPressRef.current = null;
      host.removeEventListener('pointerdown', onDown, true);
      host.removeEventListener('pointermove', onMove, true);
      host.removeEventListener('pointerup', onUp, true);
      host.removeEventListener('pointercancel', onUp, true);
    };
  }, [host, interactive, touch, drawnNodes]);

  // --- Fullscreen ------------------------------------------------------------
  const fullscreenSupported =
    typeof document !== 'undefined' &&
    document.fullscreenEnabled === true &&
    typeof HTMLElement !== 'undefined' &&
    typeof HTMLElement.prototype.requestFullscreen === 'function';
  useEffect(() => {
    if (!fullscreenSupported) return undefined;
    const onChange = () => setFullscreen(document.fullscreenElement === paneRef.current && paneRef.current !== null);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [fullscreenSupported]);
  const toggleFullscreen = useCallback(() => {
    const pane = paneRef.current;
    if (!pane) return;
    if (document.fullscreenElement === pane) void document.exitFullscreen?.();
    else void pane.requestFullscreen?.().catch(() => undefined);
  }, []);

  // --- Controls ----------------------------------------------------------------
  const zoomBy = useCallback(
    (ratio: number) => {
      const g6 = graphRef.current;
      if (!isLive(g6)) return;
      void g6.zoomBy(ratio, animation());
    },
    [animation],
  );
  const fit = useCallback(() => {
    tracker.reset();
    void fitVisible(true);
  }, [tracker, fitVisible]);

  useImperativeHandle(
    props.controlsRef,
    () => ({
      zoomIn: () => zoomBy(ZOOM_STEP),
      zoomOut: () => zoomBy(1 / ZOOM_STEP),
      fit,
      relayoutAll: () => setRelayoutToken((n) => n + 1),
      togglePin: (id) => latest.current.pinControls.togglePin(id),
      unpinAll: () => latest.current.pinControls.unpinAll(),
      isPinned: (id) => latest.current.pinControls.isPinned(id),
      getCamera: () => {
        const g6 = graphRef.current;
        if (!isLive(g6)) return { x: 0, y: 0, ratio: 1 };
        const [x, y] = g6.getCanvasByViewport(g6.getViewportCenter());
        return { x: x!, y: y!, ratio: 1 / zoomOf(g6) };
      },
      setCamera: (camera) => {
        const g6 = graphRef.current;
        if (!isLive(g6)) return;
        void (async () => {
          await g6.zoomTo(1 / camera.ratio, false);
          const [vx, vy] = g6.getViewportByCanvas([camera.x, camera.y]);
          const [cx, cy] = g6.getViewportCenter();
          await g6.translateBy([cx! - vx!, cy! - vy!], false);
        })();
      },
      fitTo: (ids) => {
        void fitIds(ids, true).then(() => tracker.onTransform());
      },
      focusNode: (id) => {
        const g6 = graphRef.current;
        if (!isLive(g6) || !g6.hasNode(id)) return;
        void (async () => {
          await tracker.programmatic(async () => {
            await g6.focusElement(id, animation());
            if (isLive(g6) && zoomOf(g6) < 1.5) await g6.zoomTo(1.5, animation());
          });
          tracker.onTransform();
        })();
      },
      getViewport: () => {
        const g6 = graphRef.current;
        if (!isLive(g6)) return null;
        const [width, height] = g6.getSize();
        if (!width || !height) return null;
        const [x0, y0] = g6.getCanvasByViewport([0, 0]);
        const [x1, y1] = g6.getCanvasByViewport([width, height]);
        return { topLeft: { x: x0!, y: y0! }, bottomRight: { x: x1!, y: y1! } };
      },
      panToGraph: (x, y) => {
        const g6 = graphRef.current;
        if (!isLive(g6)) return;
        const [vx, vy] = g6.getViewportByCanvas([x, y]);
        const [cx, cy] = g6.getViewportCenter();
        void g6.translateBy([cx! - vx!, cy! - vy!], false);
      },
      onFrame: (listener) => {
        frameListeners.current.add(listener);
        return () => {
          frameListeners.current.delete(listener);
        };
      },
    }),
    [zoomBy, fit, fitIds, tracker, animation],
  );

  const showZoom = interactive && props.showZoomControls !== false;
  const coarse = coarsePointer || touch;
  return (
    <Box
      ref={paneRef}
      sx={{
        position: 'relative',
        height,
        width: '100%',
        bgcolor: fullscreen ? 'background.default' : undefined,
        pointerEvents: interactive ? undefined : 'none',
        // The canvas owns pinch and pan; nothing else on the page is affected.
        touchAction: interactive ? 'none' : undefined,
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
        WebkitTapHighlightColor: 'transparent',
      }}
      onContextMenu={props.onNodeContextMenu && interactive ? (event) => event.preventDefault() : undefined}
    >
      <Box
        ref={setHost}
        data-testid="graph-canvas"
        aria-label={ariaLabel}
        role={ariaLabel ? 'img' : undefined}
        sx={{ position: 'absolute', inset: 0, overflow: 'hidden' }}
      />
      {props.onLasso && interactive && (
        <LassoBehaviour
          container={host}
          positions={drawnNodes}
          selectTool={props.selectTool === true}
          onLasso={props.onLasso}
        />
      )}
      {showZoom && (
        <ZoomControls
          onZoomIn={() => zoomBy(ZOOM_STEP)}
          onZoomOut={() => zoomBy(1 / ZOOM_STEP)}
          onFit={fit}
          onToggleFullscreen={fullscreenSupported ? toggleFullscreen : undefined}
          fullscreen={fullscreen}
          coarse={coarse}
          insets={{ bottom: props.revealInsets?.bottom ?? 0, right: props.revealInsets?.right ?? 0 }}
        />
      )}
    </Box>
  );
}
