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
 *   - after each `version` change with `layout === 'forceatlas'`, a short
 *     (~1.5 s) ForceAtlas2 settle of a fixed iteration count. `layout ===
 *     'static'` never moves a node, which is what the visual baselines and
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
import Box from '@mui/material/Box';
import { alpha, useTheme } from '@mui/material/styles';
import type Graph from 'graphology';
import forceAtlas2, { inferSettings } from 'graphology-layout-forceatlas2';
import { useEffect, useImperativeHandle, useMemo, useRef, type Ref } from 'react';

/**
 * One ForceAtlas2 settle: a FIXED number of iterations, a few per animation
 * frame — about 1.5 s at 60 fps. Bounded by count rather than by the clock so
 * the same graph always settles to the same picture, however fast the machine.
 */
export const FA2_SETTLE_ITERATIONS = 180;
const FA2_ITERATIONS_PER_FRAME = 2;

export interface GraphCanvasControls {
  zoomIn: () => void;
  zoomOut: () => void;
  /** Animated camera reset — "Fit". */
  fit: () => void;
}

export interface GraphCanvasProps {
  graph: Graph;
  /** Increments on every mutation of `graph`; the canvas re-syncs on change. */
  version: number;
  visibleIds: ReadonlySet<string>;
  selectedId: string | null;
  layout: 'forceatlas' | 'static';
  onNodeClick: (id: string) => void;
  onNodeDoubleClick: (id: string) => void;
  onStageClick: () => void;
  onEdgeClick?: (id: string) => void;
  height: number | string;
  /** `false`: no pan, zoom, drag or clicks (the phone widget, which must not trap scroll). */
  interactive?: boolean;
  /** Zoom/fit for keyboard controls and toolbar buttons. */
  controlsRef?: Ref<GraphCanvasControls>;
  /** An accessible name for the drawing surface itself. */
  ariaLabel?: string;
}

export default function GraphCanvas(props: GraphCanvasProps) {
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
      defaultEdgeType: 'arrow',
      renderEdgeLabels: false,
      enableEdgeEvents: Boolean(onEdgeClick) && interactive,
      enableCameraZooming: interactive,
      enableCameraPanning: interactive,
      zIndex: true,
      allowInvalidContainer: true,
    }),
    [theme.palette.text.primary, theme.typography.fontFamily, onEdgeClick, interactive],
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
  const dimColor = alpha(theme.palette.text.disabled, 0.35);

  useImperativeHandle(
    controlsRef,
    () => ({
      zoomIn: () => camera.zoomIn(),
      zoomOut: () => camera.zoomOut(),
      fit: () => camera.reset({ duration: 300 }),
    }),
    [camera],
  );

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
