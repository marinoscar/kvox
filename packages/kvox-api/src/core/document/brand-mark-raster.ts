// =============================================================================
// The KVox mark as a PNG, rasterised in pure JavaScript
// =============================================================================
//
// Word cannot embed an SVG reliably and an e-mail client cannot either, so the
// exporters need a bitmap of the logo. This file draws it from the contract's
// geometry (`@marinoscar/kvox-contract/brand`) with no image dependency, in the
// same zero-dependency spirit as `apps/api/scripts/make-email-logo.mjs`:
//
//   * each shape is a signed-distance field (rounded rectangle, capsule) with a
//     precomputed bounding box, so the edge is exact at any size and most
//     samples are rejected cheaply;
//   * 4x4 supersampling gives the antialiasing;
//   * shapes are painted in the order of `BrandMark.tsx` (plate, white K, amber
//     bars) over a transparent background, so the plate's corners stay clear;
//   * the PNG is 8-bit RGBA, non-interlaced, written with `node:zlib` and a
//     hand-written CRC32. Same size in, same bytes out; the result is memoised.
// =============================================================================

import { deflateSync } from 'node:zlib';

import {
  KVOX_IDENTITY,
  MARK_ACCENT,
  MARK_ARMS,
  MARK_BARS,
  MARK_CANVAS,
  MARK_INK,
  MARK_PLATE_RADIUS,
  MARK_STEM,
  MARK_STROKE,
  brandMarkSvg,
  type MarkRect,
} from '@marinoscar/kvox-contract/brand';

const SUPERSAMPLE = 4;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

type Rgb = readonly [number, number, number];

/** A rounded rectangle, with its bounding box precomputed. */
interface RectShape {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly cx: number;
  readonly cy: number;
  readonly ix: number; // half-width minus corner radius
  readonly iy: number;
  readonly rad: number;
}

/** A capsule (the round-capped stroke of a segment), with its bounding box precomputed. */
interface CapsuleShape {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly x1: number;
  readonly y1: number;
  readonly dx: number;
  readonly dy: number;
  readonly len2: number;
  readonly r2: number;
}

function rgb(hex: string): Rgb {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as unknown as Rgb;
}

function roundedRect(r: MarkRect): RectShape {
  const hx = r.width / 2;
  const hy = r.height / 2;
  const rad = Math.min(r.rx, hx, hy);
  return {
    minX: r.x,
    minY: r.y,
    maxX: r.x + r.width,
    maxY: r.y + r.height,
    cx: r.x + hx,
    cy: r.y + hy,
    ix: hx - rad,
    iy: hy - rad,
    rad,
  };
}

function capsule(x1: number, y1: number, x2: number, y2: number, radius: number): CapsuleShape {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return {
    minX: Math.min(x1, x2) - radius,
    minY: Math.min(y1, y2) - radius,
    maxX: Math.max(x1, x2) + radius,
    maxY: Math.max(y1, y2) + radius,
    x1,
    y1,
    dx,
    dy,
    len2: dx * dx + dy * dy,
    r2: radius * radius,
  };
}

/** Inside a rounded rectangle (signed distance at most 0), without a square root. */
function inRect(s: RectShape, x: number, y: number): boolean {
  if (x < s.minX || x > s.maxX || y < s.minY || y > s.maxY) return false;
  const qx = Math.abs(x - s.cx) - s.ix;
  const qy = Math.abs(y - s.cy) - s.iy;
  if (qx > 0 && qy > 0) return qx * qx + qy * qy <= s.rad * s.rad;
  return (qx > qy ? qx : qy) <= s.rad;
}

function inCapsule(s: CapsuleShape, x: number, y: number): boolean {
  if (x < s.minX || x > s.maxX || y < s.minY || y > s.maxY) return false;
  const t = s.len2 === 0 ? 0 : Math.min(1, Math.max(0, ((x - s.x1) * s.dx + (y - s.y1) * s.dy) / s.len2));
  const ex = x - (s.x1 + t * s.dx);
  const ey = y - (s.y1 + t * s.dy);
  return ex * ex + ey * ey <= s.r2;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height); // filter byte 0 (None) per row
  for (let y = 0; y < height; y += 1) {
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const cache = new Map<number, Buffer>();

/**
 * The brand mark as an 8-bit RGBA PNG, `sizePx` pixels square: the brand-coloured
 * rounded plate (corners transparent), the white K and the amber waveform bars.
 *
 * Deterministic and memoised per size; do not mutate the returned buffer.
 *
 * @param sizePx - the side in pixels, a positive integer. Default 256.
 * @stability experimental
 */
export function brandMarkPng(sizePx = 256): Buffer {
  if (!Number.isInteger(sizePx) || sizePx < 1 || sizePx > 4096) {
    throw new RangeError(`brandMarkPng: size must be an integer in 1..4096, got ${sizePx}`);
  }
  const hit = cache.get(sizePx);
  if (hit) return hit;

  const plate = roundedRect({ x: 0, y: 0, width: MARK_CANVAS, height: MARK_CANVAS, rx: MARK_PLATE_RADIUS });
  const stem = roundedRect(MARK_STEM);
  const arms = MARK_ARMS.map((a) => capsule(a.x1, a.y1, a.x2, a.y2, MARK_STROKE / 2));
  const bars = MARK_BARS.map(roundedRect);
  const plateRgb = rgb(KVOX_IDENTITY.themeColor);
  const inkRgb = rgb(MARK_INK);
  const accentRgb = rgb(MARK_ACCENT);

  // Topmost painted colour at (x, y): accent bars, then the ink, then the plate.
  const hitColor = (x: number, y: number): Rgb | null => {
    for (let i = 0; i < bars.length; i += 1) if (inRect(bars[i]!, x, y)) return accentRgb;
    if (inRect(stem, x, y)) return inkRgb;
    for (let i = 0; i < arms.length; i += 1) if (inCapsule(arms[i]!, x, y)) return inkRgb;
    return inRect(plate, x, y) ? plateRgb : null;
  };

  const scale = MARK_CANVAS / sizePx;
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  const out = new Uint8Array(sizePx * sizePx * 4);
  for (let py = 0; py < sizePx; py += 1) {
    for (let px = 0; px < sizePx; px += 1) {
      // Premultiplied accumulation of the per-sample painted colour.
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = (px + (sx + 0.5) / SUPERSAMPLE) * scale;
          const y = (py + (sy + 0.5) / SUPERSAMPLE) * scale;
          const color = hitColor(x, y);
          if (color) {
            r += color[0];
            g += color[1];
            b += color[2];
            covered += 1;
          }
        }
      }
      const o = (py * sizePx + px) * 4;
      if (covered > 0) {
        out[o] = Math.round(r / covered);
        out[o + 1] = Math.round(g / covered);
        out[o + 2] = Math.round(b / covered);
        out[o + 3] = Math.round((covered / samples) * 255);
      }
    }
  }
  const png = encodePng(sizePx, sizePx, out);
  cache.set(sizePx, png);
  return png;
}

/**
 * The brand mark as an SVG document in a `Buffer` (UTF-8), 256 px nominal size.
 *
 * @stability experimental
 */
export function brandMarkSvgBuffer(): Buffer {
  return Buffer.from(brandMarkSvg(), 'utf8');
}
