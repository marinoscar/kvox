/**
 * The brand mark, asserted where a test can actually reach it — issue #111.
 *
 * =============================================================================
 * THE MARK IS DESCRIBED THREE TIMES, AND ONLY ONE PAIR IS CHECKABLE HERE
 * =============================================================================
 *
 * `apps/web/public/icons/source.svg`, `apps/web/public/favicon.svg` and
 * `apps/web/scripts/generate-icons.py` each describe the same K monogram. The
 * duplication is deliberate and is explained at length in all three files: the
 * generator draws with Pillow rather than rasterising the SVGs, because
 * rendering an SVG needs rsvg / cairosvg / a headless browser — the image
 * toolchain this template refuses to require of a fork's CI.
 *
 * That refusal is also why this test compares the two SVGs and NOT the PNGs:
 * checking the generator's output against the vectors would need exactly the
 * toolchain the generator exists to avoid. So the third description is held in
 * step by review and by the shared constant names, and these two by arithmetic.
 *
 * =============================================================================
 * ⚠ NORMALISED MARK-BOX SPACE, NOT A RAW 512/32 SCALE FACTOR
 * =============================================================================
 *
 * The obvious comparison — multiply every favicon coordinate by 512/32 and
 * expect the source's — IS WRONG, and would fail on two files that agree
 * perfectly about the shape. The two crops differ on purpose: the source uses a
 * mark box at 68% of its canvas, the favicon 80%, because at tab size the
 * padding costs whole pixels the arms need.
 *
 * So each file is normalised against ITS OWN mark box first. The box is
 * recovered from the stem rather than hardcoded here — the stem spans the box's
 * full height by construction, so its `x`/`y` give the origin and its `height`
 * gives the side. A fourth copy of the two crop ratios in this file would be
 * one more thing to keep in step, which is the exact failure the test exists to
 * catch.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { THEME_COLOR } from '@app/shared';

const PUBLIC_DIR = join(__dirname, '..', '..', '..', 'public');

/** Every coordinate agrees to this many normalised units (0.05% of the box). */
const TOLERANCE = 0.0005;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string | null;
}

interface Line {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function attr(tag: string, name: string): string | null {
  const match = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return match ? match[1] : null;
}

function num(tag: string, name: string): number {
  const raw = attr(tag, name);
  // `x`/`y` are omitted when zero in SVG, which is legal and is what the plate
  // rect does. Treating a missing coordinate as NaN would fail the plate on a
  // technicality rather than on a disagreement.
  return raw === null ? 0 : Number.parseFloat(raw);
}

function parse(file: string): { rects: Rect[]; lines: Line[]; roundCaps: number } {
  const svg = readFileSync(join(PUBLIC_DIR, file), 'utf8');
  // The comment block above the markup mentions `rect` and `line` in prose, so
  // only the element form counts.
  const body = svg.slice(svg.indexOf('<svg'));

  const rects = [...body.matchAll(/<rect\b[^>]*>/g)].map((m) => ({
    x: num(m[0], 'x'),
    y: num(m[0], 'y'),
    width: num(m[0], 'width'),
    height: num(m[0], 'height'),
    fill: attr(m[0], 'fill'),
  }));

  const lines = [...body.matchAll(/<line\b[^>]*>/g)].map((m) => ({
    x1: num(m[0], 'x1'),
    y1: num(m[0], 'y1'),
    x2: num(m[0], 'x2'),
    y2: num(m[0], 'y2'),
  }));

  const roundCaps = [...body.matchAll(/stroke-linecap="round"/g)].length;

  return { rects, lines, roundCaps };
}

/** The plate is the only rect carrying a fill; the stem inherits from its `g`. */
function plateOf(rects: Rect[]): Rect {
  const plates = rects.filter((r) => r.fill !== null);
  expect(plates).toHaveLength(1);
  return plates[0];
}

function stemOf(rects: Rect[]): Rect {
  const stems = rects.filter((r) => r.fill === null);
  expect(stems).toHaveLength(1);
  return stems[0];
}

/**
 * Every coordinate as a fraction of the mark box, so the two crops compare.
 *
 * Returns the stem, both arms and the stroke width in one flat list, in a
 * stable order, because what matters is that the two files agree about all of
 * it — not which member disagreed first.
 */
function normalise(file: string): number[] {
  const { rects, lines } = parse(file);
  const stem = stemOf(rects);

  const origin = { x: stem.x, y: stem.y };
  const box = stem.height;
  const fx = (v: number) => (v - origin.x) / box;
  const fy = (v: number) => (v - origin.y) / box;

  const sorted = [...lines].sort((a, b) => a.y2 - b.y2);

  return [
    fx(stem.x),
    fy(stem.y),
    stem.width / box,
    stem.height / box,
    ...sorted.flatMap((l) => [fx(l.x1), fy(l.y1), fx(l.x2), fy(l.y2)]),
  ];
}

describe('the brand mark', () => {
  const FILES = ['icons/source.svg', 'favicon.svg'] as const;

  it.each(FILES)('%s carries exactly one plate in the brand colour', (file) => {
    const plate = plateOf(parse(file).rects);

    // Exactly one, because `scripts/rename.mjs` anchors a rebrand on a single
    // match per file and silently rewrites nothing if it finds two.
    expect(plate.fill).toBe(THEME_COLOR);
  });

  it.each(FILES)('%s draws the K as one stem and two round-capped arms', (file) => {
    const { rects, lines, roundCaps } = parse(file);

    expect(stemOf(rects)).toBeDefined();
    expect(lines).toHaveLength(2);
    // The caps are what make the Pillow drawing match: the generator has to
    // add a circle at each endpoint because its line width gives butt ends.
    expect(roundCaps).toBe(1);
  });

  it.each(FILES)('%s reaches exactly to the mark box, never past it', (file) => {
    const { rects, lines } = parse(file);
    const stem = stemOf(rects);
    const box = stem.height;
    const capRadius = stem.width / 2;

    for (const line of lines) {
      const right = (line.x2 - stem.x + capRadius) / box;
      // 0.915 + 0.085 == 1.0. A cap that overflowed would be clipped by the
      // maskable safe zone on Android before anyone noticed on desktop.
      expect(right).toBeCloseTo(1, 3);
    }
  });

  it('describes the same shape in both files, once each is normalised', () => {
    const source = normalise('icons/source.svg');
    const favicon = normalise('favicon.svg');

    expect(source).toHaveLength(favicon.length);
    source.forEach((value, index) => {
      expect(Math.abs(value - favicon[index])).toBeLessThan(TOLERANCE);
    });
  });

  it('puts the junction on the stem centre line in both files', () => {
    for (const file of FILES) {
      const { rects, lines } = parse(file);
      const stem = stemOf(rects);
      const centre = stem.x + stem.width / 2;

      // Both arms START there. An arm anchored to the stem's right EDGE
      // instead leaves a visible seam where the three strokes meet.
      for (const line of lines) {
        expect(Math.abs(line.x1 - centre)).toBeLessThan(stem.width * 0.02);
      }
    }
  });
});
