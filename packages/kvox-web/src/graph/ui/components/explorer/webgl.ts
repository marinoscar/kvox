/**
 * Drawing-surface detection for the explorer, the overview and the entity-page
 * neighbourhood widget (#374; G6, #775). The G6 canvas draws with the 2D
 * Canvas API (it needs no WebGL); without a 2D context the explorer forces its
 * list view and the widget hides itself (the Connections list below it already
 * carries the same content).
 *
 * The exported names keep "WebGL" for compatibility with hosts and their tests
 * (`mockGraphCanvas({ webgl })`); what they report is "the canvas can draw".
 *
 * Probed once per page load and cached. jsdom has no 2D canvas, so tests force
 * the answer rather than mock the canvas element.
 */

let cached: boolean | null = null;

/** Whether the browser can draw the graph canvas (a 2D canvas context exists). */
export function isWebGLAvailable(): boolean {
  if (cached !== null) return cached;
  try {
    // No 2D context constructor at all (jsdom, very old browsers): don't even ask a
    // canvas, whose unimplemented `getContext` would only log noise.
    if (
      typeof window === 'undefined' ||
      typeof document === 'undefined' ||
      typeof window.CanvasRenderingContext2D === 'undefined'
    ) {
      cached = false;
      return cached;
    }
    const canvas = document.createElement('canvas');
    cached = Boolean(canvas.getContext('2d'));
  } catch {
    cached = false;
  }
  return cached;
}

/**
 * Test seam: force the answer (`true`/`false`), or `null` to probe again.
 *
 * @param value - The answer to report, or `null` to forget the forced one.
 *
 * @stability experimental
 */
export function overrideWebGLAvailability(value: boolean | null): void {
  cached = value;
}

/** Test seam: forget the cached answer. */
export function resetWebGLDetection(): void {
  cached = null;
}
