/**
 * Geometry helpers shared by the brand SVG tests (`brandAssets.test.ts`) and the
 * inline `BrandMark` test (`BrandMark.test.tsx`): both read the mark out of SVG
 * text with the same regexes and compare it in normalised mark space, so a
 * disagreement between any two descriptions of the mark is one comparison.
 *
 * See `brandAssets.test.ts` for why the comparison is in NORMALISED space and not
 * a raw 512/32 scale factor.
 */

import { expect } from 'vitest';

/** Every coordinate agrees to this many normalised units (0.05% of the box). */
export const TOLERANCE = 0.0005;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string | null;
}

export interface Line {
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
export function attr(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match ? match[1] : null;
}

export function num(tag: string, name: string): number {
  const raw = attr(tag, name);
  // `x`/`y` are omitted when zero in SVG, which is legal and is what the plate
  // rect does. Treating a missing coordinate as NaN would fail the plate on a
  // technicality rather than on a disagreement.
  return raw === null ? 0 : Number.parseFloat(raw);
}

export function parseSvg(svg: string): { rects: Rect[]; lines: Line[] } {
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
    } else if (tag.startsWith('</')) {
      // A closing `</line>`, which a serialised DOM writes and the hand-written files do not.
      continue;
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
export function plateOf(rects: Rect[]): Rect {
  const plates = rects.filter((r) => r.x === 0 && r.y === 0);
  expect(plates).toHaveLength(1);
  return plates[0];
}

/** The stem is the tallest of the remaining rects — the bars are all shorter. */
export function stemOf(rects: Rect[]): Rect {
  const marks = rects.filter((r) => !(r.x === 0 && r.y === 0));
  const tallest = [...marks].sort((a, b) => b.height - a.height)[0];
  expect(tallest).toBeDefined();
  return tallest;
}

/** The five waveform bars: every mark rect that is not the stem. */
export function barsOf(rects: Rect[]): Rect[] {
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
export function normaliseSvg(svg: string): number[] {
  const { rects, lines } = parseSvg(svg);
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

