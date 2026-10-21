/**
 * The KVox mark as a standalone SVG string, for hosts that cannot render React
 * (the API's document exporters, a static page, an e-mail).
 *
 * It draws exactly what `BrandMark.tsx` of `@marinoscar/kvox-web/brand` draws, and
 * only from the geometry constants: a rounded plate in the brand colour, the K's
 * white stem, its two round-capped white arms and the five amber waveform bars.
 * The output is deterministic (no ids, no timestamps), so it can be snapshotted.
 */

import { KVOX_IDENTITY } from './identity.generated.js';
import {
  MARK_ACCENT,
  MARK_ARMS,
  MARK_BARS,
  MARK_CANVAS,
  MARK_INK,
  MARK_PLATE_RADIUS,
  MARK_STEM,
  MARK_STROKE,
  type MarkRect,
} from './mark-geometry.js';

/**
 * Options of {@link brandMarkSvg}.
 *
 * @stability experimental
 */
export interface BrandMarkSvgOptions {
  /** Side of the square image, in pixels (the `width` and `height` attributes). Default 256. */
  size?: number;
  /** The plate colour. Default `KVOX_IDENTITY.themeColor`. */
  plate?: string;
}

function rect(r: MarkRect): string {
  return `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" rx="${r.rx}"/>`;
}

/**
 * Returns the brand mark as a well-formed SVG document string.
 *
 * @param options - the pixel `size` (default 256) and the `plate` colour (default the brand colour).
 * @returns an SVG string with `xmlns`, a `0 0 32 32` viewBox and no external references.
 *
 * @example
 * ```ts
 * const svg = brandMarkSvg({ size: 64 });
 * ```
 *
 * @stability experimental
 */
export function brandMarkSvg(options: BrandMarkSvgOptions = {}): string {
  const size = options.size ?? 256;
  const plate = options.plate ?? KVOX_IDENTITY.themeColor;
  const arms = MARK_ARMS.map((a) => `<line x1="${a.x1}" y1="${a.y1}" x2="${a.x2}" y2="${a.y2}"/>`).join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${MARK_CANVAS} ${MARK_CANVAS}">` +
    `<rect width="${MARK_CANVAS}" height="${MARK_CANVAS}" rx="${MARK_PLATE_RADIUS}" fill="${plate}"/>` +
    `<g fill="${MARK_INK}">${rect(MARK_STEM)}</g>` +
    `<g stroke="${MARK_INK}" stroke-width="${MARK_STROKE}" stroke-linecap="round" fill="none">${arms}</g>` +
    `<g fill="${MARK_ACCENT}">${MARK_BARS.map(rect).join('')}</g>` +
    `</svg>`
  );
}
