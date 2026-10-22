/**
 * `GraphCanvas` — the ONE file that imports sigma (#374, epic #347; spec §22.1).
 *
 * A thin wrapper over `@react-sigma/core`'s `SigmaContainer`, deliberately
 * generic so the whole-graph overview (#375) can reuse it: it renders the
 * `x`, `y`, `size`, `color` and `label` attributes ALREADY on each graphology
 * node and edge (written by `explorerModel`, or by the overview's model) and
 * computes no styling of its own. What it adds:
 *
 *   - reducers (`explorerReducers.ts`) that hide nodes outside `visibleIds`,
 *     light the hovered node (on a touch screen, the first-tapped one, else the
 *     selection) with its neighbours and dim the rest, draw rings, and label only
 *     what is lit (#667);
 *   - three sigma programs: nodes with a pictogram draw as a ringed disc with
 *     the type's glyph (`@sigma/node-border` + `@sigma/node-image`), parallel
 *     edges as curves (`@sigma/edge-curve`);
 *   - click / double-click / stage / edge events, and dragging (a dragged node
 *     becomes `fixed`, so the layout leaves it where it was put);
 *   - after each `version` change with `layout === 'forceatlas'`, an INCREMENTAL
 *     ForceAtlas2 run (#668): nodes already laid out are fixed and only new ones
 *     move; `concentric` rings the nodes by hop; `static` never moves a node,
 *     which is what the visual baselines rely on. Pinned nodes persist per view
 *     in `sessionStorage`.
 *
 * ⚠ THE LAYOUT RUNS IN A SAME-ORIGIN MODULE WORKER (`layout/layout.worker.ts`),
 * NOT IN `graphology-layout-forceatlas2/worker`: that supervisor spawns its
 * worker from a `blob:` URL, and production's CSP is `worker-src 'self'`
 * (`infra/nginx/csp.conf`). Without `Worker` the same engine runs on the main
 * thread in 8 ms slices (`layout/layoutClient.ts`).
 *
 * jsdom has no WebGL: tests `vi.mock` this module rather than import it.
 *
 * THE TOUCH MODEL (GIC-08, #669; the pure parts are `shell/canvasGestures.ts`):
 *   - `touch-action: none` on THIS element only, so pinch and pan belong to the
 *     canvas while the rest of the page still scrolls;
 *   - the first tap on a node previews it (`previewId`: its neighbours light up),
 *     the second tap on the same node activates it. `onNodeClick` fires on every
 *     tap or click and the PAGE decides which it is, from `inputModality`;
 *   - a 500ms long-press on a node opens the context menu
 *     (`onNodeContextMenu`, with a haptic tick) and arms dragging, so a node can
 *     only be pinned by long-press then drag, never by accident while panning;
 *   - on a coarse pointer a tap within `budgets.hitTargetPx / 2` of a node hits it
 *     (an enlarged pick radius, 44px target);
 *   - `budgets` also set the `devicePixelRatio` cap, label density,
 *     `hideEdgesOnMove` and the layout time box, without rebuilding sigma, so a
 *     rotation keeps the camera;
 *   - `revealInsets` is the part of the canvas the inspector covers: selecting a
 *     node pans it into the rest.
 */

import '@react-sigma/core/lib/style.css';

import {
  SigmaContainer,
  useCamera,
  useRegisterEvents,
  useSetSettings,
  useSigma,
} from '@react-sigma/core';
import { createDrawCurvedEdgeLabel, createEdgeCurveProgram } from '@sigma/edge-curve';
import { createNodeBorderProgram } from '@sigma/node-border';
import { createNodeImageProgram } from '@sigma/node-image';
import Box from '@mui/material/Box';
import useMediaQuery from '@mui/material/useMediaQuery';
import { alpha, useTheme } from '@mui/material/styles';
import type { MultiDirectedGraph, UndirectedGraph } from 'graphology';
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { createNodeCompoundProgram } from 'sigma/rendering';
import type { Settings } from 'sigma/settings';

import { DEFAULT_LAYOUT_TIME_BOX_MS, LABEL_DENSITY, type ExplorerBudgets } from './shell/explorerBudgets.js';
import { useCanvasLayout, type CanvasLayout } from './layout/useCanvasLayout.js';
import {
  capPixelRatio,
  createLongPress,
  pickNearestNode,
  revealDelta,
  type Insets,
  type LongPress,
} from './shell/canvasGestures.js';
import { useReducedMotion } from './shell/useReducedMotion.js';
import {
  CURVED_ARROW_PROGRAM,
  PICTOGRAM_PROGRAM,
  buildEdgeReducer,
  buildNodeReducer,
} from './explorerReducers.js';

/**
 * Any graph the canvas can draw (the explorer's directed multigraph, the overview's undirected one).
 *
 * @stability experimental
 */
export type GraphCanvasGraph = MultiDirectedGraph | UndirectedGraph;

export { FA2_SETTLE_ITERATIONS } from './layout/layoutBudgets.js';

/**
 * Sigma's default hover/selection label is a WHITE box with the label colour
 * on top — unreadable in dark mode, where the label colour is near-white. This
 * draws the same box in the theme's own paper and text colours.
 */
function themedHover(background: string, text: string, border: string): Settings['defaultDrawNodeHover'] {
  return (context, data, settings) => {
    const size = settings.labelSize;
    context.font = `${settings.labelWeight} ${size}px ${settings.labelFont}`;
    const label = typeof data.label === 'string' ? data.label : '';
    const pad = 4;
    const textWidth = label ? context.measureText(label).width : 0;
    const height = Math.max(size + pad * 2, data.size * 2 + pad);
    const left = data.x - data.size - pad;
    const width = data.size * 2 + pad * 2 + (label ? textWidth + pad + 2 : 0);
    context.beginPath();
    context.fillStyle = background;
    context.strokeStyle = border;
    context.lineWidth = 1;
    context.roundRect(left, data.y - height / 2, width, height, 4);
    context.fill();
    context.stroke();
    context.beginPath();
    context.fillStyle = data.color;
    context.arc(data.x, data.y, data.size, 0, Math.PI * 2);
    context.fill();
    if (label) {
      context.fillStyle = text;
      context.fillText(label, data.x + data.size + pad, data.y + size / 3);
    }
  };
}

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
  /** Animated camera reset — "Fit". */
  fit: () => void;
  /** Moves every unpinned node again ("Re-layout all"). */
  relayoutAll: () => void;
  /** Pins a node where it is, or unpins it. */
  togglePin: (id: string) => void;
  /** Releases every pin. */
  unpinAll: () => void;
  /** Whether a node is pinned. */
  isPinned: (id: string) => boolean;
  /** The camera as sigma holds it (framed-graph coordinates and zoom ratio). */
  getCamera?: () => CameraSnapshot;
  /** Puts the camera back exactly, without animation. */
  setCamera?: (camera: CameraSnapshot) => void;
}

/**
 * The camera's state: the centre in framed-graph coordinates and the zoom ratio.
 *
 * @stability experimental
 */
export interface CameraSnapshot {
  /** The camera centre's x, in framed-graph coordinates. */
  x: number;
  /** The camera centre's y, in framed-graph coordinates. */
  y: number;
  /** The zoom ratio: 1 frames the whole graph, smaller zooms in. */
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
 * Props of `GraphCanvas`, the sigma drawing surface for an explorer or overview graph.
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
  /** `forceatlas` lays out only the new nodes with ForceAtlas2; `concentric` rings by hop from `seedIds`; `static` draws the stored `x`/`y` as they are (visual baselines). */
  layout: CanvasLayout;
  /** The seeds, the centre of the concentric layout. */
  seedIds?: readonly string[];
  /** Identifies the view for pin persistence in `sessionStorage`; absent: pins are not persisted. */
  pinsKey?: string;
  /** Called when the number of pinned nodes changes. */
  onPinnedCountChange?: (count: number) => void;
  /** Called with the node id when a node is clicked. */
  onNodeClick: (id: string) => void;
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
  /** Nodes the TimeBar dims (no evidence in the brushed window, or not active in the bar under the pointer). A selected, focused or marked node is never dimmed. */
  dimmedIds?: ReadonlySet<string> | null;
  /** `touch` enables long-press and the enlarged pick radius and disables hover and double-click expand. Default `pointer`. */
  inputModality?: 'touch' | 'pointer';
  /** The performance budgets of the window (GIC-08). Omitted: sigma's defaults, as the overview uses it. */
  budgets?: ExplorerBudgets;
  /** The part of the canvas the inspector covers, in px; a selection is panned out from under it. */
  revealInsets?: Insets;
  /** A long-press (touch) or right-click (pointer) on a node. */
  onNodeContextMenu?: (event: NodeContextMenuEvent) => void;
}

/** The curved-edge shape: a bend of 0.25 by default, an arrow head at the target. */
const CURVE_OPTIONS = {
  curvatureAttribute: 'curvature',
  defaultCurvature: 0.25,
  arrowHead: {
    extremity: 'target' as const,
    lengthToThicknessRatio: 2.5,
    widenessToThicknessRatio: 2,
  },
};

/**
 * The node and edge programs, built ONCE PER SIGMA INSTANCE (`@sigma/node-image`
 * shares one texture atlas between its programs, so it must not be reused
 * across instances).
 *
 * A `pictogram` node is two programs drawn together: a ringed disc
 * (`@sigma/node-border`: an optional ring, an optional transparent gap, then the
 * fill) and the type's glyph in pictogram mode, a mask tinted by `iconColor`.
 * The ring and its gap are sized as a fraction of the node's radius.
 */
function buildPrograms(accent: string) {
  const disc = createNodeBorderProgram({
    borders: [
      { size: { attribute: 'ringSize', defaultValue: 0 }, color: { attribute: 'ringColor', defaultValue: accent } },
      { size: { attribute: 'gapSize', defaultValue: 0 }, color: { transparent: true } },
      { size: { fill: true }, color: { attribute: 'color' } },
    ],
  });
  const glyph = createNodeImageProgram({
    drawingMode: 'color',
    colorAttribute: 'iconColor',
    imageAttribute: 'image',
    keepWithinCircle: true,
    padding: 0.2,
    size: { mode: 'force', value: 64 },
    objectFit: 'contain',
    correctCentering: true,
  });
  return {
    nodeProgramClasses: { [PICTOGRAM_PROGRAM]: createNodeCompoundProgram([disc, glyph]) },
    edgeProgramClasses: {
      [CURVED_ARROW_PROGRAM]: createEdgeCurveProgram({
        ...CURVE_OPTIONS,
        drawLabel: createDrawCurvedEdgeLabel({ ...CURVE_OPTIONS, arrowHead: null }),
      }),
    },
  };
}

export function GraphCanvas(props: GraphCanvasProps) {
  const { graph, height, interactive = true, ariaLabel } = props;
  const theme = useTheme();
  // The explorer's own window class (the `sm` boundary), read here, never the shell's gates.
  // Without budgets (the overview) the window class thins the labels; WITH budgets they decide, through
  // `setSettings` below, so a rotation across `sm` never rebuilds sigma and loses the camera.
  const windowCompact = useMediaQuery(theme.breakpoints.down('sm'));
  const compact = props.budgets ? false : windowCompact;
  const accent = theme.palette.primary.main;

  // STABLE settings: `SigmaContainer` rebuilds sigma whenever these change, so
  // everything that varies per render (reducers, selection) goes through
  // `useSetSettings` inside the container instead.
  const settings = useMemo(
    () => ({
      ...buildPrograms(accent),
      // Compact: fewer labels (the focus and the seeds are forced back on).
      labelRenderedSizeThreshold: compact ? 12 : 8,
      labelDensity: compact ? 0.6 : 1,
      labelColor: { color: theme.palette.text.primary },
      labelFont: theme.typography.fontFamily as string,
      labelSize: 12,
      stagePadding: 40,
      defaultDrawNodeHover: themedHover(
        theme.palette.background.paper,
        theme.palette.text.primary,
        theme.palette.divider,
      ),
      defaultEdgeType: 'arrow',
      // Edge labels are drawn only for the hovered edge and the focus's own edges
      // (the reducer blanks every other label).
      renderEdgeLabels: true,
      edgeLabelColor: { color: theme.palette.text.secondary },
      edgeLabelSize: 11,
      enableEdgeEvents: interactive,
      enableCameraZooming: interactive,
      enableCameraPanning: interactive,
      zIndex: true,
      allowInvalidContainer: true,
    }),
    [
      accent,
      compact,
      theme.palette.text.primary,
      theme.palette.text.secondary,
      theme.palette.background.paper,
      theme.palette.divider,
      theme.typography.fontFamily,
      interactive,
    ],
  );

  return (
    <Box
      sx={{
        position: 'relative',
        height,
        width: '100%',
        // `@react-sigma/core`'s stylesheet paints white; the theme's ground instead.
        '& .react-sigma': { background: 'transparent' },
        pointerEvents: interactive ? undefined : 'none',
        // The canvas owns pinch and pan; nothing else on the page is affected.
        touchAction: interactive ? 'none' : undefined,
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
        WebkitTapHighlightColor: 'transparent',
      }}
      onContextMenu={props.onNodeContextMenu && interactive ? (event) => event.preventDefault() : undefined}
      aria-label={ariaLabel}
      role={ariaLabel ? 'img' : undefined}
    >
      <SigmaContainer graph={graph} settings={settings} style={{ height: '100%', width: '100%' }}>
        <CanvasBehaviour {...props} />
      </SigmaContainer>
    </Box>
  );
}

function CanvasBehaviour({
  graph,
  version,
  visibleIds,
  selectedId,
  previewId = null,
  markedIds,
  dimmedIds,
  layout,
  seedIds,
  pinsKey,
  onPinnedCountChange,
  inputModality = 'pointer',
  budgets,
  revealInsets,
  onNodeClick,
  onNodeDoubleClick,
  onStageClick,
  onEdgeClick,
  onNodeContextMenu,
  interactive = true,
  controlsRef,
}: GraphCanvasProps) {
  const sigma = useSigma();
  const setSettings = useSetSettings();
  const registerEvents = useRegisterEvents();
  const camera = useCamera({ duration: 300, factor: 1.5 });
  const theme = useTheme();
  const dimColor = alpha(theme.palette.text.disabled, theme.palette.mode === 'dark' ? 0.4 : 0.6);
  const compact = useMediaQuery(theme.breakpoints.down('sm'));
  // ONE input-modality source: the shell's `useInputModality` decides, through `inputModality`
  // (a touch screen has no hover; the first tap previews through `previewId`, the second selects).
  const touch = inputModality === 'touch';
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);

  const reducedMotion = useReducedMotion();
  const layoutControls = useCanvasLayout({
    graph,
    version,
    layout,
    seedIds,
    pinsKey,
    reducedMotion,
    // ONE time box: the shell's budgets (GIC-08); the overview passes none and gets the roomy default.
    budgetMs: budgets?.layoutTimeBoxMs ?? DEFAULT_LAYOUT_TIME_BOX_MS,
  });
  const layoutRef = useRef(layoutControls);
  layoutRef.current = layoutControls;

  useEffect(() => {
    onPinnedCountChange?.(layoutControls.pinnedCount);
  }, [layoutControls.pinnedCount, onPinnedCountChange]);

  useImperativeHandle(
    controlsRef,
    () => ({
      zoomIn: () => camera.zoomIn(),
      zoomOut: () => camera.zoomOut(),
      fit: () => camera.reset({ duration: 300 }),
      relayoutAll: () => layoutRef.current.relayoutAll(),
      togglePin: (id) => layoutRef.current.togglePin(id),
      unpinAll: () => layoutRef.current.unpinAll(),
      isPinned: (id) => layoutRef.current.isPinned(id),
      getCamera: () => {
        const { x, y, ratio } = sigma.getCamera().getState();
        return { x, y, ratio };
      },
      setCamera: (state) => sigma.getCamera().setState(state),
    }),
    [camera, sigma],
  );

  // Labels are drawn onto a 2D canvas once; if the webfont lands after the
  // first frame they would stay in the fallback face until the next redraw.
  useEffect(() => {
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled) sigma.refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [sigma]);

  // --- Budgets: none of these rebuild sigma, so a rotation keeps the camera -----
  const pixelRatioCap = budgets?.pixelRatioCap ?? null;
  useEffect(() => {
    if (pixelRatioCap === null) return undefined;
    return capPixelRatio(sigma, pixelRatioCap);
  }, [sigma, pixelRatioCap]);

  const labelDensity = budgets ? LABEL_DENSITY[budgets.labelDensity] : null;
  const labelThreshold = budgets ? (budgets.constrained ? 12 : 8) : null;
  useEffect(() => {
    if (labelDensity !== null && labelThreshold !== null) {
      setSettings({ labelDensity, labelRenderedSizeThreshold: labelThreshold });
    }
  }, [labelDensity, labelThreshold, setSettings]);

  const hideEdgesAbove = budgets?.hideEdgesOnMoveAbove ?? null;
  useEffect(() => {
    if (hideEdgesAbove === null) return;
    setSettings({ hideEdgesOnMove: graph.size > hideEdgesAbove });
  }, [graph, version, hideEdgesAbove, setSettings]);

  // The camera, readable from the DOM: the rotation test and any tool that needs to know where we are looking.
  useEffect(() => {
    const container = sigma.getContainer();
    const write = () => {
      const { x, y, ratio } = sigma.getCamera().getState();
      container.dataset.cameraX = x.toFixed(4);
      container.dataset.cameraY = y.toFixed(4);
      container.dataset.cameraRatio = ratio.toFixed(4);
    };
    write();
    sigma.getCamera().on('updated', write);
    return () => {
      sigma.getCamera().removeListener('updated', write);
    };
  }, [sigma]);

  // Read by `tests/visual` (touch emulation drives a canvas it cannot see into): where a node is drawn,
  // in px from the canvas's top-left. A read-only probe on the container; nothing in the app calls it.
  useEffect(() => {
    const container = sigma.getContainer() as HTMLElement & { kvoxProbe?: unknown };
    container.kvoxProbe = {
      nodeViewport: (id: string) => {
        if (!graph.hasNode(id)) return null;
        const attributes = graph.getNodeAttributes(id) as { x: number; y: number; size: number };
        const at = sigma.graphToViewport({ x: attributes.x, y: attributes.y });
        return { x: at.x, y: at.y, size: sigma.scaleSize(attributes.size) };
      },
    };
    return () => {
      delete container.kvoxProbe;
    };
  }, [sigma, graph]);

  // --- Reducers: visibility, highlight, rings, labels ---------------------------
  // View state goes through the reducers, never into the graph's attributes.
  const markedKey = markedIds ? [...markedIds].sort().join(',') : '';
  const dimmedKey = dimmedIds ? [...dimmedIds].sort().join(',') : '';
  // Hover is for a pointer; a touch preview takes its place on a phone.
  const focusId = (touch ? null : hoverId) ?? previewId;
  const constrained = budgets?.constrained ?? compact;
  useEffect(() => {
    const context = {
      graph,
      visibleIds,
      selectedId,
      focusId,
      hoveredEdgeId,
      markedIds: new Set(markedKey ? markedKey.split(',') : []),
      dimmedIds: dimmedKey ? new Set(dimmedKey.split(',')) : null,
      accent: theme.palette.primary.main,
      dimColor,
      compact: constrained,
    };
    setSettings({
      nodeReducer: buildNodeReducer(context) as Settings['nodeReducer'],
      edgeReducer: buildEdgeReducer(context) as Settings['edgeReducer'],
    });
    // `version` is a dependency on purpose: a merge changes neighbourhoods.
  }, [
    graph,
    version,
    visibleIds,
    selectedId,
    focusId,
    hoveredEdgeId,
    markedKey,
    dimmedKey,
    dimColor,
    constrained,
    theme.palette.primary.main,
    setSettings,
  ]);

  // --- Keep the selection out from under the inspector --------------------------
  const insetsKey = revealInsets
    ? `${revealInsets.top},${revealInsets.right},${revealInsets.bottom},${revealInsets.left}`
    : '';
  useEffect(() => {
    if (!revealInsets || !selectedId || !graph.hasNode(selectedId)) return undefined;
    const frame = requestAnimationFrame(() => {
      if (!graph.hasNode(selectedId)) return;
      const { width, height } = sigma.getDimensions();
      if (width === 0 || height === 0) return;
      const attributes = graph.getNodeAttributes(selectedId) as { x: number; y: number };
      const at = sigma.graphToViewport({ x: attributes.x, y: attributes.y });
      const delta = revealDelta(at, { width, height }, revealInsets);
      if (!delta) return;
      const centre = sigma.viewportToFramedGraph({ x: width / 2 - delta.x, y: height / 2 - delta.y });
      const target = { x: centre.x, y: centre.y };
      if (reducedMotion) sigma.getCamera().setState(target);
      else void sigma.getCamera().animate(target, { duration: 250 });
    });
    return () => cancelAnimationFrame(frame);
    // The insets are compared by value (`insetsKey`), not identity.
  }, [sigma, graph, selectedId, insetsKey, reducedMotion]);

  // --- Events, including drag and the touch model -----------------------------
  const handlers = useRef({ onNodeClick, onNodeDoubleClick, onStageClick, onEdgeClick, onNodeContextMenu });
  handlers.current = { onNodeClick, onNodeDoubleClick, onStageClick, onEdgeClick, onNodeContextMenu };
  const hitRadius = touch ? (budgets?.hitTargetPx || 44) / 2 : 0;
  const visibleRef = useRef(visibleIds);
  visibleRef.current = visibleIds;
  const longPressRef = useRef<LongPress | null>(null);

  useEffect(() => {
    if (!interactive) return;
    let dragged: string | null = null;
    let moved = false;

    const nearest = (point: { x: number; y: number }): string | null => {
      if (hitRadius <= 0) return null;
      return pickNearestNode(
        visibleRef.current,
        (id) => {
          if (!graph.hasNode(id)) return null;
          const attributes = graph.getNodeAttributes(id) as { x: number; y: number; size: number };
          const at = sigma.graphToViewport({ x: attributes.x, y: attributes.y });
          return { x: at.x, y: at.y, size: sigma.scaleSize(attributes.size) };
        },
        point,
        hitRadius,
      );
    };

    registerEvents({
      clickNode: ({ node }) => {
        if (moved || longPressRef.current?.fired()) return;
        // A "+N more" stub is activated, not selected: activating it expands its type.
        if (graph.getNodeAttribute(node, 'isStub') === true) {
          handlers.current.onNodeDoubleClick(node);
          return;
        }
        handlers.current.onNodeClick(node);
      },
      enterNode: ({ node }) => {
        if (!touch) setHoverId(node);
      },
      leaveNode: () => setHoverId(null),
      enterEdge: ({ edge }) => {
        if (!touch) setHoveredEdgeId(edge);
      },
      leaveEdge: () => setHoveredEdgeId(null),
      doubleClickNode: (event) => {
        // Sigma's default for a double-click is to zoom; here it expands.
        event.preventSigmaDefault();
        if (graph.getNodeAttribute(event.node, 'isStub') === true) {
          handlers.current.onNodeDoubleClick(event.node);
          return;
        }
        if (touch) {
          // Sigma reports a quick second tap as a double-tap INSTEAD of a tap. On touch that is the
          // "second tap" that opens the inspector, and it must not also expand.
          handlers.current.onNodeClick(event.node);
          return;
        }
        handlers.current.onNodeDoubleClick(event.node);
      },
      clickStage: (event) => {
        if (longPressRef.current?.fired()) return;
        const hit = touch ? nearest({ x: event.event.x, y: event.event.y }) : null;
        if (hit && graph.getNodeAttribute(hit, 'isStub') === true) handlers.current.onNodeDoubleClick(hit);
        else if (hit) handlers.current.onNodeClick(hit);
        else handlers.current.onStageClick();
      },
      clickEdge: ({ edge }) => handlers.current.onEdgeClick?.(edge),
      rightClickNode: ({ node, event }) => {
        event.original.preventDefault();
        const rect = sigma.getContainer().getBoundingClientRect();
        handlers.current.onNodeContextMenu?.({
          id: node,
          clientX: rect.left + event.x,
          clientY: rect.top + event.y,
          source: 'right-click',
        });
      },
      downNode: ({ node }) => {
        dragged = node;
        moved = false;
      },
      mousemovebody: (event) => {
        if (!dragged) return;
        // On touch a node moves only after a long-press: a plain drag pans the camera.
        if (touch && !longPressRef.current?.fired()) return;
        moved = true;
        const position = sigma.viewportToGraph(event);
        graph.mergeNodeAttributes(dragged, { x: position.x, y: position.y, fixed: true });
        event.preventSigmaDefault();
        event.original.preventDefault();
        event.original.stopPropagation();
      },
      mouseup: () => {
        if (dragged && moved && graph.hasNode(dragged)) {
          const { x, y } = graph.getNodeAttributes(dragged);
          layoutRef.current.pin(dragged, { x: x as number, y: y as number });
        }
        dragged = null;
      },
      mousedown: () => {
        // Keep the camera still while a node is held.
        if (!sigma.getCustomBBox()) sigma.setCustomBBox(sigma.getBBox());
      },
    });

    if (!touch) return undefined;

    // Touch: long-press (context menu + arms dragging), cancelled by a second finger or a wander.
    let pressed: string | null = null;
    const longPress = createLongPress({
      onLongPress: (point) => {
        if (!pressed) return;
        const rect = sigma.getContainer().getBoundingClientRect();
        handlers.current.onNodeContextMenu?.({
          id: pressed,
          clientX: rect.left + point.x,
          clientY: rect.top + point.y,
          source: 'long-press',
        });
      },
    });
    longPressRef.current = longPress;
    const touchCaptor = sigma.getTouchCaptor();
    const onTouchDown = (event: { touches: Array<{ x: number; y: number }> }) => {
      if (event.touches.length !== 1) {
        longPress.cancel();
        return;
      }
      const point = event.touches[0]!;
      pressed = nearest(point);
      moved = false;
      if (pressed) {
        // Keep the camera still while a node is held, so it does not slide under the finger.
        if (!sigma.getCustomBBox()) sigma.setCustomBBox(sigma.getBBox());
        dragged = pressed;
        longPress.start(point);
      }
    };
    const onTouchMove = (event: { touches: Array<{ x: number; y: number }> }) => {
      if (event.touches.length !== 1) longPress.cancel();
      else longPress.move(event.touches[0]!);
    };
    const onTouchUp = () => {
      longPress.cancel();
      dragged = null;
    };
    touchCaptor.on('touchdown', onTouchDown);
    touchCaptor.on('touchmove', onTouchMove);
    touchCaptor.on('touchup', onTouchUp);
    return () => {
      longPress.cancel();
      longPressRef.current = null;
      touchCaptor.removeListener('touchdown', onTouchDown);
      touchCaptor.removeListener('touchmove', onTouchMove);
      touchCaptor.removeListener('touchup', onTouchUp);
    };
  }, [graph, interactive, registerEvents, sigma, touch, hitRadius]);

  return null;
}
