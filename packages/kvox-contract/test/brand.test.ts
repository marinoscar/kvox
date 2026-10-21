import { describe, expect, it } from 'vitest';

import {
  BRAND_TOKENS,
  KVOX_IDENTITY,
  MARK_ARMS,
  MARK_BARS,
  MARK_CANVAS,
  brandMarkSvg,
} from '../src/brand/index.js';

describe('@marinoscar/kvox-contract/brand', () => {
  it('uses the generated brand colour as the light primary', () => {
    expect(BRAND_TOKENS.light.primary.main).toBe(KVOX_IDENTITY.themeColor);
  });

  it('draws a well-formed, deterministic SVG from the geometry', () => {
    const svg = brandMarkSvg();
    expect(svg).toBe(brandMarkSvg());
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain(`viewBox="0 0 ${MARK_CANVAS} ${MARK_CANVAS}"`);
    expect(svg).toContain('width="256" height="256"');
    expect(svg).toContain(`fill="${KVOX_IDENTITY.themeColor}"`);
    expect(svg.match(/<line /g)).toHaveLength(MARK_ARMS.length);
    expect(svg.match(/<rect /g)).toHaveLength(1 + 1 + MARK_BARS.length);
  });

  it('honours size and plate', () => {
    const svg = brandMarkSvg({ size: 64, plate: '#000000' });
    expect(svg).toContain('width="64" height="64"');
    expect(svg).toContain('fill="#000000"');
  });
});
