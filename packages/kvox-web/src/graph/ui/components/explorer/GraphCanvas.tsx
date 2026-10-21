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
 *   - after each `version` change with `layout === 'forceatlas'`, a short
 *     (~1.5 s) ForceAtlas2 settle of a fixed iteration count. A `static` layout
 *     never moves a node, which is what the visual baselines and
 *     `prefers-reduced-motion` rely on.
 *
 * ⚠ THE FA2 SETTLE RUNS ON THE MAIN THREAD, IN FRAME-SIZED SLICES, NOT IN
 * `graphology-layout-forceatlas2/worker`. That supervisor spawns its worker
 * from a `blob:` URL, and production's CSP is `worker-src 'self'`
 * (`infra/nginx/csp.conf`): the worker would be refused in exactly the
 * environment that matters, and loosening the CSP for a layout is not a trade
 * worth making. At the explorer's 300-node cap one FA2 iteration is well under
 * a millisecond, so two per animation frame never block input.
 *
 * jsdom has no WebGL: tests `vi.mock` this module rather than import it.
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
import forceAtlas2Module, { inferSettings } from 'graphology-layout-forceatlas2';
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { createNodeCompoundProgram } from 'sigma/rendering';
import type { Settings } from 'sigma/settings';

import {
  CURVED_ARROW_PROGRAM,
  PICTOGRAM_PROGRAM,
  buildEdgeReducer,
  buildNodeReducer,
} from './explorerReducers.js';

// The library is CommonJS and sets `module.exports` to the layout function, which
// is what a bundler's and Node's default import both give; the typings declare it
// as a property of the module instead, so it is read through this cast.
const forceAtlas2 = forceAtlas2Module as unknown as typeof forceAtlas2Module.default;

/**
 * Any graph the canvas can draw (the explorer's directed multigraph, the overview's undirected one).
 *
 * @stability experimental
 */
export type GraphCanvasGraph = MultiDirectedGraph | UndirectedGraph;

/**
 * One ForceAtlas2 settle: a FIXED number of iterations, a few per animation
 * frame — about 1.5 s at 60 fps. Bounded by count rather than by the clock so
 * the same graph always settles to the same picture, however fast the machine.
 */
export const FA2_SETTLE_ITERATIONS = 180;
const FA2_ITERATIONS_PER_FRAME = 2;

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
  /** `forceatlas` settles the layout with ForceAtlas2; `static` draws the stored `x`/`y` as they are (reduced motion, visual baselines). */
  layout: 'forceatlas' | 'static';
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
  const compact = useMediaQuery(theme.breakpoints.down('sm'));
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
      }}
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
  layout,
  onNodeClick,
  onNodeDoubleClick,
  onStageClick,
  onEdgeClick,
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
  // A touch screen has no hover: the first tap on a node lights it, the second selects it.
  const touchPrimary = useMediaQuery('(hover: none)');
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [tappedId, setTappedId] = useState<string | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);

  useImperativeHandle(
    controlsRef,
    () => ({
      zoomIn: () => camera.zoomIn(),
      zoomOut: () => camera.zoomOut(),
      fit: () => camera.reset({ duration: 300 }),
    }),
    [camera],
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

  // --- Reducers: visibility, highlight, rings, labels ---------------------------
  // View state goes through the reducers, never into the graph's attributes.
  useEffect(() => {
    const context = {
      graph,
      visibleIds,
      selectedId,
      focusId: hoveredId ?? tappedId,
      hoveredEdgeId,
      accent: theme.palette.primary.main,
      dimColor,
      compact,
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
    hoveredId,
    tappedId,
    hoveredEdgeId,
    dimColor,
    compact,
    theme.palette.primary.main,
    setSettings,
  ]);

  // --- Events, including drag --------------------------------------------------
  const handlers = useRef({ onNodeClick, onNodeDoubleClick, onStageClick, onEdgeClick });
  handlers.current = { onNodeClick, onNodeDoubleClick, onStageClick, onEdgeClick };
  const touch = useRef(touchPrimary);
  touch.current = touchPrimary;
  const tapped = useRef<string | null>(null);
  tapped.current = tappedId;

  useEffect(() => {
    if (!interactive) return;
    let dragged: string | null = null;
    let moved = false;
    registerEvents({
      clickNode: ({ node }) => {
        if (moved) return;
        // A "+N more" stub is activated, not selected: activating it expands its type.
        if (graph.getNodeAttribute(node, 'isStub') === true) {
          handlers.current.onNodeDoubleClick(node);
          return;
        }
        // Touch: the first tap only lights the node and its neighbours.
        if (touch.current && tapped.current !== node) {
          setTappedId(node);
          return;
        }
        handlers.current.onNodeClick(node);
      },
      enterNode: ({ node }) => {
        if (!touch.current) setHoveredId(node);
      },
      leaveNode: () => setHoveredId(null),
      enterEdge: ({ edge }) => {
        if (!touch.current) setHoveredEdgeId(edge);
      },
      leaveEdge: () => setHoveredEdgeId(null),
      doubleClickNode: (event) => {
        // Sigma's default for a double-click is to zoom; here it expands.
        event.preventSigmaDefault();
        handlers.current.onNodeDoubleClick(event.node);
      },
      clickStage: () => {
        setTappedId(null);
        handlers.current.onStageClick();
      },
      clickEdge: ({ edge }) => handlers.current.onEdgeClick?.(edge),
      downNode: ({ node }) => {
        dragged = node;
        moved = false;
      },
      mousemovebody: (event) => {
        if (!dragged) return;
        moved = true;
        const position = sigma.viewportToGraph(event);
        graph.mergeNodeAttributes(dragged, { x: position.x, y: position.y, fixed: true });
        event.preventSigmaDefault();
        event.original.preventDefault();
        event.original.stopPropagation();
      },
      mouseup: () => {
        dragged = null;
      },
      mousedown: () => {
        // Keep the camera still while a node is held.
        if (!sigma.getCustomBBox()) sigma.setCustomBBox(sigma.getBBox());
      },
    });
  }, [graph, interactive, registerEvents, sigma]);

  // --- Layout ----------------------------------------------------------------
  useEffect(() => {
    if (layout !== 'forceatlas' || graph.order < 2) return undefined;
    const settings = inferSettings(graph);
    let done = 0;
    let frame = 0;
    const step = () => {
      forceAtlas2.assign(graph, { iterations: FA2_ITERATIONS_PER_FRAME, settings });
      done += FA2_ITERATIONS_PER_FRAME;
      if (done < FA2_SETTLE_ITERATIONS) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [graph, version, layout]);

  return null;
}
