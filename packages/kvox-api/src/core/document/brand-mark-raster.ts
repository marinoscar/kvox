// =============================================================================
// The KVox mark as a PNG, rasterised in pure JavaScript
// =============================================================================
//
// Word cannot embed an SVG reliably and an e-mail client cannot either, so the
// exporters need a bitmap of the logo. This file draws it from the contract's
// geometry (`@marinoscar/kvox-contract/brand`) with no image dependency, in the
// same zero-dependency spirit as `apps/api/scripts/make-email-logo.mjs`:
//
//   * each shape is a signed-distance field (rounded rectangle, capsule), so the
//     edge is exact at any size;
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

type Shape = (x: number, y: number) => boolean;
type Rgb = readonly [number, number, number];

function rgb(hex: string): Rgb {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as unknown as Rgb;
}

/** Signed distance to a rounded rectangle (negative inside). */
function roundedRectShape(r: MarkRect): Shape {
  const hx = r.width / 2;
  const hy = r.height / 2;
  const cx = r.x + hx;
  const cy = r.y + hy;
  const rad = Math.min(r.rx, hx, hy);
  return (x, y) => {
    const qx = Math.abs(x - cx) - (hx - rad);
    const qy = Math.abs(y - cy) - (hy - rad);
    const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rad;
    return d <= 0;
  };
}

/** A capsule: the round-capped stroke of a segment. */
function capsuleShape(x1: number, y1: number, x2: number, y2: number, radius: number): Shape {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  return (x, y) => {
    const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((x - x1) * dx + (y - y1) * dy) / len2));
    return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)) <= radius;
  };
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

  const plate = roundedRectShape({ x: 0, y: 0, width: MARK_CANVAS, height: MARK_CANVAS, rx: MARK_PLATE_RADIUS });
  const ink: Shape[] = [
    roundedRectShape(MARK_STEM),
    ...MARK_ARMS.map((a) => capsuleShape(a.x1, a.y1, a.x2, a.y2, MARK_STROKE / 2)),
  ];
  const bars = MARK_BARS.map(roundedRectShape);
  const layers: { color: Rgb; shapes: readonly Shape[] }[] = [
    { color: rgb(KVOX_IDENTITY.themeColor), shapes: [plate] },
    { color: rgb(MARK_INK), shapes: ink },
    { color: rgb(MARK_ACCENT), shapes: bars },
  ];

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
          let color: Rgb | null = null;
          for (const layer of layers) if (layer.shapes.some((s) => s(x, y))) color = layer.color;
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
