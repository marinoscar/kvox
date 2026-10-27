/**
 * The G6 instance's lifecycle guards (#775). No G6 runtime import.
 *
 * A G6 Graph has no viewport until its first draw or render finishes, and
 * loses it on destroy: asking for the zoom, a viewport point or a resize then
 * throws ("Cannot read properties of undefined (reading 'getZoom')"). React 19
 * StrictMode, a remount after a key change, or an animated transform that
 * finishes after an unmount all reach the instance in one of those windows.
 * Every camera read goes through {@link isLive} or {@link zoomOf}.
 */

/** The part of a G6 `Graph` these guards touch. */
export interface GuardedGraph {
  destroyed?: boolean;
  getZoom(): number;
  getSize(): [number, number] | number[];
  resize(width: number, height: number): void;
}

const drawn = new WeakSet<object>();

/** Records that the instance finished its first draw: from now on it has a viewport. */
export function markDrawn(graph: object): void {
  drawn.add(graph);
}

/** Whether the instance can be asked about its camera: created, drawn once, not destroyed. */
export function isLive<T extends GuardedGraph>(graph: T | null | undefined): graph is T {
  return Boolean(graph) && graph!.destroyed !== true && drawn.has(graph!);
}

/** The zoom, or `fallback` when the instance has no viewport (not drawn yet, or destroyed). */
export function zoomOf(graph: GuardedGraph | null | undefined, fallback = 1): number {
  if (!isLive(graph)) return fallback;
  try {
    const zoom = graph.getZoom();
    return Number.isFinite(zoom) && zoom > 0 ? zoom : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Resizes the instance to `width` x `height` when that differs from its size.
 * Ignored for an empty size, a destroyed instance, or one not drawn yet (its
 * canvas does not exist; the first draw syncs the size instead).
 *
 * @returns Whether the instance was resized.
 */
export function syncSize(graph: GuardedGraph | null | undefined, width: number, height: number): boolean {
  if (!width || !height || !isLive(graph)) return false;
  const [w, h] = graph.getSize();
  if (w === width && h === height) return false;
  try {
    graph.resize(width, height);
    return true;
  } catch {
    return false;
  }
}
