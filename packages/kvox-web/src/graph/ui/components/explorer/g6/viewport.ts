/**
 * The camera rules of the G6 canvas (#775), as pure functions: framing a set
 * of nodes, the zoom range, the level-of-detail bucket, and whether the user
 * has moved the camera (which stops the automatic fit after a layout).
 */

/** The zoom range of the canvas: 10% to 600%. */
export const ZOOM_RANGE: readonly [number, number] = [0.1, 6];

/** Padding around a fit, in px. */
export const FIT_PADDING_PX = 48;

/** The most an automatic fit (and Fit) zooms in: a small ego view is centred, not blown up. Manual zoom keeps {@link ZOOM_RANGE}. */
export const AUTO_FIT_MAX_ZOOM = 1.25;

/** One zoom-in step of the buttons and the `+` key. */
export const ZOOM_STEP = 1.5;

/** Duration of a camera animation, in ms (none under `prefers-reduced-motion`). */
export const CAMERA_ANIMATION_MS = 300;

/**
 * An axis-aligned box, `[minX, minY]` to `[maxX, maxY]` (G6's `AABB` exposes these as `min` and `max`).
 *
 * @stability experimental
 */
export interface Bounds {
  min: readonly number[];
  max: readonly number[];
}

/** The union of boxes, or `null` for none. */
export function unionBounds(boxes: Iterable<Bounds | null | undefined>): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of boxes) {
    if (!box) continue;
    const [x0, y0] = box.min;
    const [x1, y1] = box.max;
    if (![x0, y0, x1, y1].every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
    minX = Math.min(minX, x0!);
    minY = Math.min(minY, y0!);
    maxX = Math.max(maxX, x1!);
    maxY = Math.max(maxY, y1!);
  }
  if (minX === Infinity) return null;
  return { min: [minX, minY], max: [maxX, maxY] };
}

/** Clamps a zoom to {@link ZOOM_RANGE}. */
export function clampZoom(zoom: number, range: readonly [number, number] = ZOOM_RANGE): number {
  return Math.min(range[1], Math.max(range[0], zoom));
}

/**
 * The zoom and centre (canvas coordinates) that frame `bounds` in a viewport
 * of `size` px with `padding` px to spare on every side. A small graph is not
 * zoomed past `maxZoom` (default {@link AUTO_FIT_MAX_ZOOM}): it is centred instead.
 */
export function fitTransform(
  bounds: Bounds,
  size: readonly [number, number],
  options: { padding?: number; range?: readonly [number, number]; maxZoom?: number } = {},
): { zoom: number; center: [number, number] } {
  const padding = options.padding ?? FIT_PADDING_PX;
  const range = options.range ?? ZOOM_RANGE;
  const width = Math.max(1, bounds.max[0]! - bounds.min[0]!);
  const height = Math.max(1, bounds.max[1]! - bounds.min[1]!);
  const availableX = Math.max(1, size[0] - padding * 2);
  const availableY = Math.max(1, size[1] - padding * 2);
  const raw = Math.min(availableX / width, availableY / height);
  const zoom = clampZoom(Math.min(raw, options.maxZoom ?? AUTO_FIT_MAX_ZOOM), range);
  return {
    zoom,
    center: [(bounds.min[0]! + bounds.max[0]!) / 2, (bounds.min[1]! + bounds.max[1]!) / 2],
  };
}

/** A zoom quantised to quarter steps of log2, so a pinch recomputes states a few times, not on every frame. */
export function zoomBucket(zoom: number): number {
  return Math.round(Math.log2(Math.max(1e-3, zoom)) * 4);
}

/**
 * Whether the USER has moved the camera since the last fit. A camera change
 * the canvas makes itself (a fit, a zoom button, a reveal) is wrapped in
 * `programmatic`; any other transform is the user's, and from then on a layout
 * no longer refits the view, until the user asks for Fit.
 *
 * @stability experimental
 */
export interface CameraTracker {
  /** Runs a camera change the canvas makes itself; the transforms it causes are not the user's. */
  programmatic<T>(change: () => Promise<T> | T): Promise<T>;
  /** A transform happened. */
  onTransform(): void;
  /** Whether the user moved the camera since the last {@link CameraTracker.reset}. */
  moved(): boolean;
  /** Forget the user's moves (after Fit). */
  reset(): void;
}

/** Creates a {@link CameraTracker}. */
export function createCameraTracker(): CameraTracker {
  let depth = 0;
  let userMoved = false;
  return {
    async programmatic(change) {
      depth += 1;
      try {
        return await change();
      } finally {
        depth -= 1;
      }
    },
    onTransform() {
      if (depth === 0) userMoved = true;
    },
    moved: () => userMoved,
    reset() {
      userMoved = false;
    },
  };
}

/** `devicePixelRatio` under a budget cap; `undefined` leaves the renderer's own. */
export function cappedPixelRatio(cap: number | null | undefined): number | undefined {
  if (cap === null || cap === undefined) return undefined;
  const native = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  return native <= cap ? undefined : cap;
}
