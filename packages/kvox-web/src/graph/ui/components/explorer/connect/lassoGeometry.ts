/**
 * The geometry of the explorer's lasso (GIC-14, #675): pure functions over
 * viewport points, so "exactly the nodes inside the polygon" is a unit test and
 * not a canvas test. The caller converts graph coordinates to viewport pixels
 * (sigma's `graphToViewport`) first; nothing here knows sigma.
 */

/**
 * A point in viewport pixels.
 *
 * @stability experimental
 */
export interface LassoPoint {
  /** Pixels from the canvas's left edge. */
  x: number;
  /** Pixels from the canvas's top edge. */
  y: number;
}

/**
 * A node's drawn position, in the same space as the lasso.
 *
 * @stability experimental
 */
export interface LassoNode extends LassoPoint {
  /** The node id. */
  id: string;
}

/** A lasso smaller than this (px squared) is a click, not a selection. */
export const LASSO_MIN_AREA_PX = 100;

/** A new point closer than this (px) to the last one is not recorded. */
export const LASSO_MIN_STEP_PX = 3;

/**
 * Whether `point` lies inside the polygon (even-odd ray casting). A polygon with fewer than three points contains nothing. A point exactly on an edge may fall either way; a lasso is not a hit test of pixels.
 *
 * @param point - The point to test.
 * @param polygon - The polygon's vertices, in order; the closing edge is implied.
 * @returns `true` when the point is inside.
 *
 * @stability experimental
 */
export function pointInPolygon(point: LassoPoint, polygon: readonly LassoPoint[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    const crosses = a.y > point.y !== b.y > point.y;
    if (crosses && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * The ids of the nodes inside the polygon, in the order given.
 *
 * @param nodes - The nodes, with their viewport positions.
 * @param polygon - The lasso's vertices.
 * @returns The ids inside; empty for a degenerate polygon.
 *
 * @stability experimental
 */
export function nodesInPolygon(nodes: Iterable<LassoNode>, polygon: readonly LassoPoint[]): string[] {
  if (polygon.length < 3) return [];
  const ids: string[] = [];
  for (const node of nodes) if (pointInPolygon(node, polygon)) ids.push(node.id);
  return ids;
}

/**
 * The polygon's absolute area (shoelace formula), in pixels squared.
 *
 * @param polygon - The lasso's vertices.
 * @returns The area; `0` for fewer than three points.
 *
 * @stability experimental
 */
export function polygonArea(polygon: readonly LassoPoint[]): number {
  if (polygon.length < 3) return 0;
  let sum = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    sum += (b.x + a.x) * (b.y - a.y);
  }
  return Math.abs(sum / 2);
}

/**
 * Appends a point unless it is within {@link LASSO_MIN_STEP_PX} of the last one, so a slow drag does not record thousands of vertices.
 *
 * @param polygon - The points so far.
 * @param point - The new pointer position.
 * @returns A new array when the point was added, else the same one.
 *
 * @stability experimental
 */
export function appendLassoPoint(polygon: readonly LassoPoint[], point: LassoPoint): readonly LassoPoint[] {
  const last = polygon[polygon.length - 1];
  if (last && Math.hypot(point.x - last.x, point.y - last.y) < LASSO_MIN_STEP_PX) return polygon;
  return [...polygon, point];
}

/**
 * Whether a finished lasso is large enough to select anything.
 *
 * @param polygon - The lasso's vertices.
 * @returns `false` for a click or a tiny wobble.
 *
 * @stability experimental
 */
export function isLassoSelection(polygon: readonly LassoPoint[]): boolean {
  return polygon.length >= 3 && polygonArea(polygon) >= LASSO_MIN_AREA_PX;
}

/**
 * The node under a point: the nearest within its drawn radius (plus a margin), or `null`. Used to tell a shift-click on a node from the start of a lasso.
 *
 * @param nodes - The nodes with their viewport positions and drawn radius.
 * @param point - The pointer position.
 * @param margin - Extra pixels around each node.
 * @returns The id, or `null`.
 *
 * @stability experimental
 */
export function nodeAtPoint(
  nodes: Iterable<LassoNode & { radius: number }>,
  point: LassoPoint,
  margin = 4,
): string | null {
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const node of nodes) {
    const distance = Math.hypot(node.x - point.x, node.y - point.y);
    if (distance <= node.radius + margin && distance < bestDistance) {
      best = node.id;
      bestDistance = distance;
    }
  }
  return best;
}
