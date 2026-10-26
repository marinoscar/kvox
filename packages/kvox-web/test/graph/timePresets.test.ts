import { describe, expect, it } from 'vitest';

import {
  customRange,
  customRangeLabel,
  presetOf,
  presetRange,
  timeControlLabel,
} from '../../src/graph/ui/components/explorer/timebar/timePresets.js';

/** The one Time control's presets (#768): UTC days, ending tomorrow. */
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
