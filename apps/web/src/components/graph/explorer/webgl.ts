/**
 * WebGL detection for the explorer and the entity-page neighbourhood widget
 * (#374). Sigma draws with WebGL only; without it the explorer forces its list
 * view and the widget hides itself (the Connections list below it already
 * carries the same content).
 *
 * Probed once per page load and cached: creating a context is not free, and
 * the answer cannot change without a reload. jsdom has no WebGL, so tests mock
 * this module rather than the canvas element.
 */

let cached: boolean | null = null;

export function isWebGLAvailable(): boolean {
  if (cached !== null) return cached;
  try {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      cached = false;
      return cached;
    }
    const canvas = document.createElement('canvas');
    const context =
      (canvas.getContext('webgl2') as WebGL2RenderingContext | null) ??
      (canvas.getContext('webgl') as WebGLRenderingContext | null);
    cached = Boolean(context);
  } catch {
    cached = false;
  }
  return cached;
}

/** Test seam: forget the cached answer. */
export function resetWebGLDetection(): void {
  cached = null;
}
