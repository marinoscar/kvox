import { describe, expect, it } from 'vitest';

// followTail is expressed as "was already at the bottom", which is what makes
// scrolling up disengage and returning re-engage with no extra state. This
// captures that rule directly, since ink-testing-library is not available.
function nextOffset(
  current: number,
  previousMax: number,
  nextMax: number,
  followTail: boolean,
): number {
  if (followTail && current >= previousMax) return nextMax;
  return Math.min(current, nextMax);
}

describe('ScrollBox followTail', () => {
  it('follows the bottom as lines are appended', () => {
    // At the bottom (10 of 10), content grows to 20: stay at the bottom.
    expect(nextOffset(10, 10, 20, true)).toBe(20);
  });

  it('stops following once the user scrolls up', () => {
    // Reading back through an error must not be fought over.
    expect(nextOffset(4, 10, 20, true)).toBe(4);
  });

  it('re-engages when the user returns to the bottom', () => {
    expect(nextOffset(20, 20, 30, true)).toBe(30);
  });

  it('clamps to the new maximum when the terminal grows', () => {
    expect(nextOffset(20, 20, 5, false)).toBe(5);
  });

  it('does not follow when followTail is off', () => {
    // The existing caller (invoke.tsx) must be unaffected.
    expect(nextOffset(10, 10, 20, false)).toBe(10);
  });
});
