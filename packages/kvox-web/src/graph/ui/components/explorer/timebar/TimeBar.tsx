/**
 * `TimeBar` — the Insight Canvas's time axis (GIC-15, #676; epic #661).
 *
 * A stacked histogram of the visible graph's evidence by type, with a brush
 * that filters the canvas to a window:
 *
 *   - BRUSH: drag across the bars, drag a handle, or tap a bar for one bucket.
 *     Double-click or "Clear" removes it. The range is `[from, to)` in whole
 *     buckets; it lives in the URL (`from`, `to`) and the page evaluates the
 *     graph as of `to` and dims the nodes with no evidence in the window.
 *   - TWO WAYS: selected nodes draw their own activity line over the bars;
 *     pointing at a bar reports the bucket so the canvas can light the nodes
 *     active in it.
 *   - PLAY steps the window forward one bucket every 800 ms. It is off under
 *     `prefers-reduced-motion`.
 *   - ZOOM with the wheel or a pinch; the buckets switch between months and
 *     weeks by the visible span.
 *   - KEYBOARD: the two handles are `role="slider"`; arrows move one bucket,
 *     Shift+arrows a quarter. "Set range" opens two date fields: the accessible
 *     alternative on every window class.
 *
 * Sizes: a compact window shows a 28px sparkline strip that expands on tap to
 * 120px (44px handles); medium is 96px; expanded 112px. The shell owns the
 * height; this component fills it.
 */

import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';
import CloseIcon from '@mui/icons-material/Close';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { alpha, useTheme } from '@mui/material/styles';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import type { GraphActivityBucket, GraphActivityResponse } from '../../../../headless/clients/graph.js';
import { encodingFor } from '../explorerEncoding.js';
import { useOptionalInsightCanvas } from '../shell/InsightCanvasLayout.js';
import type { InputModality } from '../shell/useInputModality.js';
import { useReducedMotion } from '../shell/useReducedMotion.js';
import type { WindowClass } from '../shell/useWindowClass.js';
import { SetRangeSheet } from './SetRangeSheet.js';
import {
  DAY_MS,
  addBuckets,
  bucketForSpan,
  bucketLabel,
  bucketStart,
  formatDay,
  parseDay,
  quarterBuckets,
  rangeLabel,
  snapRange,
  tickLabel,
  zoomDomain,
  type TimeRange,
} from './timeAxis.js';
import {
  activityExtent,
  areaPath,
  buildColumns,
  bucketIndex,
  stackOrder,
  type TimeColumn,
} from './timeBarModel.js';
import { useElementSize } from './useElementSize.js';

/** The step between two frames of Play, in ms. */
export const PLAY_STEP_MS = 800;
/** A keyboard move waits this long for the next key before it is committed (one reload, not one per key). */
export const KEY_COMMIT_MS = 300;

const HEIGHTS = { strip: 28, stripExpanded: 120, medium: 96, expanded: 112 } as const;
const AXIS_HEIGHT = 14;
const DRAG_THRESHOLD_PX = 4;

/**
 * Props of {@link TimeBar}.
 *
 * @stability experimental
 */
export interface TimeBarProps {
  /** The activity to draw, or `null` before the first answer. */
  activity: GraphActivityResponse | null;
  /** The bucket width the parent is fetching; {@link TimeBar} asks for a change through `onBucketChange` as the axis is zoomed. */
  bucket: GraphActivityBucket;
  /** Called when the visible span calls for another bucket width. */
  onBucketChange: (bucket: GraphActivityBucket) => void;
  /** The brush, or `null` for all time. */
  range: TimeRange | null;
  /** Called with a new brush, or `null` to clear it. */
  onRangeChange: (range: TimeRange | null) => void;
  /** The ids of the selected nodes; their summed activity is drawn as a line over the bars. */
  selectedIds?: readonly string[];
  /** Called with the bucket under the pointer (`[start, end)` in ms), or `null` when none. */
  onHoverBucket?: (bucket: { start: number; end: number } | null) => void;
  /** Label of a type key in the legend and the tooltip. Default: the key. */
  typeLabel?: (key: string) => string;
  /** The activity is loading. */
  loading?: boolean;
  /** A message when the activity could not be loaded. */
  error?: string | null;
  /** The clock (tests). Default: now. */
  now?: Date;
  /** Overrides the shell's window class (tests, previews). */
  windowClass?: WindowClass;
  /** Overrides the shell's input modality (tests, previews). */
  inputModality?: InputModality;
  /** Compact only: whether the strip is expanded. Overrides the shell's. */
  stripExpanded?: boolean;
  /** Compact only: called to expand the strip when it is tapped. Overrides the shell's. */
  onStripExpandedChange?: (expanded: boolean) => void;
  /** Overrides `prefers-reduced-motion` (tests). */
  reducedMotion?: boolean;
  /** The Play interval in ms. Default {@link PLAY_STEP_MS}. */
  playIntervalMs?: number;
}

function boundaryNear(ms: number, bucket: GraphActivityBucket): number {
  const a = bucketStart(ms, bucket);
  const b = addBuckets(a, bucket, 1);
  return ms - a <= b - ms ? a : b;
}

/**
 * The time bar.
 *
 * @stability experimental
 */
export function TimeBar(props: TimeBarProps) {
  const {
    activity,
    bucket,
    onBucketChange,
    range,
    onRangeChange,
    selectedIds = [],
    onHoverBucket,
    typeLabel = (key) => key,
    loading = false,
    error = null,
    playIntervalMs = PLAY_STEP_MS,
  } = props;
  const theme = useTheme();
  const mode = theme.palette.mode === 'dark' ? 'dark' : 'light';
  const shell = useOptionalInsightCanvas();
  const detectedMotion = useReducedMotion();
  const reducedMotion = props.reducedMotion ?? detectedMotion;
  const windowClass = props.windowClass ?? shell?.windowClass ?? 'expanded';
  const touch = (props.inputModality ?? shell?.inputModality ?? 'pointer') === 'touch';
  const compact = windowClass === 'compact';
  const stripExpanded = props.stripExpanded ?? shell?.timeBarExpanded ?? false;
  const setStripExpanded = props.onStripExpandedChange ?? shell?.setTimeBarExpanded;
  const strip = compact && !stripExpanded;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const fallbackHeight = strip
    ? HEIGHTS.strip
    : compact
      ? HEIGHTS.stripExpanded
      : windowClass === 'medium'
        ? HEIGHTS.medium
        : HEIGHTS.expanded;
  const root = useElementSize(rootRef, { width: 640, height: fallbackHeight });
  const controlsHeight = touch ? 44 : 32;
  const plotSize = useElementSize(plotRef, {
    width: root.width,
    height: Math.max(24, root.height - controlsHeight),
  });
  const width = Math.max(40, plotSize.width);
  const plotHeight = Math.max(20, plotSize.height);

  // --- The axis ---------------------------------------------------------------
  const nowMs = useMemo(() => (props.now ?? new Date()).getTime(), [props.now]);
  const drawBucket = activity?.bucket ?? bucket;
  const rangeFrom = range ? parseDay(range.from) : null;
  const rangeTo = range ? parseDay(range.to) : null;
  const dataExtent = activityExtent(activity);
  const rawMin = Math.min(dataExtent?.[0] ?? nowMs - 365 * DAY_MS, rangeFrom ?? Infinity, nowMs);
  const rawMax = Math.max(dataExtent?.[1] ?? nowMs, rangeTo ?? -Infinity, nowMs);
  const extent = useMemo<[number, number]>(() => {
    const start = bucketStart(rawMin, drawBucket);
    const end = addBuckets(bucketStart(rawMax, drawBucket), drawBucket, 1);
    return [start, Math.max(end, addBuckets(start, drawBucket, 3))];
  }, [rawMin, rawMax, drawBucket]);
  const [view, setView] = useState<[number, number] | null>(null);
  const domain: [number, number] = view ?? extent;

  // The visible span chooses the bucket width.
  const spanMs = view ? view[1] - view[0] : rawMax - rawMin;
  const wanted = bucketForSpan(spanMs);
  useEffect(() => {
    if (wanted !== bucket) onBucketChange(wanted);
  }, [wanted, bucket, onBucketChange]);

  const columns = useMemo(
    () => buildColumns(activity, domain, drawBucket, selectedIds),
    // `selectedIds` is compared by content.
    [activity, domain[0], domain[1], drawBucket, selectedIds.join(',')],
  );
  const order = useMemo(() => stackOrder(activity?.series ?? []), [activity]);
  const hasData = (activity?.series.length ?? 0) > 0;
  const hasOverlay = columns.some((c) => c.overlay > 0);
  const xOf = (ms: number) => ((ms - domain[0]) / (domain[1] - domain[0])) * width;
  const msOf = (x: number) => domain[0] + (x / width) * (domain[1] - domain[0]);

  // --- The brush ---------------------------------------------------------------
  const [draft, setDraft] = useState<TimeRange | null>(null);
  useEffect(() => setDraft(null), [range?.from, range?.to]);
  const shown = draft ?? range;
  const shownFrom = shown ? parseDay(shown.from) : null;
  const shownTo = shown ? parseDay(shown.to) : null;
  const commit = useCallback((next: TimeRange | null) => onRangeChange(next), [onRangeChange]);

  const firstBucket = extent[0];
  const bucketCount = Math.max(1, bucketIndex(firstBucket, extent[1] - 1, drawBucket) + 1);

  const keyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (keyTimer.current) clearTimeout(keyTimer.current);
    },
    [],
  );
  const stage = (next: TimeRange) => {
    setDraft(next);
    if (keyTimer.current) clearTimeout(keyTimer.current);
    keyTimer.current = setTimeout(() => {
      keyTimer.current = null;
      commit(next);
    }, KEY_COMMIT_MS);
  };

  /** Moves one end of the brush by `delta` buckets (keyboard). */
  const moveHandle = (which: 'from' | 'to', delta: number, absolute?: number) => {
    if (shownFrom === null || shownTo === null) return;
    const move = (ms: number) =>
      absolute !== undefined ? addBuckets(firstBucket, drawBucket, absolute) : addBuckets(ms, drawBucket, delta);
    let a = shownFrom;
    let b = shownTo;
    if (which === 'from') a = Math.max(extent[0], Math.min(move(a), addBuckets(b, drawBucket, -1)));
    else b = Math.min(extent[1], Math.max(move(b), addBuckets(a, drawBucket, 1)));
    stage({ from: formatDay(a), to: formatDay(b) });
  };

  const onHandleKey = (which: 'from' | 'to') => (event: ReactKeyboardEvent<HTMLElement>) => {
    const quarter = quarterBuckets(drawBucket);
    const step = event.shiftKey ? quarter : 1;
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        moveHandle(which, -step);
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        moveHandle(which, step);
        break;
      case 'PageDown':
        moveHandle(which, -quarter);
        break;
      case 'PageUp':
        moveHandle(which, quarter);
        break;
      case 'Home':
        moveHandle(which, 0, which === 'from' ? 0 : 1);
        break;
      case 'End':
        moveHandle(which, 0, which === 'from' ? bucketCount - 1 : bucketCount);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  // --- Pointer: brush, handle drag, pinch, hover ------------------------------
  const pointers = useRef(new Map<number, number>());
  type Gesture =
    | { kind: 'brush'; startX: number; moved: boolean }
    | { kind: 'handle'; which: 'from' | 'to' }
    | { kind: 'pinch'; distance: number; domain: [number, number] };
  const gesture = useRef<Gesture | null>(null);
  const justDragged = useRef(false);
  const [hover, setHover] = useState<TimeColumn | null>(null);

  const localX = (clientX: number): number => {
    const box = plotRef.current?.getBoundingClientRect();
    return Math.min(width, Math.max(0, clientX - (box?.left ?? 0)));
  };
  const columnAt = (x: number): TimeColumn | null => {
    const ms = msOf(x);
    return columns.find((c) => ms >= c.start && ms < c.end) ?? null;
  };

  useEffect(() => {
    onHoverBucket?.(hover ? { start: hover.start, end: hover.end } : null);
  }, [hover, onHoverBucket]);

  const onPlotPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointers.current.set(event.pointerId, localX(event.clientX));
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { kind: 'pinch', distance: Math.max(1, Math.abs(a - b)), domain: [...domain] };
      return;
    }
    gesture.current = { kind: 'brush', startX: localX(event.clientX), moved: false };
  };

  const onPlotPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const x = localX(event.clientX);
    const active = gesture.current;
    if (pointers.current.has(event.pointerId)) pointers.current.set(event.pointerId, x);
    if (!active) {
      if (event.pointerType === 'mouse') setHover(columnAt(x));
      return;
    }
    if (active.kind === 'pinch' && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const factor = active.distance / Math.max(1, Math.abs(a - b));
      setView(zoomDomain(active.domain, (a + b) / 2 / width, factor, extent));
      justDragged.current = true;
      return;
    }
    if (active.kind === 'brush') {
      if (!active.moved && Math.abs(x - active.startX) < DRAG_THRESHOLD_PX) return;
      active.moved = true;
      justDragged.current = true;
      setDraft(snapRange(msOf(active.startX), msOf(x), drawBucket));
    }
  };

  const onPlotPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    const active = gesture.current;
    if (active?.kind === 'pinch') {
      if (pointers.current.size < 2) gesture.current = null;
      return;
    }
    gesture.current = null;
    if (active?.kind === 'brush' && active.moved && draft) commit(draft);
  };

  const onPlotPointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    gesture.current = null;
    setDraft(null);
  };

  // A tap or click on a bar picks that one bucket (a drag already committed).
  const onPlotClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (justDragged.current) {
      justDragged.current = false;
      return;
    }
    const column = columnAt(localX(event.clientX));
    if (column) commit({ from: formatDay(column.start), to: formatDay(column.end) });
  };

  // Handle drags.
  const onHandleDown = (which: 'from' | 'to') => (event: ReactPointerEvent<HTMLElement>) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    gesture.current = { kind: 'handle', which };
    justDragged.current = true;
  };
  const onHandleMove = (event: ReactPointerEvent<HTMLElement>) => {
    const active = gesture.current;
    if (active?.kind !== 'handle' || shownFrom === null || shownTo === null) return;
    const edge = boundaryNear(msOf(localX(event.clientX)), drawBucket);
    if (active.which === 'from') {
      const a = Math.max(extent[0], Math.min(edge, addBuckets(shownTo, drawBucket, -1)));
      setDraft({ from: formatDay(a), to: formatDay(shownTo) });
    } else {
      const b = Math.min(extent[1], Math.max(edge, addBuckets(shownFrom, drawBucket, 1)));
      setDraft({ from: formatDay(shownFrom), to: formatDay(b) });
    }
  };
  const onHandleUp = (event: ReactPointerEvent<HTMLElement>) => {
    event.stopPropagation();
    const active = gesture.current;
    gesture.current = null;
    if (active?.kind === 'handle' && draft) commit(draft);
  };

  // Wheel zoom needs a non-passive listener to keep the page from scrolling.
  const zoomable = !strip;
  useEffect(() => {
    const element = plotRef.current;
    if (!element || !zoomable) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = element.getBoundingClientRect();
      const anchor = box.width > 0 ? (event.clientX - box.left) / box.width : 0.5;
      setView((current) => zoomDomain(current ?? extent, anchor, event.deltaY > 0 ? 1.25 : 0.8, extent));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [zoomable, extent]);

  // --- Play ------------------------------------------------------------------
  const [playing, setPlaying] = useState(false);
  const cursor = useRef<TimeRange | null>(null);
  const latest = useRef({ extent, drawBucket, range });
  latest.current = { extent, drawBucket, range };
  const canPlay = !reducedMotion && hasData;

  useEffect(() => {
    if (!playing) return undefined;
    const timer = setInterval(() => {
      const { extent: bounds, drawBucket: unit } = latest.current;
      const current = cursor.current;
      const toMs = current ? parseDay(current.to) : null;
      const fromMs = current ? parseDay(current.from) : null;
      if (toMs === null || fromMs === null) return;
      const nextFrom = addBuckets(fromMs, unit, 1);
      const nextTo = addBuckets(toMs, unit, 1);
      if (nextTo > bounds[1]) {
        setPlaying(false);
        return;
      }
      cursor.current = { from: formatDay(nextFrom), to: formatDay(nextTo) };
      commit(cursor.current);
    }, playIntervalMs);
    return () => clearInterval(timer);
  }, [playing, playIntervalMs, commit]);

  // Reduced motion (or no data) switches Play off.
  useEffect(() => {
    if (!canPlay) setPlaying(false);
  }, [canPlay]);

  const togglePlay = () => {
    if (playing) {
      setPlaying(false);
      return;
    }
    const current = latest.current.range;
    const unit = latest.current.drawBucket;
    const bounds = latest.current.extent;
    const toMs = current ? parseDay(current.to) : null;
    const fromMs = current ? parseDay(current.from) : null;
    // Continue from the brush; from nothing, or from the end, start at the first bucket.
    if (current && fromMs !== null && toMs !== null && toMs < bounds[1]) {
      cursor.current = current;
    } else {
      const first = dataExtent?.[0] ?? bounds[0];
      const widthBuckets = current && fromMs !== null && toMs !== null ? Math.max(1, bucketIndex(fromMs, toMs, unit)) : 1;
      cursor.current = { from: formatDay(first), to: formatDay(addBuckets(first, unit, widthBuckets)) };
      commit(cursor.current);
    }
    setPlaying(true);
  };

  // --- The sheet ---------------------------------------------------------------
  const [sheetOpen, setSheetOpen] = useState(false);

  // --- Drawing ---------------------------------------------------------------
  const maxValue = Math.max(1, ...columns.map((c) => Math.max(c.total, c.overlay)));
  const showAxis = !strip && plotHeight >= 56;
  const barsHeight = plotHeight - (showAxis ? AXIS_HEIGHT : 0);
  const y = (value: number) => barsHeight - (value / maxValue) * (barsHeight - 4);
  const barWidth = (column: TimeColumn) => Math.max(1, xOf(column.end) - xOf(column.start) - (width / columns.length > 6 ? 1 : 0));
  const accent = theme.palette.primary.main;

  const summary = hasData
    ? `Evidence over time, ${activity!.series.reduce((n, b) => n + b.total, 0)} items in ${activity!.series.length} ${drawBucket === 'month' ? 'months' : 'weeks'}`
    : 'Evidence over time, nothing dated yet';

  const ticks: { x: number; label: string }[] = [];
  if (showAxis) {
    let last = -Infinity;
    for (const column of columns) {
      const x = xOf(column.start);
      if (x < 0 || x - last < 48) continue;
      ticks.push({ x, label: tickLabel(column.start, drawBucket) });
      last = x;
    }
  }

  const hoverText = hover
    ? `${bucketLabel(hover.start, drawBucket)}: ${hover.total === 0 ? 'no evidence' : `${hover.total} ${hover.total === 1 ? 'item' : 'items'}`}${
        hover.total > 0
          ? ` (${order
              .filter((type) => hover.byType[type])
              .map((type) => `${typeLabel(type)} ${hover.byType[type]}`)
              .join(', ')})`
          : ''
      }`
    : null;
  const statusText =
    hoverText ??
    (shown
      ? `${rangeLabel(shown, drawBucket)}`
      : error
        ? error
        : loading && !hasData
          ? 'Loading activity'
          : hasData
            ? 'All time'
            : 'No dated evidence yet');

  // --- The compact strip: a sparkline, tap to expand --------------------------
  if (strip) {
    const stripPath = areaPath(columns, width, plotHeight);
    return (
      <Box
        ref={rootRef}
        component="button"
        type="button"
        onClick={() => setStripExpanded?.(true)}
        aria-label={`Time bar. ${summary}${shown ? `, range ${rangeLabel(shown, drawBucket)}` : ''}. Tap to expand.`}
        sx={{
          display: 'block',
          width: '100%',
          height: '100%',
          p: 0,
          m: 0,
          border: 0,
          bgcolor: 'transparent',
          cursor: 'pointer',
          color: 'text.secondary',
          '&:focus-visible': { outline: `2px solid ${accent}`, outlineOffset: -2 },
        }}
      >
        <Box ref={plotRef} component="span" sx={{ display: 'block', width: '100%', height: '100%' }}>
          <svg width={width} height={plotHeight} viewBox={`0 0 ${width} ${plotHeight}`} aria-hidden focusable="false" style={{ display: 'block' }}>
            <path d={stripPath} fill="currentColor" opacity={0.35} />
            {shownFrom !== null && shownTo !== null && (
              <rect
                x={Math.max(0, xOf(shownFrom))}
                y={0}
                width={Math.max(2, Math.min(width, xOf(shownTo)) - Math.max(0, xOf(shownFrom)))}
                height={plotHeight}
                fill={accent}
                opacity={0.3}
              />
            )}
          </svg>
        </Box>
      </Box>
    );
  }

  // --- The full bar ------------------------------------------------------------
  const handleSize = touch ? 44 : 20;
  const brushLeft = shownFrom !== null ? Math.max(0, xOf(shownFrom)) : 0;
  const brushRight = shownTo !== null ? Math.min(width, xOf(shownTo)) : 0;
  const brushVisible = shownFrom !== null && shownTo !== null && brushRight > brushLeft;
  const fromIndex = shownFrom !== null ? bucketIndex(firstBucket, shownFrom, drawBucket) : 0;
  const toIndex = shownTo !== null ? bucketIndex(firstBucket, shownTo, drawBucket) : 0;
  const handleStyle = (left: number) => ({
    position: 'absolute' as const,
    top: 0,
    height: barsHeight,
    width: handleSize,
    left: Math.min(Math.max(0, left - handleSize / 2), width - handleSize),
    display: 'flex',
    justifyContent: 'center',
    cursor: 'ew-resize',
    touchAction: 'none' as const,
    zIndex: 2,
  });
  const handleBar = {
    width: 4,
    height: '100%',
    borderRadius: 2,
    bgcolor: accent,
    transition: 'background-color 120ms',
  };

  return (
    <Box ref={rootRef} sx={{ height: '100%', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <Box
        ref={plotRef}
        role="group"
        aria-label="Evidence histogram"
        data-testid="timebar-plot"
        onPointerDown={onPlotPointerDown}
        onPointerMove={onPlotPointerMove}
        onPointerUp={onPlotPointerUp}
        onPointerCancel={onPlotPointerCancel}
        onPointerLeave={() => setHover(null)}
        onClick={onPlotClick}
        onDoubleClick={() => {
          setDraft(null);
          commit(null);
        }}
        sx={{ position: 'relative', flex: 1, minHeight: 0, minWidth: 0, touchAction: 'none', userSelect: 'none', cursor: 'crosshair' }}
      >
        <svg
          width={width}
          height={plotHeight}
          viewBox={`0 0 ${width} ${plotHeight}`}
          role="img"
          aria-label={summary}
          focusable="false"
          style={{ display: 'block', overflow: 'hidden' }}
        >
          {hover && (
            <rect
              x={xOf(hover.start)}
              y={0}
              width={barWidth(hover) + 1}
              height={barsHeight}
              fill={theme.palette.action.hover}
            />
          )}
          {columns.map((column) => {
            if (column.total === 0) return null;
            let top = barsHeight;
            const bw = barWidth(column);
            return (
              <g key={column.start} data-testid="timebar-column" data-start={formatDay(column.start)} data-total={column.total}>
                {order
                  .filter((type) => column.byType[type])
                  .map((type) => {
                    const h = (column.byType[type] / maxValue) * (barsHeight - 4);
                    top -= h;
                    return (
                      <rect
                        key={type}
                        x={xOf(column.start)}
                        y={top}
                        width={bw}
                        height={Math.max(1, h)}
                        fill={encodingFor(type, mode).color}
                      />
                    );
                  })}
              </g>
            );
          })}
          {hasOverlay && (
            <polyline
              data-testid="timebar-overlay"
              fill="none"
              stroke={theme.palette.text.primary}
              strokeWidth={2}
              strokeLinejoin="round"
              points={columns.map((c) => `${(xOf(c.start) + barWidth(c) / 2).toFixed(1)},${y(c.overlay).toFixed(1)}`).join(' ')}
            />
          )}
          {brushVisible && (
            <rect
              data-testid="timebar-brush"
              x={brushLeft}
              y={0}
              width={brushRight - brushLeft}
              height={barsHeight}
              fill={alpha(accent, 0.16)}
              stroke={accent}
              strokeWidth={1}
            />
          )}
          <line x1={0} x2={width} y1={barsHeight} y2={barsHeight} stroke={theme.palette.divider} />
          {ticks.map((tick) => (
            <text key={tick.x} x={tick.x + 2} y={plotHeight - 3} fontSize={10} fill={theme.palette.text.secondary}>
              {tick.label}
            </text>
          ))}
          {!hasData && (
            <text x={width / 2} y={barsHeight / 2} textAnchor="middle" fontSize={12} fill={theme.palette.text.secondary}>
              {loading ? 'Loading activity' : error ?? 'No dated evidence for these nodes'}
            </text>
          )}
        </svg>
        {brushVisible && (
          <>
            <Box
              role="slider"
              tabIndex={0}
              aria-label="Range start"
              aria-orientation="horizontal"
              aria-valuemin={0}
              aria-valuemax={Math.max(0, toIndex - 1)}
              aria-valuenow={fromIndex}
              aria-valuetext={`Range starts ${bucketLabel(shownFrom!, drawBucket)}`}
              data-testid="timebar-handle-from"
              onKeyDown={onHandleKey('from')}
              onPointerDown={onHandleDown('from')}
              onPointerMove={onHandleMove}
              onPointerUp={onHandleUp}
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              sx={{ ...handleStyle(brushLeft), '&:focus-visible > div': { outline: `2px solid ${theme.palette.text.primary}`, outlineOffset: 2 } }}
            >
              <Box sx={handleBar} />
            </Box>
            <Box
              role="slider"
              tabIndex={0}
              aria-label="Range end"
              aria-orientation="horizontal"
              aria-valuemin={fromIndex + 1}
              aria-valuemax={bucketCount}
              aria-valuenow={toIndex}
              aria-valuetext={`Range ends ${bucketLabel(bucketStart(shownTo! - DAY_MS, drawBucket), drawBucket)}`}
              data-testid="timebar-handle-to"
              onKeyDown={onHandleKey('to')}
              onPointerDown={onHandleDown('to')}
              onPointerMove={onHandleMove}
              onPointerUp={onHandleUp}
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              sx={{ ...handleStyle(brushRight), '&:focus-visible > div': { outline: `2px solid ${theme.palette.text.primary}`, outlineOffset: 2 } }}
            >
              <Box sx={handleBar} />
            </Box>
          </>
        )}
      </Box>

      <Box
        sx={{
          flex: `0 0 ${controlsHeight}px`,
          height: controlsHeight,
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          px: 1,
          minWidth: 0,
          borderTop: 1,
          borderColor: 'divider',
        }}
      >
        <Tooltip title={reducedMotion ? 'Play is off because you asked for reduced motion' : playing ? 'Pause' : 'Play through time'}>
          <span>
            <IconButton
              size="small"
              onClick={togglePlay}
              disabled={!canPlay}
              aria-label={playing ? 'Pause' : 'Play'}
              aria-pressed={playing}
              sx={{ width: touch ? 44 : 32, height: touch ? 44 : 32 }}
            >
              {playing ? <PauseIcon fontSize="small" /> : <PlayArrowIcon fontSize="small" />}
            </IconButton>
          </span>
        </Tooltip>
        <Typography
          variant="caption"
          color="text.secondary"
          noWrap
          sx={{ flex: 1, minWidth: 0, fontVariantNumeric: 'tabular-nums' }}
          title={statusText}
          data-testid="timebar-status"
        >
          {statusText}
          {hasOverlay && !hover ? ' · line: selected' : ''}
        </Typography>
        {range && (
          <Tooltip title="Clear the range">
            <IconButton
              size="small"
              onClick={() => {
                setDraft(null);
                commit(null);
              }}
              aria-label="Clear the range"
              sx={{ width: touch ? 44 : 32, height: touch ? 44 : 32 }}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
        <Button
          size="small"
          startIcon={<CalendarMonthIcon fontSize="small" />}
          onClick={() => setSheetOpen(true)}
          sx={{ minHeight: touch ? 44 : 32, whiteSpace: 'nowrap', flexShrink: 0 }}
        >
          Set range
        </Button>
      </Box>

      <SetRangeSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        range={range}
        min={formatDay(extent[0])}
        max={formatDay(extent[1] - DAY_MS)}
        bucket={drawBucket}
        touch={touch}
        onApply={(next) => {
          setSheetOpen(false);
          commit(next);
        }}
        onClear={() => {
          setSheetOpen(false);
          commit(null);
        }}
      />
    </Box>
  );
}
