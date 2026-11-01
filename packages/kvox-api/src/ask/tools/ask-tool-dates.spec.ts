import { isoDate, localInstantDate } from './ask-tool.js';

describe('Ask tool dates', () => {
  const instant = '2026-10-27T02:30:00.000Z';

  it('isoDate keeps a calendar value on its stored UTC day', () => {
    expect(isoDate(new Date('2026-10-27T00:00:00.000Z'))).toBe('2026-10-27');
    expect(isoDate(null)).toBeNull();
    expect(isoDate('not a date')).toBeNull();
  });

  it("localInstantDate cuts an instant in the asker's zone", () => {
    expect(localInstantDate(instant, 'America/Chicago')).toBe('2026-10-26');
    expect(localInstantDate(new Date(instant), 'Asia/Tokyo')).toBe('2026-10-27');
    expect(localInstantDate(instant, undefined)).toBe('2026-10-27');
    expect(localInstantDate(instant, 'Not/AZone')).toBe('2026-10-27');
    expect(localInstantDate(null, 'Asia/Tokyo')).toBeNull();
    expect(localInstantDate('nope', 'Asia/Tokyo')).toBeNull();
  });
});
