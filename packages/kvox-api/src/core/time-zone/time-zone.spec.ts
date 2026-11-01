import {
  dayKeyToFloatingDate,
  instantFromDayOrIso,
  isValidTimeZone,
  localDateKey,
  localDayStart,
  localTimeOfDay,
  pickTimeZone,
  weekdayOfDayKey,
} from './time-zone.js';

// 2026-10-27T02:30:00Z is still the 26th in Chicago (CDT, UTC-5) and already the 27th in Tokyo (UTC+9).
const INSTANT = new Date('2026-10-27T02:30:00.000Z');

describe('time zone helpers', () => {
  it('cuts the same instant on different days in different zones', () => {
    expect(localDateKey(INSTANT, 'America/Chicago')).toBe('2026-10-26');
    expect(localDateKey(INSTANT, 'Asia/Tokyo')).toBe('2026-10-27');
    expect(localDateKey(INSTANT, 'UTC')).toBe('2026-10-27');
  });

  it('reads an invalid zone as UTC instead of throwing', () => {
    expect(localDateKey(INSTANT, 'Not/AZone')).toBe('2026-10-27');
    expect(pickTimeZone('Not/AZone', null, undefined)).toBe('UTC');
  });

  it('picks the first valid candidate', () => {
    expect(pickTimeZone(null, 'Not/AZone', 'Asia/Tokyo', 'America/Chicago')).toBe('Asia/Tokyo');
  });

  it('validates zone ids', () => {
    expect(isValidTimeZone('America/Costa_Rica')).toBe(true);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
    expect(isValidTimeZone('x'.repeat(100))).toBe(false);
  });

  it('names the weekday of a day key and formats a 24-hour local time', () => {
    expect(weekdayOfDayKey('2026-10-26')).toBe('Monday');
    expect(localTimeOfDay(new Date('2026-10-27T02:42:00Z'), 'America/Chicago')).toBe('21:42');
    expect(localTimeOfDay(new Date('2026-10-27T00:05:00Z'), 'UTC')).toBe('00:05');
  });

  it('local midnight is a different instant per zone and DST-correct', () => {
    expect(localDayStart('2026-10-26', 'America/Chicago').toISOString()).toBe('2026-10-26T05:00:00.000Z');
    // The fall-back day (2026-11-01 in Chicago) still starts at local midnight (CDT, UTC-5).
    expect(localDayStart('2026-11-01', 'America/Chicago').toISOString()).toBe('2026-11-01T05:00:00.000Z');
    expect(localDayStart('2026-11-02', 'America/Chicago').toISOString()).toBe('2026-11-02T06:00:00.000Z');
    expect(localDayStart('2026-10-26', 'Asia/Tokyo').toISOString()).toBe('2026-10-25T15:00:00.000Z');
  });

  it('turns a day key into a floating date at UTC midnight', () => {
    expect(dayKeyToFloatingDate('2026-10-26').toISOString()).toBe('2026-10-26T00:00:00.000Z');
  });

  it('reads a bare day as local midnight and a full instant as itself', () => {
    expect(instantFromDayOrIso('2026-10-26', 'America/Chicago')?.toISOString()).toBe('2026-10-26T05:00:00.000Z');
    expect(instantFromDayOrIso('2026-10-26T10:00:00Z', 'America/Chicago')?.toISOString()).toBe('2026-10-26T10:00:00.000Z');
    expect(instantFromDayOrIso('nope', 'UTC')).toBeNull();
  });
});
