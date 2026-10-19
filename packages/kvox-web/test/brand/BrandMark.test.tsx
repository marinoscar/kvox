/**
 * `BrandMark` and `BrandLockup` (issue #628): inline SVG with no network and no
 * `public/` folder, and the same drawing as the vector assets.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BrandLockup, BrandMark, KVOX_BRAND, kvoxTokens } from '../../src/brand/index.js';
import { TOLERANCE, normaliseSvg, parseSvg, plateOf } from './svgGeometry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const asset = (name: string): string =>
  readFileSync(join(HERE, '..', '..', 'src', 'brand', 'assets', name), 'utf8');

function renderedMark(): string {
  const { container } = render(<BrandMark />);
  const svg = container.querySelector('svg');
  expect(svg).not.toBeNull();
  return svg!.outerHTML;
}

describe('BrandMark', () => {
  it('renders inline SVG: no <img>, no external reference', () => {
    const { container } = render(<BrandMark />);

    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).not.toMatch(/href=|src=|url\(/);
  });

  it('is decorative by default: hidden from assistive technology, no name', () => {
    render(<BrandMark />);

    const mark = screen.getByTestId('kvox-brand-mark');
    expect(mark).toHaveAttribute('aria-hidden', 'true');
    expect(mark).not.toHaveAttribute('role');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('is an image with a name when `title` is given', () => {
    render(<BrandMark title="KVox" />);

    expect(screen.getByRole('img', { name: 'KVox' })).toBeInTheDocument();
    expect(screen.getByTestId('kvox-brand-mark')).not.toHaveAttribute('aria-hidden');
  });

  it('sizes the box from `size` (default 28) and clips it with the plate ratio', () => {
    const { rerender } = render(<BrandMark />);
    expect(screen.getByTestId('kvox-brand-mark')).toHaveAttribute('width', '28');
    expect(screen.getByTestId('kvox-brand-mark')).toHaveAttribute('height', '28');

    rerender(<BrandMark size={56} />);
    const mark = screen.getByTestId('kvox-brand-mark');
    expect(mark).toHaveAttribute('width', '56');
    // `sx` borderRadius is a number x the theme's shape unit (4 in MUI's default
    // theme), the behaviour of the former <img>: size * 0.22 is the multiplier.
    expect(getComputedStyle(mark).borderRadius).toBe(`${56 * 0.22 * 4}px`);
  });

  it('merges a caller sx after its own', () => {
    render(<BrandMark sx={{ opacity: 0.5 }} />);

    expect(getComputedStyle(screen.getByTestId('kvox-brand-mark')).opacity).toBe('0.5');
  });

  it('paints the plate in the brand colour and the waveform in the accent', () => {
    const svg = renderedMark();
    const { rects } = parseSvg(svg);

    expect(plateOf(rects).fill).toBe(KVOX_BRAND.themeColor);
    expect(plateOf(rects).fill).toBe(kvoxTokens.brand.indigo);
    expect(svg).toContain(`fill="${kvoxTokens.brand.amber}"`);
  });

  // The parity test of the issue: the inline geometry is the asset geometry.
  it.each(['favicon.svg', 'mark.svg'])('draws the same mark as assets/%s, in normalised mark space', (file) => {
    const inline = normaliseSvg(renderedMark());
    const vector = normaliseSvg(asset(file));

    expect(inline).toHaveLength(vector.length);
    inline.forEach((value, index) => {
      expect(Math.abs(value - vector[index])).toBeLessThan(TOLERANCE);
    });
  });

  it('matches assets/favicon.svg number for number (same canvas, same crop)', () => {
    const inline = parseSvg(renderedMark());
    const vector = parseSvg(asset('favicon.svg'));

    expect(inline.rects).toHaveLength(vector.rects.length);
    inline.rects.forEach((rect, index) => {
      const other = vector.rects[index]!;
      for (const key of ['x', 'y', 'width', 'height'] as const) {
        expect(rect[key]).toBeCloseTo(other[key], 6);
      }
    });
    expect(inline.lines).toEqual(vector.lines);
  });
});

describe('BrandLockup', () => {
  it('draws the mark and the product name, in that order', () => {
    const { container } = render(<BrandLockup />);

    expect(container).toHaveTextContent(KVOX_BRAND.productName);
    const mark = screen.getByTestId('kvox-brand-mark');
    expect(mark).toHaveAttribute('aria-hidden', 'true');
    expect(mark).toHaveAttribute('width', '28');
    expect(mark.nextSibling?.textContent).toBe(KVOX_BRAND.productName);
  });

  it('is an inline flex row with an 8px gap, as the web app bar draws it', () => {
    const { container } = render(<BrandLockup />);
    const root = container.firstElementChild as HTMLElement;

    expect(root.tagName).toBe('SPAN');
    const style = getComputedStyle(root);
    expect(style.display).toBe('inline-flex');
    expect(style.alignItems).toBe('center');
    expect(style.gap).toBe('8px');
  });

  it('passes `size` to the mark', () => {
    render(<BrandLockup size={40} />);

    expect(screen.getByTestId('kvox-brand-mark')).toHaveAttribute('width', '40');
  });

  it('without the name it is the mark alone, still announced once as the product name', () => {
    const { container } = render(<BrandLockup showName={false} />);

    // No text node beside the mark (the <title> inside the svg is the accessible name).
    expect(container.firstElementChild?.childNodes).toHaveLength(1);
    expect(screen.getByRole('img', { name: KVOX_BRAND.productName })).toBeInTheDocument();
  });
});
