/**
 * The explorer's lasso (GIC-14, #675): hold Shift and drag on the stage, or drag with the Select tool on,
 * to draw a freehand loop; the nodes inside it are marked. A press that lands on a node is left to the
 * canvas (shift-click toggles that node, a plain press drags it), so the two gestures never fight.
 *
 * RENDERER-AGNOSTIC (#775). It listens on `container` (the canvas's element) in the CAPTURE phase and stops
 * the press from reaching the G6 canvas underneath, so the camera does not pan under the loop. Where each
 * node is drawn comes from `positions`, which the canvas computes in viewport px. The geometry is
 * `lassoGeometry.ts`, unit-tested without a canvas; a keyboard has its own way to mark nodes (Select mode,
 * then Space on the focused node).
 */

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

/**
 * A node as the lasso sees it: its id, where it is drawn in viewport px, and its drawn radius.
 *
 * @stability experimental
 */
export type LassoTarget = LassoNode & { radius: number };

/**
 * Props of {@link LassoBehaviour}.
 *
 * @stability experimental
 */
export interface LassoBehaviourProps {
  /** The element the canvas draws into; the lasso listens on it and draws over it. `null` until mounted. */
  container: HTMLElement | null;
  /** The visible, selectable nodes and where they are drawn, read when a press starts and when the loop closes. */
  positions: () => LassoTarget[];
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
export function LassoBehaviour({ container, positions, selectTool, onLasso }: LassoBehaviourProps) {
  const theme = useTheme();
  const [points, setPoints] = useState<readonly LassoPoint[]>([]);
  const latest = useRef({ positions, selectTool, onLasso });
  latest.current = { positions, selectTool, onLasso };

  useEffect(() => {
    if (!container) return undefined;
    const host = container;
    let drawing: readonly LassoPoint[] | null = null;

    const local = (event: { clientX: number; clientY: number }): LassoPoint => {
      const rect = host.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    const stop = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onCancel, true);
      window.removeEventListener('keydown', onKey, true);
      drawing = null;
      setPoints((current) => (current.length === 0 ? current : []));
    };
    const onMove = (event: PointerEvent) => {
      if (!drawing) return;
      event.stopPropagation();
      drawing = appendLassoPoint(drawing, local(event));
      setPoints(drawing);
    };
    const onUp = (event: PointerEvent) => {
      const finished = drawing;
      event.stopPropagation();
      stop();
      // The click the browser sends after this press must not reach the canvas, or it would clear the selection.
      const swallow = (click: Event) => click.stopPropagation();
      host.addEventListener('click', swallow, { capture: true, once: true });
      window.setTimeout(() => host.removeEventListener('click', swallow, true), 0);
      if (!finished || !isLassoSelection(finished)) return;
      const ids = nodesInPolygon(latest.current.positions(), finished);
      if (ids.length > 0) latest.current.onLasso(ids);
    };
    const onCancel = () => stop();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') stop();
    };
    const onDown = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      if (event.button !== 0 || !(event.shiftKey || latest.current.selectTool)) return;
      const start = local(event);
      // On a node: the canvas handles it (shift-click toggles, a plain press drags).
      if (nodeAtPoint(latest.current.positions(), start)) return;
      event.stopPropagation();
      event.preventDefault();
      drawing = [start];
      setPoints(drawing);
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onCancel, true);
      window.addEventListener('keydown', onKey, true);
    };

    host.addEventListener('pointerdown', onDown, true);
    return () => {
      host.removeEventListener('pointerdown', onDown, true);
      stop();
    };
  }, [container]);

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
