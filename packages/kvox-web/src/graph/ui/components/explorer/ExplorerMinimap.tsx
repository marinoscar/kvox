/**
 * `ExplorerMinimap` — a small overview of where the canvas is looking (GIC-09,
 * #670; epic #661): every drawn node as a dot, and a rectangle for the part of
 * the graph the canvas shows. Pressing or dragging on it centres the camera
 * there.
 *
 * A POINTER AID, NOT A CONTROL FOR EVERYONE. It is `aria-hidden`: a keyboard or
 * screen-reader user keeps `0` (fit), the arrow keys between nodes, the command
 * palette and the list view. Whether it shows is {@link minimapVisible}'s rule
 * (never on a phone, on request on a tablet, above 150 nodes on a laptop).
 *
 * It is drawn as SVG: the explorer holds at most 300 nodes, so the dots are
 * cheap, and a vector keeps it sharp at any pixel ratio. It re-reads the node
 * positions on every frame the canvas draws (batched to one update per
 * animation frame), so a layout settling is followed too.
 */

import Box from '@mui/material/Box';
import { useTheme } from '@mui/material/styles';
import { useCallback, useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';

import type { ExplorerGraph } from './explorerModel.js';
import type { CanvasViewport, GraphCanvasControls } from './GraphCanvas.js';

/** Width of the minimap in px. */
export const MINIMAP_WIDTH = 168;
/** Height of the minimap in px. */
export const MINIMAP_HEIGHT = 112;
const PADDING = 8;
const DOT_RADIUS = 2;

/** Props of {@link ExplorerMinimap}. */
export interface ExplorerMinimapProps {
  /** The graph on the canvas. */
  graph: ExplorerGraph;
  /** Increments whenever `graph` is mutated, so the dots are redrawn. */
  version: number;
  /** The nodes the canvas draws. */
  visibleIds: ReadonlySet<string>;
  /** The canvas's controls: the viewport, the frame subscription and the pan. */
  controlsRef: RefObject<GraphCanvasControls | null>;
}

interface Dot {
  id: string;
  x: number;
  y: number;
  color: string;
}

interface MinimapFrame {
  dots: Dot[];
  /** The viewport rectangle in minimap px, or `null` before the canvas has a size. */
  rect: { x: number; y: number; width: number; height: number } | null;
  /** Minimap px back to a graph point; `null` when the graph has no extent. */
  toGraph: ((px: number, py: number) => { x: number; y: number }) | null;
}

const EMPTY: MinimapFrame = { dots: [], rect: null, toGraph: null };

/**
 * Lays the nodes and the viewport out in the minimap's box. The scale is the
 * same on both axes, so the picture is the graph's own shape. The viewport may
 * reach beyond the box (zoomed out); the minimap clips it.
 */
export function minimapFrame(
  graph: ExplorerGraph,
  visibleIds: ReadonlySet<string>,
  viewport: CanvasViewport | null,
  width: number = MINIMAP_WIDTH,
  height: number = MINIMAP_HEIGHT,
): MinimapFrame {
  const points: { id: string; x: number; y: number; color: string }[] = [];
  for (const id of visibleIds) {
    if (!graph.hasNode(id)) continue;
    const { x, y, color } = graph.getNodeAttributes(id);
    if (Number.isFinite(x) && Number.isFinite(y)) points.push({ id, x, y, color });
  }
  if (points.length === 0) return EMPTY;

  // Sigma's y may point up or down; the viewport's own corners say which, so the picture matches the canvas.
  const flipY = viewport ? viewport.bottomRight.y < viewport.topLeft.y : false;

  // The box is the NODES' extent with a margin, never the viewport's: a box that grew with the
  // viewport would rescale under the pointer while the viewport is being dragged.
  let minX = Math.min(...points.map((p) => p.x));
  let maxX = Math.max(...points.map((p) => p.x));
  let minY = Math.min(...points.map((p) => p.y));
  let maxY = Math.max(...points.map((p) => p.y));
  const marginX = Math.max((maxX - minX) * 0.15, 1e-3);
  const marginY = Math.max((maxY - minY) * 0.15, 1e-3);
  minX -= marginX;
  maxX += marginX;
  minY -= marginY;
  maxY += marginY;
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const scale = Math.min((width - 2 * PADDING) / spanX, (height - 2 * PADDING) / spanY);
  const offsetX = (width - spanX * scale) / 2;
  const offsetY = (height - spanY * scale) / 2;
  const toPx = (x: number, y: number) => ({
    x: offsetX + (x - minX) * scale,
    y: offsetY + ((flipY ? maxY - y : y - minY)) * scale,
  });

  const dots = points.map((p) => ({ id: p.id, color: p.color, ...toPx(p.x, p.y) }));
  let rect: MinimapFrame['rect'] = null;
  if (viewport) {
    const a = toPx(viewport.topLeft.x, viewport.topLeft.y);
    const b = toPx(viewport.bottomRight.x, viewport.bottomRight.y);
    rect = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
  }
  const toGraph = (px: number, py: number) => ({
    x: minX + (px - offsetX) / scale,
    y: flipY ? maxY - (py - offsetY) / scale : minY + (py - offsetY) / scale,
  });
  return { dots, rect, toGraph };
}

/**
 * The minimap: node dots plus the viewport rectangle; press or drag to pan the canvas.
 */
export function ExplorerMinimap({ graph, version, visibleIds, controlsRef }: ExplorerMinimapProps) {
  const theme = useTheme();
  const [frame, setFrame] = useState<MinimapFrame>(EMPTY);
  const dragging = useRef(false);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const pending = useRef<number | null>(null);

  const measure = useCallback(() => {
    pending.current = null;
    setFrame(minimapFrame(graph, visibleIds, controlsRef.current?.getViewport?.() ?? null));
  }, [graph, visibleIds, controlsRef]);

  const schedule = useCallback(() => {
    if (pending.current !== null) return;
    pending.current = window.requestAnimationFrame(measure);
  }, [measure]);

  // Redraw when the graph changes, and on every frame the canvas draws.
  useEffect(() => {
    measure();
    const unsubscribe = controlsRef.current?.onFrame?.(schedule);
    return () => {
      unsubscribe?.();
      if (pending.current !== null) window.cancelAnimationFrame(pending.current);
      pending.current = null;
    };
  }, [measure, schedule, controlsRef, version]);

  const panTo = (event: PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg || !frame.toGraph) return;
    const box = svg.getBoundingClientRect();
    const px = ((event.clientX - box.left) / (box.width || MINIMAP_WIDTH)) * MINIMAP_WIDTH;
    const py = ((event.clientY - box.top) / (box.height || MINIMAP_HEIGHT)) * MINIMAP_HEIGHT;
    const at = frame.toGraph(px, py);
    controlsRef.current?.panToGraph?.(at.x, at.y);
  };

  return (
    <Box
      aria-hidden="true"
      data-testid="explorer-minimap"
      sx={{
        width: MINIMAP_WIDTH,
        height: MINIMAP_HEIGHT,
        bgcolor: 'background.paper',
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        boxShadow: 1,
        overflow: 'hidden',
        opacity: 0.95,
        touchAction: 'none',
      }}
    >
      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        viewBox={`0 0 ${MINIMAP_WIDTH} ${MINIMAP_HEIGHT}`}
        style={{ display: 'block', cursor: 'grab', touchAction: 'none' }}
        onPointerDown={(event) => {
          dragging.current = true;
          try {
            event.currentTarget.setPointerCapture?.(event.pointerId);
          } catch {
            // A pointer that is already gone: the drag simply ends.
          }
          panTo(event);
        }}
        onPointerMove={(event) => {
          if (dragging.current) panTo(event);
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
      >
        {frame.dots.map((dot) => (
          <circle key={dot.id} cx={dot.x} cy={dot.y} r={DOT_RADIUS} fill={dot.color} />
        ))}
        {frame.rect && (
          <rect
            data-testid="minimap-viewport"
            x={frame.rect.x}
            y={frame.rect.y}
            width={frame.rect.width}
            height={frame.rect.height}
            fill={theme.palette.primary.main}
            fillOpacity={0.12}
            stroke={theme.palette.primary.main}
            strokeWidth={1.5}
            rx={2}
          />
        )}
      </svg>
    </Box>
  );
}
