import { setPreferredTimeZone } from '@marinoscar/platform-web/timezone/headless';
import { describe, expect, it } from 'vitest';

import {
  customRange,
  customRangeLabel,
  presetOf,
  presetRange,
  timeControlLabel,
} from '../../src/graph/ui/components/explorer/timebar/timePresets.js';

/** The one Time control's presets (#768): calendar days of the display zone (UTC on the test device), ending tomorrow. */
const NOW = Date.parse('2026-10-26T15:30:00Z');

describe('time presets', () => {
  it('a preset ends tomorrow and starts that many days before', () => {
    expect(presetRange('30d', NOW)).toEqual({ from: '2026-09-27', to: '2026-10-27' });
    expect(presetRange('90d', NOW)).toEqual({ from: '2026-07-29', to: '2026-10-27' });
    expect(presetRange('1y', NOW)).toEqual({ from: '2025-10-27', to: '2026-10-27' });
    expect(presetRange('all', NOW)).toBeNull();
  });

  it('reads a range back as its preset, else custom; no range is All time', () => {
    expect(presetOf(null, NOW)).toBe('all');
    expect(presetOf(presetRange('90d', NOW), NOW)).toBe('90d');
    expect(presetOf({ from: '2026-03-01', to: '2026-04-01' }, NOW)).toBe('custom');
  });

  it('labels a custom range by its included days', () => {
    expect(customRangeLabel({ from: '2026-03-01', to: '2026-04-01' })).toBe('1 Mar 2026 – 31 Mar 2026');
    expect(timeControlLabel(null, NOW)).toBe('All time');
    expect(timeControlLabel(presetRange('30d', NOW), NOW)).toBe('Last 30 days');
  });

  it('a custom range makes its inclusive end exclusive, and refuses an inverted one', () => {
    expect(customRange('2026-02-01', '2026-02-28')).toEqual({ from: '2026-02-01', to: '2026-03-01' });
    expect(customRange('2026-02-01', '2026-02-01')).toEqual({ from: '2026-02-01', to: '2026-02-02' });
    expect(customRange('2026-03-01', '2026-02-01')).toBeNull();
    expect(customRange('nope', '2026-02-01')).toBeNull();
  });
});

describe('time presets in the display zone', () => {
  // 15:30 UTC on 26 October: 00:30 on 27 October in Tokyo, 08:30 on 26 October in Los Angeles.
  it('ends at the local tomorrow: 28 October in Tokyo, 27 October in Los Angeles', () => {
    expect(presetRange('30d', NOW, 'Asia/Tokyo')).toEqual({ from: '2026-09-28', to: '2026-10-28' });
    expect(presetRange('30d', NOW, 'America/Los_Angeles')).toEqual({ from: '2026-09-27', to: '2026-10-27' });
  });

  it('reads the display zone by default, and matches its own preset back', () => {
    setPreferredTimeZone('Asia/Tokyo');
    const range = presetRange('90d', NOW);
    expect(range?.to).toBe('2026-10-28');
    expect(presetOf(range, NOW)).toBe('90d');
    // The same range is not "Last 90 days" for a viewer whose today is a day earlier.
    expect(presetOf(range, NOW, 'America/Los_Angeles')).toBe('custom');
  });

  it('counts a year back in calendar days across the DST changes', () => {
    expect(presetRange('1y', Date.parse('2026-11-02T07:30:00Z'), 'America/Los_Angeles')).toEqual({
      from: '2025-11-02',
      to: '2026-11-02',
    });
  });
});
