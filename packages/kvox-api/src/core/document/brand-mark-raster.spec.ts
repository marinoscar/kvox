import { inflateSync } from 'node:zlib';

import { KVOX_IDENTITY, MARK_ACCENT, MARK_BARS, MARK_CANVAS } from '@marinoscar/kvox-contract/brand';

import { brandMarkPng, brandMarkSvgBuffer } from './brand-mark-raster.js';

function decode(png: Buffer): { width: number; height: number; px: (x: number, y: number) => number[] } {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  expect(png[24]).toBe(8);
  expect(png[25]).toBe(6);
  const idat: Buffer[] = [];
  for (let o = 8; o < png.length; ) {
    const len = png.readUInt32BE(o);
    if (png.toString('ascii', o + 4, o + 8) === 'IDAT') idat.push(png.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  return {
    width,
    height,
    px: (x, y) => [...raw.subarray(y * (stride + 1) + 1 + x * 4, y * (stride + 1) + 1 + x * 4 + 4)],
  };
}

const hex = (h: string): number[] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

describe('brandMarkPng', () => {
  const size = 128;
  const img = decode(brandMarkPng(size));
  const scale = size / MARK_CANVAS;

  it('has the requested dimensions', () => {
    expect([img.width, img.height]).toEqual([size, size]);
  });

  it('is deterministic and memoised', () => {
    expect(brandMarkPng(size)).toBe(brandMarkPng(size));
    expect(brandMarkPng(64).equals(brandMarkPng(64))).toBe(true);
  });

  it('paints the plate in the theme colour left of the K', () => {
    expect(img.px(Math.round(1.5 * scale), Math.round(16 * scale))).toEqual([...hex(KVOX_IDENTITY.themeColor), 255]);
  });

  it('leaves the corner transparent', () => {
    expect(img.px(0, 0)[3]).toBe(0);
    expect(img.px(size - 1, size - 1)[3]).toBe(0);
  });

  it('paints an amber bar', () => {
    const bar = MARK_BARS[1]!;
    const x = Math.round((bar.x + bar.width / 2) * scale);
    const y = Math.round((bar.y + bar.height / 2) * scale);
    expect(img.px(x, y)).toEqual([...hex(MARK_ACCENT), 255]);
  });

  it('paints the stem white', () => {
    expect(img.px(Math.round(4.8 * scale), Math.round(10 * scale))).toEqual([255, 255, 255, 255]);
  });

  it('rejects a bad size', () => {
    expect(() => brandMarkPng(0)).toThrow(RangeError);
  });
});

describe('brandMarkSvgBuffer', () => {
  it('is the UTF-8 SVG', () => {
    expect(brandMarkSvgBuffer().toString('utf8')).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  });
});
