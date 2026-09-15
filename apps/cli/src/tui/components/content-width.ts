import { NARROW_COLUMNS, useTerminalSize } from '../layout.js';

// =============================================================================
// How many columns a component inside `Frame` can actually draw in
// =============================================================================
//
// `Frame` (tui/layout.tsx) draws a rounded border and two columns of padding
// on each side at the full tier, and nothing at all at the narrow and tiny
// tiers. A component that truncates its rows to `stdout.columns` therefore
// overflows the frame by six columns at exactly the width where the frame is
// drawn — which yoga answers by wrapping the row and pushing the border's
// right edge onto the next line. The chrome cost is declared once here so
// every component in this directory subtracts the same number.
// =============================================================================

/** Border (1 + 1) plus `paddingX={2}` (2 + 2) — see `Frame`. */
export const FRAME_CHROME_COLUMNS = 6;

/** Columns available to content at this terminal width. Never below 1. */
export function contentWidth(columns: number): number {
  const usable = columns < NARROW_COLUMNS ? columns : columns - FRAME_CHROME_COLUMNS;
  return Math.max(1, usable);
}

/** `contentWidth` of the live terminal, updated on resize. */
export function useContentWidth(): number {
  const { columns } = useTerminalSize();
  return contentWidth(columns);
}
