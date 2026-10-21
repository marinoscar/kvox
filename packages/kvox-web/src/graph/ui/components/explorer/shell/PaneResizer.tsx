/**
 * `PaneResizer` — the draggable, keyboard-operable divider between two panes
 * of the expanded Insight Canvas (GIC-08, #669).
 *
 * A WAI-ARIA window splitter: `role="separator"`, focusable, with
 * `aria-valuenow/min/max` in px. Arrow keys move it 16px (48px with Shift);
 * Home and End jump to the limits. Dragging uses pointer events, so mouse,
 * touch and pen all work, and `touch-action: none` keeps the page still.
 */

import Box from '@mui/material/Box';
import { useRef, type KeyboardEvent, type PointerEvent } from 'react';

/**
 * Props of {@link PaneResizer}.
 *
 * @stability experimental
 */
export interface PaneResizerProps {
  /** Which pane this divider resizes: dragging right grows a `left` pane and shrinks a `right` one. */
  pane: 'left' | 'right';
  /** The pane's current width in px. */
  value: number;
  /** Smallest width in px. */
  min: number;
  /** Largest width in px. */
  max: number;
  /** The accessible name, e.g. "Resize filters". */
  label: string;
  /** Called with the new width (already within `[min, max]`) on every move. */
  onChange: (width: number) => void;
}

const STEP = 16;
const BIG_STEP = 48;

/**
 * A vertical splitter that resizes the pane beside it.
 *
 * @stability experimental
 */
export function PaneResizer({ pane, value, min, max, label, onChange }: PaneResizerProps) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const clamp = (width: number) => Math.min(max, Math.max(min, Math.round(width)));
  const sign = pane === 'left' ? 1 : -1;

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: value };
    event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const state = drag.current;
    if (!state) return;
    onChange(clamp(state.startWidth + sign * (event.clientX - state.startX)));
  };

  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? BIG_STEP : STEP;
    let next: number;
    switch (event.key) {
      case 'ArrowLeft':
        next = value - sign * step;
        break;
      case 'ArrowRight':
        next = value + sign * step;
        break;
      case 'Home':
        next = min;
        break;
      case 'End':
        next = max;
        break;
      default:
        return;
    }
    event.preventDefault();
    onChange(clamp(next));
  };

  return (
    <Box
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      sx={(theme) => ({
        flex: '0 0 auto',
        width: 10,
        mx: '-4px',
        zIndex: 2,
        cursor: 'col-resize',
        touchAction: 'none',
        position: 'relative',
        '&::after': {
          content: '""',
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 4,
          width: 2,
          bgcolor: 'divider',
          transition: 'background-color 120ms',
        },
        '&:hover::after, &:focus-visible::after': { bgcolor: 'primary.main' },
        '&:focus-visible': { outline: 'none' },
        '@media (pointer: coarse)': { width: 20, mx: '-9px', '&::after': { left: 9 } },
        // The theme's divider is one px; the grab area is wider than it looks.
        borderRadius: theme.shape.borderRadius,
      })}
    />
  );
}
