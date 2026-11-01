import { setPreferredTimeZone } from '@marinoscar/platform-web/timezone/headless';
import { describe, expect, it } from 'vitest';

import { monthLabel, parseAsOfParam } from '../../src/graph/headless/utils/explorerFilters.js';
import { monthSteps } from '../../src/graph/ui/components/explorer/AsOfSlider.js';

/**
 * The as-of control: its value is a CALENDAR date (`YYYY-MM-01`) the API reads
 * at UTC midnight, but which month is "now" is the user's local calendar.
 */
describe('as-of months', () => {
  // 22:00 on 31 March in Los Angeles is 05:00 on 1 April UTC (and 14:00 in Tokyo).
  const NOW = new Date('2026-04-01T05:00:00Z');

  it('ends on the local current month', () => {
    expect(monthSteps('2026-01-01', NOW, 'America/Los_Angeles')).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
    expect(monthSteps('2026-01-01', NOW, 'Asia/Tokyo')).toEqual([
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
      '2026-04-01',
    ]);
  });

  it('reads the display zone by default, and an instant minimum in it', () => {
    setPreferredTimeZone('America/Los_Angeles');
    // 03:00 UTC on 1 February is still 31 January in Los Angeles.
    expect(monthSteps('2026-02-01T03:00:00Z', NOW)).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
    // A bare day is its own month in every zone.
    expect(monthSteps('2026-02-01', NOW)).toEqual(['2026-02-01', '2026-03-01']);
  });

  it('keeps the value and its label a calendar date', () => {
    setPreferredTimeZone('America/Los_Angeles');
    expect(parseAsOfParam('2026-03-01')).toBe('2026-03-01');
    expect(monthLabel('2026-03-01')).toBe('Mar 2026');
    expect(parseAsOfParam('2026-02-31')).toBeNull();
    expect(parseAsOfParam('2026-3-1')).toBeNull();
    expect(parseAsOfParam(null)).toBeNull();
  });
});
