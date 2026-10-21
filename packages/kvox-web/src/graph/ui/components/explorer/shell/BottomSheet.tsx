/**
 * `BottomSheet` — the compact (phone) inspector (GIC-08, #669; epic #661).
 *
 * Three snap points, like the Google and Apple Maps sheets:
 *
 *   - `peek`: 25% of the canvas area (never under 148px): the title and the
 *     actions, over the canvas, which stays usable above it;
 *   - `half`: 50%;
 *   - `full`: 92%, leaving a strip of canvas above so the sheet reads as a layer.
 *
 * Moving it:
 *
 *   - drag the handle (pointer events, so mouse, touch and pen); on release the
 *     sheet settles on the snap point nearest to where its velocity would carry
 *     it (inertia), and a fast swipe down from peek closes it;
 *   - tap the handle, or the peek itself, to go up one snap;
 *   - keyboard: the handle is a button; ArrowUp and ArrowDown change the snap,
 *     Home and End jump to peek and full, Enter and Space go up one snap;
 *     Escape closes from anywhere in the sheet.
 *
 * ARIA: a `region` at peek and half, a `dialog` at full (it is then the thing
 * the user is working in). Focus moves into the sheet when it opens; the layout
 * returns it to the canvas when it closes.
 *
 * Motion: a short ease between snaps, none while dragging, none at all under
 * `prefers-reduced-motion`. The bottom padding is the safe-area inset.
 */

import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import { alpha } from '@mui/material/styles';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';

import { useReducedMotion } from './useReducedMotion.js';

/**
 * The sheet's three resting heights.
 *
 * @stability experimental
 */
export type SheetSnap = 'peek' | 'half' | 'full';

/** Snap points from lowest to highest. */
export const SHEET_SNAPS: readonly SheetSnap[] = ['peek', 'half', 'full'];

/** Share of the container each snap takes. */
export const SHEET_SNAP_FRACTION: Readonly<Record<SheetSnap, number>> = {
  peek: 0.25,
  half: 0.5,
  full: 0.92,
};

/** The peek is never lower than this (px): enough for a title and a row of actions. */
export const SHEET_PEEK_MIN_PX = 148;

/** How far ahead (ms) a release's velocity projects the sheet. */
const INERTIA_MS = 200;
/** A drag shorter than this (px) is a tap. */
const TAP_SLOP_PX = 6;

/** Heights in px of the three snaps inside a container of `containerHeight`. */
export function snapHeights(containerHeight: number): Record<SheetSnap, number> {
  const peek = Math.min(
    Math.max(containerHeight * SHEET_SNAP_FRACTION.peek, SHEET_PEEK_MIN_PX),
    containerHeight * SHEET_SNAP_FRACTION.half,
  );
  return {
    peek,
    half: Math.max(containerHeight * SHEET_SNAP_FRACTION.half, peek),
    full: Math.max(containerHeight * SHEET_SNAP_FRACTION.full, peek),
  };
}

/** The snap above `snap`, or the same one at the top. */
export function snapUp(snap: SheetSnap): SheetSnap {
  return SHEET_SNAPS[Math.min(SHEET_SNAPS.indexOf(snap) + 1, SHEET_SNAPS.length - 1)]!;
}

/** The snap below `snap`, or the same one at the bottom. */
export function snapDown(snap: SheetSnap): SheetSnap {
  return SHEET_SNAPS[Math.max(SHEET_SNAPS.indexOf(snap) - 1, 0)]!;
}

/**
 * Where a drag that ends at `height` with `velocity` (px per ms, positive up)
 * lands: a snap point, or `close` for a swipe down off the peek.
 *
 * @stability experimental
 */
export function resolveSnap(input: {
  height: number;
  velocity: number;
  containerHeight: number;
}): SheetSnap | 'close' {
  const heights = snapHeights(input.containerHeight);
  const projected = input.height + input.velocity * INERTIA_MS;
  if (projected < heights.peek * 0.6) return 'close';
  let best: SheetSnap = 'peek';
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const snap of SHEET_SNAPS) {
    const distance = Math.abs(heights[snap] - projected);
    if (distance < bestDistance) {
      best = snap;
      bestDistance = distance;
    }
  }
  return best;
}

/** The CSS height of a snap, as a share of the positioned container. */
export const SHEET_SNAP_CSS: Readonly<Record<SheetSnap, string>> = {
  peek: `clamp(${SHEET_PEEK_MIN_PX}px, ${SHEET_SNAP_FRACTION.peek * 100}%, ${SHEET_SNAP_FRACTION.half * 100}%)`,
  half: `${SHEET_SNAP_FRACTION.half * 100}%`,
  full: `${SHEET_SNAP_FRACTION.full * 100}%`,
};

/**
 * Props of {@link BottomSheet}.
 *
 * @stability experimental
 */
export interface BottomSheetProps {
  /** Whether the sheet is shown. Closed, nothing renders. */
  open: boolean;
  /** The resting snap point. */
  snap: SheetSnap;
  /** Called with the snap the user moved the sheet to. */
  onSnapChange: (snap: SheetSnap) => void;
  /** Called on Escape or a swipe down off the peek. */
  onClose: () => void;
  /** The sheet's accessible name. */
  label: string;
  /** Reports the sheet's height in px whenever it changes (the layout keeps the canvas visible above it). */
  onHeightChange?: (height: number) => void;
  children?: ReactNode;
}

interface DragState {
  startY: number;
  startHeight: number;
  containerHeight: number;
  samples: Array<{ t: number; y: number }>;
  moved: boolean;
}

/**
 * The compact inspector: a draggable, keyboard-operable sheet with peek, half and full snaps, positioned at the bottom of its nearest positioned ancestor.
 *
 * @stability experimental
 */
export function BottomSheet(props: BottomSheetProps) {
  const { open, snap, onSnapChange, onClose, label, onHeightChange, children } = props;
  const reducedMotion = useReducedMotion();
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<DragState | null>(null);
  const [dragHeight, setDragHeight] = useState<number | null>(null);

  // Focus moves into the sheet when it opens (not on every snap change).
  useEffect(() => {
    if (open) sheetRef.current?.focus({ preventScroll: true });
  }, [open]);

  // Report the height: on mount, on every resize of the sheet, and while it is dragged.
  const report = useRef(onHeightChange);
  report.current = onHeightChange;
  useLayoutEffect(() => {
    const element = sheetRef.current;
    if (!open || !element) return undefined;
    const emit = () => report.current?.(Math.round(element.getBoundingClientRect().height));
    emit();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(emit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [open]);

  const containerHeightOf = useCallback((): number => {
    const parent = sheetRef.current?.offsetParent ?? sheetRef.current?.parentElement;
    return parent instanceof HTMLElement ? parent.clientHeight : 0;
  }, []);

  const onHandlePointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const sheet = sheetRef.current;
    if (!sheet) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = {
      startY: event.clientY,
      startHeight: sheet.getBoundingClientRect().height,
      containerHeight: containerHeightOf(),
      samples: [{ t: event.timeStamp, y: event.clientY }],
      moved: false,
    };
  };

  const onHandlePointerMove = (event: PointerEvent<HTMLElement>) => {
    const state = drag.current;
    if (!state) return;
    const delta = state.startY - event.clientY;
    if (!state.moved && Math.abs(delta) < TAP_SLOP_PX) return;
    state.moved = true;
    state.samples.push({ t: event.timeStamp, y: event.clientY });
    if (state.samples.length > 6) state.samples.shift();
    const max = snapHeights(state.containerHeight).full;
    setDragHeight(Math.min(max, Math.max(0, state.startHeight + delta)));
  };

  const finishDrag = (event: PointerEvent<HTMLElement>, cancelled: boolean) => {
    const state = drag.current;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (!state) return;
    if (!state.moved) {
      setDragHeight(null);
      if (!cancelled) onSnapChange(snapUp(snap));
      return;
    }
    const first = state.samples[0]!;
    const last = state.samples[state.samples.length - 1]!;
    const elapsed = Math.max(last.t - first.t, 1);
    // Positive when the finger moved up.
    const velocity = (first.y - last.y) / elapsed;
    const height = dragHeight ?? state.startHeight;
    setDragHeight(null);
    if (cancelled) return;
    const next = resolveSnap({ height, velocity, containerHeight: state.containerHeight });
    if (next === 'close') onClose();
    else onSnapChange(next);
  };

  const onHandleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    switch (event.key) {
      case 'ArrowUp':
        onSnapChange(snapUp(snap));
        break;
      case 'ArrowDown':
        onSnapChange(snapDown(snap));
        break;
      case 'Home':
        onSnapChange('peek');
        break;
      case 'End':
        onSnapChange('full');
        break;
      case 'Enter':
      case ' ':
        onSnapChange(snapUp(snap));
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const onSheetKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    }
  };

  // A tap on the peek's own content, not on a control, opens it to half.
  const onSheetClick = (event: MouseEvent<HTMLElement>) => {
    if (snap !== 'peek') return;
    const target = event.target as HTMLElement;
    if (target.closest('button, a, input, select, textarea, [role="button"], [role="menuitem"]')) return;
    onSnapChange('half');
  };

  if (!open) return null;

  const dragging = dragHeight !== null;
  const stateText = snap === 'peek' ? 'collapsed' : snap === 'half' ? 'half height' : 'full height';
  return (
    <Paper
      ref={sheetRef}
      elevation={8}
      role={snap === 'full' ? 'dialog' : 'region'}
      aria-label={label}
      data-snap={snap}
      tabIndex={-1}
      onKeyDown={onSheetKeyDown}
      onClick={onSheetClick}
      sx={(theme) => ({
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 3,
        display: 'flex',
        flexDirection: 'column',
        height: dragging ? `${dragHeight}px` : SHEET_SNAP_CSS[snap],
        maxHeight: '100%',
        overflow: 'hidden',
        borderTopLeftRadius: 16,
        borderTopRightRadius: 16,
        borderBottomLeftRadius: 0,
        borderBottomRightRadius: 0,
        backgroundImage: 'none',
        pb: 'env(safe-area-inset-bottom)',
        boxShadow: `0 -4px 24px ${alpha(theme.palette.common.black, theme.palette.mode === 'dark' ? 0.6 : 0.18)}`,
        transition: dragging || reducedMotion ? 'none' : 'height 240ms cubic-bezier(0.2, 0.8, 0.2, 1)',
        '&:focus-visible': { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: -2 },
      })}
    >
      <Box
        component="button"
        type="button"
        aria-label={`Resize ${label}. ${stateText}. Arrow up to expand, arrow down to collapse.`}
        aria-expanded={snap !== 'peek'}
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={(event: PointerEvent<HTMLElement>) => finishDrag(event, false)}
        onPointerCancel={(event: PointerEvent<HTMLElement>) => finishDrag(event, true)}
        onKeyDown={onHandleKeyDown}
        sx={(theme) => ({
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          minHeight: 28,
          p: 0,
          border: 0,
          bgcolor: 'transparent',
          cursor: 'grab',
          touchAction: 'none',
          '&:active': { cursor: 'grabbing' },
          '&:focus-visible': { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: -2 },
          '&::before': {
            content: '""',
            width: 36,
            height: 4,
            borderRadius: 2,
            bgcolor: 'text.disabled',
          },
        })}
      />
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          overflowY: snap === 'peek' ? 'hidden' : 'auto',
          overscrollBehavior: 'contain',
        }}
      >
        {children}
      </Box>
    </Paper>
  );
}
