/**
 * The explorer's lasso (GIC-14, #675): hold Shift and drag on the stage, or drag with the Select tool on,
 * to draw a freehand loop; the nodes inside it are marked. A press that lands on a node is left to sigma
 * (shift-click toggles that node, a plain press drags it), so the two gestures never fight.
 *
 * Rendered INSIDE `SigmaContainer` by `GraphCanvas`, which keeps it in the lazily loaded canvas chunk like
 * the rest of sigma. The listeners sit on the canvas's wrapper in the CAPTURE phase and stop the press from
 * reaching sigma, so the camera does not pan under the loop. The geometry is `lassoGeometry.ts`, unit-tested
 * without a canvas; a keyboard has its own way to mark nodes (Select mode, then Space on the focused node).
 */

import { useSigma } from '@react-sigma/core';
import { useTheme } from '@mui/material/styles';
import { useEffect, useRef, useState } from 'react';

import {
  appendLassoPoint,
  isLassoSelection,
  nodeAtPoint,
  nodesInPolygon,
  type LassoNode,
  type LassoPoint,
} from './lassoGeometry.js';

/** The part of the canvas's graph the lasso reads. */
interface LassoGraph {
  hasNode(id: string): boolean;
  getNodeAttributes(id: string): Record<string, unknown>;
}

/**
 * Props of {@link LassoBehaviour}.
 *
 * @stability experimental
 */
export interface LassoBehaviourProps {
  /** The canvas's graph; node `x`, `y` and `size` are read. */
  graph: LassoGraph;
  /** The nodes that are drawn; a hidden node is never selected. */
  visibleIds: ReadonlySet<string>;
  /** The Select tool (a pointer): a plain drag draws the loop. Shift always does. */
  selectTool: boolean;
  /** The loop was closed: the ids of the visible nodes inside it. */
  onLasso: (ids: string[]) => void;
}

/**
 * Draws the lasso loop and reports the nodes inside it. Renders an SVG overlay only while a loop is being drawn.
 *
 * @stability experimental
 */
export function LassoBehaviour({ graph, visibleIds, selectTool, onLasso }: LassoBehaviourProps) {
  const sigma = useSigma();
  const theme = useTheme();
  const [points, setPoints] = useState<readonly LassoPoint[]>([]);
  const latest = useRef({ graph, visibleIds, selectTool, onLasso });
  latest.current = { graph, visibleIds, selectTool, onLasso };

  useEffect(() => {
    const container = sigma.getContainer();
    const host = container.parentElement ?? container;
    let drawing: readonly LassoPoint[] | null = null;

    const local = (event: MouseEvent): LassoPoint => {
      const rect = container.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const positions = (): Array<LassoNode & { radius: number }> => {
      const { graph: g, visibleIds: visible } = latest.current;
      const out: Array<LassoNode & { radius: number }> = [];
      for (const id of visible) {
        if (!g.hasNode(id)) continue;
        const attributes = g.getNodeAttributes(id) as { x?: number; y?: number; size?: number; isStub?: boolean };
        if (typeof attributes.x !== 'number' || typeof attributes.y !== 'number' || attributes.isStub) continue;
        const at = sigma.graphToViewport({ x: attributes.x, y: attributes.y });
        out.push({ id, x: at.x, y: at.y, radius: sigma.scaleSize(attributes.size ?? 5) });
      }
      return out;
    };

    const stop = () => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      window.removeEventListener('keydown', onKey, true);
      drawing = null;
      setPoints((current) => (current.length === 0 ? current : []));
    };
    const onMove = (event: MouseEvent) => {
      if (!drawing) return;
      drawing = appendLassoPoint(drawing, local(event));
      setPoints(drawing);
    };
    const onUp = () => {
      const finished = drawing;
      stop();
      // The click the browser sends after this press must not reach sigma, or it would clear the selection.
      const swallow = (event: Event) => event.stopPropagation();
      host.addEventListener('click', swallow, { capture: true, once: true });
      window.setTimeout(() => host.removeEventListener('click', swallow, true), 0);
      if (!finished || !isLassoSelection(finished)) return;
      const ids = nodesInPolygon(positions(), finished);
      if (ids.length > 0) latest.current.onLasso(ids);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') stop();
    };
    const onDown = (event: MouseEvent) => {
      if (event.button !== 0 || !(event.shiftKey || latest.current.selectTool)) return;
      const start = local(event);
      // On a node: sigma handles it (shift-click toggles, a plain press drags).
      if (nodeAtPoint(positions(), start)) return;
      event.stopPropagation();
      event.preventDefault();
      drawing = [start];
      setPoints(drawing);
      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('mouseup', onUp, true);
      window.addEventListener('keydown', onKey, true);
    };

    host.addEventListener('mousedown', onDown, true);
    return () => {
      host.removeEventListener('mousedown', onDown, true);
      stop();
    };
  }, [sigma]);

  if (points.length < 2) return null;
  const colour = theme.palette.primary.main;
  return (
    <svg
      aria-hidden="true"
      data-testid="lasso-overlay"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 5 }}
    >
      <polygon
        points={points.map((point) => `${point.x},${point.y}`).join(' ')}
        fill={colour}
        fillOpacity={0.12}
        stroke={colour}
        strokeWidth={1.5}
        strokeDasharray="6 4"
      />
    </svg>
  );
}
