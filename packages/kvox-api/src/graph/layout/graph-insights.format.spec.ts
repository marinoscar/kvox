import { formatDay } from './graph-insights.service.js';

describe('formatDay (the date-only part of a fading-tie sentence)', () => {
  // 2026-10-27T02:30Z: the evening of the 26th in Chicago, already the 27th in Tokyo.
  const at = new Date('2026-10-27T02:30:00Z');

  it("cuts the day in the requester's zone", () => {
    expect(formatDay(at, 'America/Chicago')).toBe('Oct 26, 2026');
    expect(formatDay(at, 'Asia/Tokyo')).toBe('Oct 27, 2026');
    expect(formatDay(at, 'UTC')).toBe('Oct 27, 2026');
  });

  it('reads an unknown zone as UTC and prints the date only, never a time', () => {
    expect(formatDay(at, 'Not/AZone')).toBe('Oct 27, 2026');
    expect(formatDay(at, 'Asia/Tokyo')).not.toMatch(/\d:\d/);
  });
});
