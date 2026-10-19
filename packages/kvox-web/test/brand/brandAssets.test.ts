/**
 * The brand mark's vector assets, asserted where a test can actually reach them —
 * issue #111, moved into the package with the assets by issue #628.
 *
 * =============================================================================
 * THE MARK IS DESCRIBED THREE TIMES, AND ONLY ONE PAIR IS CHECKABLE HERE
 * =============================================================================
 *
 * `src/brand/assets/mark.svg`, `src/brand/assets/favicon.svg` and
 * `packages/kvox-web/scripts/generate-icons.py` each describe the same K monogram. The
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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KVOX_BRAND } from '../../src/brand/identity.js';
import { TOLERANCE, barsOf, normaliseSvg, parseSvg, plateOf, stemOf } from './svgGeometry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = join(HERE, '..', '..', 'src', 'brand', 'assets');

function parse(file: string) {
  return parseSvg(readFileSync(join(ASSETS_DIR, file), 'utf8'));
}

function normalise(file: string): number[] {
  return normaliseSvg(readFileSync(join(ASSETS_DIR, file), 'utf8'));
}

describe('the brand mark', () => {
  const FILES = ['mark.svg', 'favicon.svg'] as const;

  it.each(FILES)('%s carries exactly one plate in the brand colour', (file) => {
    const plate = plateOf(parse(file).rects);

    // Exactly one, because `scripts/rename.mjs` anchors a rebrand on a single
    // match per file and silently rewrites nothing if it finds two.
    expect(plate.fill).toBe(KVOX_BRAND.themeColor);
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
    const source = normalise('mark.svg');
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

  /**
   * =============================================================================
   * WELL-FORMED XML IS A SEPARATE CLAIM FROM "THE GEOMETRY MATCHES" (issue #157)
   * =============================================================================
   *
   * Both brand SVGs once shipped with a `--` typed as a prose dash inside their
   * header comment. HTML tolerates that; XML does not — a doubled hyphen is
   * illegal anywhere in a comment body, full stop. Every other test in this file
   * passed anyway, because `parse()` above slices the string with `<rect\b` /
   * `<line\b` regexes: a regex reads past a malformed comment exactly as
   * happily as it reads past a well-formed one, so the shape comparison never
   * touches the one thing that was actually broken. `<img src="favicon.svg">`
   * and `<link rel="icon" type="image/svg+xml">` both hand these bytes to the
   * browser's XML parser, not its HTML parser, and there a fatal error aborts
   * the whole document — which is why this shipped as a broken-image glyph on
   * the login page and in the AppBar, in production, for hours, with every
   * test in this suite green.
   *
   * So this uses an actual XML parser rather than a `--`-substring check,
   * deliberately: a stray unescaped `&`, an unclosed tag, or a mismatched
   * element are the same class of failure from a browser's point of view, and
   * a substring search would catch none of them. jsdom's `DOMParser` parses
   * `text/xml`/`image/svg+xml` strictly and reports a `<parsererror>` element
   * instead of throwing, which is what `expect(...).toHaveLength(0)` reads
   * below. Do not delete this as "redundant with the shape comparison" — the
   * shape comparison is a statement about two files agreeing with each other,
   * this is a statement about either file being loadable at all, and #157 is
   * proof the first can hold while the second fails silently.
   */
  it.each(FILES)('%s is well-formed XML', (file) => {
    const svg = readFileSync(join(ASSETS_DIR, file), 'utf8');
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const errors = doc.getElementsByTagName('parsererror');

    expect(errors).toHaveLength(0);
  });
});
