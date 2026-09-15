/**
 * `formatUtc` — issue #126, epic #118.
 *
 * The one helper the About page renders every timestamp through, so the
 * assertions here are the page's whole timestamp contract: the fixed
 * `YYYY-MM-DD HH:mm:ss UTC` shape, UTC regardless of the input's offset (and
 * regardless of the machine's zone — nothing below depends on `TZ`), and the
 * "unreadable input is still information" fallback.
 */

import { describe, it, expect } from 'vitest';
import { formatUtc } from '../../utils/formatUtc';

describe('formatUtc', () => {
  it('renders a Z-suffixed timestamp as YYYY-MM-DD HH:mm:ss UTC', () => {
    expect(formatUtc('2026-09-15T18:02:11.000Z')).toBe('2026-09-15 18:02:11 UTC');
  });

  it('normalises an offset timestamp to UTC rather than echoing the local wall clock', () => {
    // 20:02 at +02:00 IS 18:02 UTC. A helper that printed "20:02" here would be
    // printing the deploying operator's zone on every administrator's screen.
    expect(formatUtc('2026-09-15T20:02:11+02:00')).toBe('2026-09-15 18:02:11 UTC');
    expect(formatUtc('2026-09-15T13:02:11-05:00')).toBe('2026-09-15 18:02:11 UTC');
  });

  it('zero-pads every field so the strings sort and align', () => {
    expect(formatUtc('2026-01-05T03:04:09Z')).toBe('2026-01-05 03:04:09 UTC');
  });

  it('drops sub-second precision — nobody reads milliseconds off an About page', () => {
    expect(formatUtc('2026-09-14T22:41:07.999Z')).toBe('2026-09-14 22:41:07 UTC');
  });

  it('crosses a date boundary correctly when the offset pushes it over midnight', () => {
    expect(formatUtc('2026-01-01T01:30:00+03:00')).toBe('2025-12-31 22:30:00 UTC');
  });

  it('always ends in " UTC" for any parseable input', () => {
    for (const iso of ['2026-08-01T09:15:00.000Z', '1999-12-31T23:59:59Z', '2026-09-15T06:00:00+00:00']) {
      expect(formatUtc(iso)).toMatch(/ UTC$/);
    }
  });

  it('returns the input untouched when it cannot be parsed', () => {
    // The same convention `formatRelativeTime` follows: a timestamp this code
    // cannot read is still information, and `NaN-NaN-NaN` reads as data loss.
    expect(formatUtc('not-a-date')).toBe('not-a-date');
    expect(formatUtc('')).toBe('');
  });
});
