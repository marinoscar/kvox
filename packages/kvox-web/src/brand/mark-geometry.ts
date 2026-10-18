/**
 * The geometry of the KVox mark on a 32 canvas, as data.
 *
 * It is the favicon crop (`assets/favicon.svg`: the mark spans 80% of the
 * canvas, the size regime of a 28px app-bar mark), drawn by `BrandMark.tsx` as
 * inline SVG. `assets/mark.svg` (the 512 master, mark at 68%) and
 * `assets/favicon.svg` describe the same drawing at their own crops, and
 * `generate-icons.py` draws it a third time in Pillow; the brand tests compare
 * this data with both SVGs in normalised mark space, so an edit that moves one
 * and not the others fails there.
 *
 * Every number below is copied from `assets/favicon.svg`. The plate colour is
 * not here: it is `KVOX_BRAND.themeColor`, because a rebrand rewrites it.
 */

/** A rounded rectangle of the mark. */
export interface MarkRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rx: number;
}

/** A round-capped line of the mark (one arm of the K). */
export interface MarkLine {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/** The canvas side, in SVG user units. */
export const MARK_CANVAS = 32;
/** The plate's corner radius: 0.22 of the canvas, the master's `rx`. */
export const MARK_PLATE_RADIUS = 7.04;
/** The K's stroke width, shared by the stem and both arms. */
export const MARK_STROKE = 3.338;
/** The ink of the K. */
export const MARK_INK = '#fff';
/** The waveform's amber: the brand's accent, which `identity.json` does not carry. */
export const MARK_ACCENT = '#fbbf24';

/** The K's stem. */
export const MARK_STEM: MarkRect = { x: 3.2, y: 6.554, width: 3.338, height: 18.893, rx: 1.669 };

/** The K's two arms, both starting on the stem's centre line. */
export const MARK_ARMS: readonly MarkLine[] = [
  { x1: 4.869, y1: 16.0, x2: 16.11, y2: 9.009 },
  { x1: 4.869, y1: 16.0, x2: 16.11, y2: 22.991 },
];

/** The five waveform bars, left to right: short, tall, medium, tall, short. */
export const MARK_BARS: readonly MarkRect[] = [
  { x: 14.536, y: 13.686, width: 2.14, height: 4.628, rx: 1.07 },
  { x: 17.567, y: 11.717, width: 2.14, height: 8.566, rx: 1.07 },
  { x: 20.598, y: 12.332, width: 2.14, height: 7.337, rx: 1.07 },
  { x: 23.629, y: 11.717, width: 2.14, height: 8.566, rx: 1.07 },
  { x: 26.66, y: 13.686, width: 2.14, height: 4.628, rx: 1.07 },
];
