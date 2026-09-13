import { describe, expect, it } from 'vitest';

import { NARROW_COLUMNS, TINY_COLUMNS } from './layout.js';

// =============================================================================
// The narrow-terminal degrade thresholds  (issue #145, epic #110)
// =============================================================================
//
// `useTerminalSize` itself is a hook — it needs `useStdout`'s ink render
// context — so it cannot be exercised without mounting a component, which
// this package does not have ink-testing-library installed to do (see the
// test plan's note). What IS pure and exported is the pair of breakpoints
// that decide the three layout tiers (`Frame`'s header comment: full /
// narrow / tiny), and those are worth pinning: `narrow = columns <
// NARROW_COLUMNS`, `tiny = columns < TINY_COLUMNS`, so TINY_COLUMNS must stay
// strictly smaller than NARROW_COLUMNS or the "tiny" tier would never be
// reachable — a terminal narrow enough to be tiny would already have
// satisfied the (wider) narrow check and never fall through further.
// =============================================================================

describe('layout breakpoints', () => {
  it('TINY_COLUMNS is strictly less than NARROW_COLUMNS', () => {
    // If this regressed to >=, `tiny` would be unreachable: every width that
    // makes `columns < TINY_COLUMNS` true would already have been narrower
    // than NARROW_COLUMNS, but Frame checks `tiny` first and returns early —
    // the bug this pins is the ORDER assumption breaking, not the value.
    expect(TINY_COLUMNS).toBeLessThan(NARROW_COLUMNS);
  });

  it('both breakpoints are positive integers', () => {
    for (const value of [NARROW_COLUMNS, TINY_COLUMNS]) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });

  it('pins the documented values so a silent tuning change is visible in review', () => {
    expect(NARROW_COLUMNS).toBe(56);
    expect(TINY_COLUMNS).toBe(30);
  });
});
