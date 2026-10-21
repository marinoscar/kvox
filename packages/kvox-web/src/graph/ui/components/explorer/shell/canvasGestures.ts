/**
 * Framework-free helpers of the touch model (GIC-08, #669). No React and no
 * sigma import: `GraphCanvas` (the one file that imports sigma) wires them to
 * sigma's events, and each is tested on its own.
 *
 *   - `createLongPress`: the 500ms press that opens the context menu;
 *   - `pickNearestNode`: the enlarged pick radius (a 44px target at least) of a coarse pointer;
 *   - `capPixelRatio`: the `devicePixelRatio` budget;
 *   - `revealDelta`: how far to pan so a selection is not under the inspector.
 */

/** How long a press must hold to be a long-press, in ms. */
export const LONG_PRESS_MS = 500;
/** How far (px) a finger may wander before the press is a drag, not a long-press. */
export const LONG_PRESS_SLOP_PX = 10;
/** Haptic tick (ms) a long-press fires where `navigator.vibrate` exists. */
export const LONG_PRESS_HAPTIC_MS = 10;

/**
 * A point in px.
 *
 * @stability experimental
 */
export interface Point {
  x: number;
  y: number;
}

/**
 * A long-press detector: `start` on touch down, `move` on touch move, `cancel` on lift.
 *
 * @stability experimental
 */
export interface LongPress {
  /** A finger went down at `point`. */
  start(point: Point): void;
  /** The finger moved; wandering past the slop cancels the press. */
  move(point: Point): void;
  /** The finger lifted or the gesture became something else (a pinch). */
  cancel(): void;
  /** Whether the last press fired. Stays true until the next `start`, so the click that follows can be ignored. */
  fired(): boolean;
}

/**
 * Builds a detector that calls `onLongPress(point)` once, `delayMs` after `start`, unless it was cancelled or the finger moved more than `slopPx`. Fires the haptic tick where `navigator.vibrate` exists.
 *
 * @stability experimental
 */
export function createLongPress(options: {
  onLongPress: (point: Point) => void;
  delayMs?: number;
  slopPx?: number;
}): LongPress {
  const { onLongPress, delayMs = LONG_PRESS_MS, slopPx = LONG_PRESS_SLOP_PX } = options;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let origin: Point | null = null;
  let hasFired = false;

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    origin = null;
  };

  return {
    start(point) {
      clear();
      hasFired = false;
      origin = point;
      timer = setTimeout(() => {
        timer = null;
        hasFired = true;
        if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
          navigator.vibrate(LONG_PRESS_HAPTIC_MS);
        }
        onLongPress(origin ?? point);
        origin = null;
      }, delayMs);
    },
    move(point) {
      if (!origin || timer === null) return;
      if (Math.hypot(point.x - origin.x, point.y - origin.y) > slopPx) clear();
    },
    cancel: clear,
    fired: () => hasFired,
  };
}

/**
 * Finds the node nearest to `point` within `radiusPx`. Sigma's own picking hits only the drawn disc, which on a phone is far under 44px; this widens it.
 *
 * `positions` gives where a node is drawn, in viewport px, or `null` when it is hidden.
 *
 * @stability experimental
 */
export function pickNearestNode(
  ids: Iterable<string>,
  positions: (id: string) => (Point & { size?: number }) | null,
  point: Point,
  radiusPx: number,
): string | null {
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const id of ids) {
    const at = positions(id);
    if (!at) continue;
    const distance = Math.hypot(at.x - point.x, at.y - point.y);
    // A big node keeps its own, larger, disc.
    const reach = Math.max(radiusPx, at.size ?? 0);
    if (distance <= reach && distance < bestDistance) {
      best = id;
      bestDistance = distance;
    }
  }
  return best;
}

/** The slice of a sigma instance `capPixelRatio` touches. */
export interface PixelRatioTarget {
  resize(force?: boolean): unknown;
}

/**
 * Caps sigma's `devicePixelRatio` (sigma 3 has no setting for it: it reads `window.devicePixelRatio` on construction and on every resize). The instance's `pixelRatio` and its picking ratio become capped accessors, then it is resized. Returns a function that restores the native ratio. A native ratio at or under the cap is left alone.
 *
 * @stability experimental
 */
export function capPixelRatio(sigma: PixelRatioTarget, cap: number): () => void {
  const target = sigma as unknown as Record<string, unknown>;
  const native = () => (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
  if (native() <= cap) return () => undefined;
  const capped = () => Math.min(cap, native());
  const original = {
    pixelRatio: Object.getOwnPropertyDescriptor(target, 'pixelRatio'),
    picking: Object.getOwnPropertyDescriptor(target, 'pickingDownSizingRatio'),
  };
  Object.defineProperty(target, 'pixelRatio', { configurable: true, get: capped, set: () => undefined });
  Object.defineProperty(target, 'pickingDownSizingRatio', {
    configurable: true,
    get: () => 2 * capped(),
    set: () => undefined,
  });
  sigma.resize(true);
  return () => {
    if (original.pixelRatio) Object.defineProperty(target, 'pixelRatio', original.pixelRatio);
    else delete target.pixelRatio;
    if (original.picking) Object.defineProperty(target, 'pickingDownSizingRatio', original.picking);
    else delete target.pickingDownSizingRatio;
    try {
      sigma.resize(true);
    } catch {
      // The instance was killed first (an unmount tears sigma down before this runs): nothing to redraw.
    }
  };
}

/**
 * Insets in px.
 *
 * @stability experimental
 */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * How many px to pan so a node drawn at `node` is inside the part of the canvas NOT covered by `insets` (the inspector). `null` when it is already visible, with `margin` px to spare. Otherwise the shift that puts it in the middle of the visible part.
 *
 * @stability experimental
 */
export function revealDelta(
  node: Point,
  size: { width: number; height: number },
  insets: Insets,
  margin = 24,
): Point | null {
  const left = insets.left + margin;
  const right = size.width - insets.right - margin;
  const top = insets.top + margin;
  const bottom = size.height - insets.bottom - margin;
  if (right <= left || bottom <= top) return null;
  if (node.x >= left && node.x <= right && node.y >= top && node.y <= bottom) return null;
  const centreX = (insets.left + size.width - insets.right) / 2;
  const centreY = (insets.top + size.height - insets.bottom) / 2;
  return { x: centreX - node.x, y: centreY - node.y };
}
