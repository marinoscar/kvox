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
  /** Whether a round cap applies, from the `<line>` itself or its `<g>`. */
  roundCap: boolean;
}

/**
 * ⚠ THE LEADING `\\s` IS LOAD-BEARING. Without it, looking up `x` matches
 * inside `rx="112.64"` — the plate's own corner radius — and every rect
 * reports a non-zero origin, which silently reclassifies the plate as part of
 * the mark and the stem as a sixth bar. The bug is invisible until something
 * counts the bars.
 */
function attr(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match ? match[1] : null;
}

function num(tag: string, name: string): number {
  const raw = attr(tag, name);
  // `x`/`y` are omitted when zero in SVG, which is legal and is what the plate
  // rect does. Treating a missing coordinate as NaN would fail the plate on a
  // technicality rather than on a disagreement.
  return raw === null ? 0 : Number.parseFloat(raw);
}

function parse(file: string): { rects: Rect[]; lines: Line[] } {
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

  // `stroke-linecap` INHERITS, so where it is written is a formatting choice,
  // not a semantic one: today both files put it once on the `<g>` around the
  // two arms, and moving it onto each `<line>` would be the identical drawing.
  // A test that counted occurrences of the attribute would fail on that purely
  // cosmetic edit while still passing if somebody put a round cap on some
  // unrelated element and left the arms butt-ended — wrong in both directions.
  // So resolve it the way a renderer does: own attribute first, then the
  // enclosing group. The markup is flat and hand-written (one level of `<g>`,
  // no nesting), which is what makes this single-level walk sufficient.
  const lines: Line[] = [];
  let groupCap: string | null = null;
  for (const [tag] of body.matchAll(/<\/?(?:g|line)\b[^>]*>/g)) {
    if (tag.startsWith('</g')) {
      groupCap = null;
    } else if (tag.startsWith('<g')) {
      groupCap = attr(tag, 'stroke-linecap');
    } else {
      lines.push({
        x1: num(tag, 'x1'),
        y1: num(tag, 'y1'),
        x2: num(tag, 'x2'),
        y2: num(tag, 'y2'),
        roundCap: (attr(tag, 'stroke-linecap') ?? groupCap) === 'round',
      });
    }
  }

  return { rects, lines };
}

/**
 * The plate is the only rect that spans the whole canvas; everything else is
 * part of the mark. Classifying by SIZE rather than by fill, because since
 * #146 the bars carry their own `g fill` and a fill-based split would put
 * them on the plate's side of it.
 */
function plateOf(rects: Rect[]): Rect {
  const plates = rects.filter((r) => r.x === 0 && r.y === 0);
  expect(plates).toHaveLength(1);
  return plates[0];
}

/** The stem is the tallest of the remaining rects — the bars are all shorter. */
function stemOf(rects: Rect[]): Rect {
  const marks = rects.filter((r) => !(r.x === 0 && r.y === 0));
  const tallest = [...marks].sort((a, b) => b.height - a.height)[0];
  expect(tallest).toBeDefined();
  return tallest;
}

/** The five waveform bars: every mark rect that is not the stem. */
function barsOf(rects: Rect[]): Rect[] {
  const stem = stemOf(rects);
  return rects
    .filter((r) => !(r.x === 0 && r.y === 0) && r !== stem)
    .sort((a, b) => a.x - b.x);
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

  // ⚠ THE MARK IS NOT SQUARE since #146, so the normalising unit is its WIDTH
  // — stem left edge to the last bar's right edge — not the stem's height.
  // Using the height would still compare the two files consistently, but it
  // would stop matching the ratios the generator and both SVG headers state,
  // and a reader checking one against the other would be quietly misled.
  const bars = barsOf(rects);
  const lastBar = bars[bars.length - 1];
  const origin = { x: stem.x, y: stem.y };
  const box = lastBar.x + lastBar.width - stem.x;
  const fx = (v: number) => (v - origin.x) / box;
  const fy = (v: number) => (v - origin.y) / box;

  const sorted = [...lines].sort((a, b) => a.y2 - b.y2);

  return [
    fx(stem.x),
    fy(stem.y),
    stem.width / box,
    stem.height / box,
    ...sorted.flatMap((l) => [fx(l.x1), fy(l.y1), fx(l.x2), fy(l.y2)]),
    ...barsOf(rects).flatMap((b) => [
      fx(b.x),
      fy(b.y),
      b.width / box,
      b.height / box,
    ]),
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
    const { rects, lines } = parse(file);

    expect(stemOf(rects)).toBeDefined();
    expect(lines).toHaveLength(2);
    // The caps are what make the Pillow drawing match: the generator has to add
    // a circle at each endpoint because its `line` width gives BUTT ends, and
    // `joint="curve"` only affects joints between segments. A butt-ended arm
    // here would be a diagonal chop the PNGs do not have — a mismatch nothing
    // else in this repository can see.
    for (const line of lines) {
      expect(line.roundCap).toBe(true);
    }
  });

  it.each(FILES)('%s ends the waveform exactly on the mark\'s right edge', (file) => {
    const { rects } = parse(file);
    const stem = stemOf(rects);
    const bars = barsOf(rects);
    const lastBar = bars[bars.length - 1];
    const box = lastBar.x + lastBar.width - stem.x;

    // The bars, not the arms, are what reach the right edge since #146:
    // 0.4428 + 4 x 0.1184 + 0.0836 == 1.0000. The regular pitch is what makes
    // that land exactly, and a bar past the edge would be clipped by the
    // maskable safe zone on Android before anyone noticed it on desktop.
    expect(bars).toHaveLength(5);
    expect((lastBar.x + lastBar.width - stem.x) / box).toBeCloseTo(1, 6);
  });

  it.each(FILES)('%s draws five bars on one centre line at a regular pitch', (file) => {
    const { rects } = parse(file);
    const bars = barsOf(rects);

    const centres = bars.map((b) => b.y + b.height / 2);
    const first = centres[0];
    for (const centre of centres) {
      // The supplied artwork had the middle bar sitting lower while its
      // HEIGHT pattern was already symmetric, which is what says the offset
      // was an artifact rather than intent. Pinned so it cannot creep back.
      expect(Math.abs(centre - first)).toBeLessThan(bars[0].width * 0.02);
    }

    const pitches = bars.slice(1).map((b, i) => b.x - bars[i].x);
    for (const pitch of pitches) {
      expect(Math.abs(pitch - pitches[0])).toBeLessThan(bars[0].width * 0.02);
    }

    // Symmetric envelope: short, tall, medium, tall, short.
    expect(bars[0].height).toBeCloseTo(bars[4].height, 5);
    expect(bars[1].height).toBeCloseTo(bars[3].height, 5);
    expect(bars[2].height).toBeLessThan(bars[1].height);
    expect(bars[2].height).toBeGreaterThan(bars[0].height);
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
