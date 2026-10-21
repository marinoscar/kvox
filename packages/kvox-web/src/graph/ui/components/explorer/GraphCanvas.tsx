/**
 * `GraphCanvas` — the ONE file that imports sigma (#374, epic #347; spec §22.1).
 *
 * A thin wrapper over `@react-sigma/core`'s `SigmaContainer`, deliberately
 * generic so the whole-graph overview (#375) can reuse it: it renders the
 * `x`, `y`, `size`, `color` and `label` attributes ALREADY on each graphology
 * node and edge (written by `explorerModel`, or by the overview's model) and
 * computes no styling of its own. What it adds:
 *
 *   - reducers that hide nodes outside `visibleIds` and dim everything that is
 *     not the selection or one of its neighbours;
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
 */

import '@react-sigma/core/lib/style.css';

import {
  SigmaContainer,
  useCamera,
  useRegisterEvents,
  useSetSettings,
  useSigma,
} from '@react-sigma/core';
import Box from '@mui/material/Box';
import { alpha, useTheme } from '@mui/material/styles';
import type { MultiDirectedGraph, UndirectedGraph } from 'graphology';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useEffect, useImperativeHandle, useMemo, useRef, type Ref } from 'react';
import type { Settings } from 'sigma/settings';

import { layoutBudgetMs } from './layout/layoutBudgets.js';
import { useCanvasLayout, type CanvasLayout } from './layout/useCanvasLayout.js';
import { useReducedMotion } from './layout/useReducedMotion.js';

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
}

export function GraphCanvas(props: GraphCanvasProps) {
  const { graph, height, interactive = true, onEdgeClick, ariaLabel } = props;
  const theme = useTheme();

  // STABLE settings: `SigmaContainer` rebuilds sigma whenever these change, so
  // everything that varies per render (reducers, selection) goes through
  // `useSetSettings` inside the container instead.
  const settings = useMemo(
    () => ({
      labelRenderedSizeThreshold: 8,
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
      renderEdgeLabels: false,
      enableEdgeEvents: Boolean(onEdgeClick) && interactive,
      enableCameraZooming: interactive,
      enableCameraPanning: interactive,
      zIndex: true,
      allowInvalidContainer: true,
    }),
    [theme.palette.text.primary, theme.palette.background.paper, theme.palette.divider, theme.typography.fontFamily, onEdgeClick, interactive],
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
  seedIds,
  pinsKey,
  onPinnedCountChange,
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

  const reducedMotion = useReducedMotion();
  const compact = useMediaQuery(theme.breakpoints.down('sm'));
  const coarse = useMediaQuery('(pointer: coarse)');
  const layoutControls = useCanvasLayout({
    graph,
    version,
    layout,
    seedIds,
    pinsKey,
    reducedMotion,
    budgetMs: layoutBudgetMs(compact || coarse),
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

  // --- Reducers: visibility and selection dimming ---------------------------
  useEffect(() => {
    const neighbours = new Set<string>();
    if (selectedId && graph.hasNode(selectedId)) {
      neighbours.add(selectedId);
      graph.forEachNeighbor(selectedId, (id) => neighbours.add(id));
    }
    const hasSelection = neighbours.size > 0;
    setSettings({
      nodeReducer: (node, data) => {
        if (!visibleIds.has(node)) return { ...data, hidden: true };
        if (!hasSelection) return data;
        if (node === selectedId) return { ...data, highlighted: true, zIndex: 2 };
        if (neighbours.has(node)) return { ...data, zIndex: 1 };
        return { ...data, color: dimColor, label: '', zIndex: 0 };
      },
      edgeReducer: (edge, data) => {
        const [source, target] = graph.extremities(edge);
        if (!visibleIds.has(source) || !visibleIds.has(target)) return { ...data, hidden: true };
        if (!hasSelection) return data;
        if (source === selectedId || target === selectedId) return { ...data, zIndex: 1 };
        return { ...data, color: dimColor, zIndex: 0 };
      },
    });
    // `version` is a dependency on purpose: a merge changes neighbourhoods.
  }, [graph, version, visibleIds, selectedId, dimColor, setSettings]);

  // --- Events, including drag --------------------------------------------------
  const handlers = useRef({ onNodeClick, onNodeDoubleClick, onStageClick, onEdgeClick });
  handlers.current = { onNodeClick, onNodeDoubleClick, onStageClick, onEdgeClick };

  useEffect(() => {
    if (!interactive) return;
    let dragged: string | null = null;
    let moved = false;
    registerEvents({
      clickNode: ({ node }) => {
        if (moved) return;
        handlers.current.onNodeClick(node);
      },
      doubleClickNode: (event) => {
        // Sigma's default for a double-click is to zoom; here it expands.
        event.preventSigmaDefault();
        handlers.current.onNodeDoubleClick(event.node);
      },
      clickStage: () => handlers.current.onStageClick(),
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
  }, [graph, interactive, registerEvents, sigma]);

  return null;
}
