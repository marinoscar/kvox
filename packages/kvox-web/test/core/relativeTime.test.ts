import { setPreferredTimeZone } from '@marinoscar/platform-web/timezone/headless';
import { describe, expect, it } from 'vitest';

import { formatRelativeTime } from '../../src/core/headless/utils/relativeTime.js';

/**
 * `formatRelativeTime`: minutes and hours are an interval; days are calendar
 * days of the display zone, so "yesterday" is the previous LOCAL day.
 */

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const TOKYO = 'Asia/Tokyo';
const LA = 'America/Los_Angeles';

describe('formatRelativeTime', () => {
  const NOW = new Date('2026-10-27T12:00:00Z');

  it('keeps the interval wording for recent times', () => {
    expect(formatRelativeTime('2026-10-27T11:59:30Z', NOW)).toBe('Just now');
    expect(formatRelativeTime('2026-10-27T11:45:00Z', NOW)).toBe(rtf.format(-15, 'minute'));
    expect(formatRelativeTime('2026-10-27T09:00:00Z', NOW)).toBe(rtf.format(-3, 'hour'));
    expect(formatRelativeTime('not a date', NOW)).toBe('not a date');
  });

  it('calls the previous local day yesterday, however few hours ago', () => {
    // Read at 08:00 in Tokyo (23:00 UTC): 23:00 the evening before is nine hours back, and yesterday.
    const morning = new Date('2026-10-27T23:00:00Z');
    expect(formatRelativeTime('2026-10-27T14:00:00Z', morning, TOKYO)).toBe(rtf.format(-1, 'day'));
    // The same two instants in Los Angeles fall on one local day (07:00 and 16:00): hours.
    expect(formatRelativeTime('2026-10-27T14:00:00Z', morning, LA)).toBe(rtf.format(-9, 'hour'));
  });

  it('follows the display zone by default', () => {
    const morning = new Date('2026-10-27T23:00:00Z');
    setPreferredTimeZone(TOKYO);
    expect(formatRelativeTime('2026-10-27T14:00:00Z', morning)).toBe(rtf.format(-1, 'day'));
    setPreferredTimeZone(LA);
    expect(formatRelativeTime('2026-10-27T14:00:00Z', morning)).toBe(rtf.format(-9, 'hour'));
  });

  it('is not yesterday until the local day changes, even 23 hours back', () => {
    // 00:30 to 23:30 on 27 October in Tokyo.
    expect(formatRelativeTime('2026-10-26T15:30:00Z', new Date('2026-10-27T14:30:00Z'), TOKYO)).toBe(
      rtf.format(-23, 'hour'),
    );
  });

  it('says minutes across local midnight rather than yesterday', () => {
    // 23:50 and 00:10 in Tokyo.
    expect(formatRelativeTime('2026-10-27T14:50:00Z', new Date('2026-10-27T15:10:00Z'), TOKYO)).toBe(
      rtf.format(-20, 'minute'),
    );
  });

  it('counts calendar days up to a week, across a DST change', () => {
    // Friday 30 October 22:00 PDT to Monday 2 November 08:00 PST: three local days.
    expect(formatRelativeTime('2026-10-31T05:00:00Z', new Date('2026-11-02T16:00:00Z'), LA)).toBe(
      rtf.format(-3, 'day'),
    );
    expect(formatRelativeTime('2026-10-20T12:00:00Z', NOW, LA)).toBe(rtf.format(-1, 'week'));
    expect(formatRelativeTime('2026-08-01T12:00:00Z', NOW, LA)).toBe(rtf.format(-2, 'month'));
  });
});
