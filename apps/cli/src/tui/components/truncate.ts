// =============================================================================
// Width-bounded text  (issue #129, epic #118)
// =============================================================================
//
// The components in this directory take a `width` and never assume a minimum
// (issue #129: "all components accept width from useTerminalSize and never
// assume a minimum"). Truncation is done HERE, on the string, rather than
// left to ink's `wrap="truncate-end"`, so the derived rows a test asserts are
// the rows the terminal shows — and so a row's remedy line, its note and its
// value all agree on where the edge is.
//
// Widths are measured in code units. That is exact for the ASCII this CLI
// produces (keys, hostnames, paths, commands) and one column off per
// double-width character otherwise, which at worst leaves a glyph hanging
// off the right edge of a row that was already too long to read whole.
// =============================================================================

export const ELLIPSIS = '…';

/**
 * `text` cut to at most `width` columns, ending in an ellipsis when cut.
 *
 * A width of 0 or less yields the empty string rather than a lone ellipsis:
 * a component asked to draw in no space should draw nothing, not a mark
 * that reads as "something was here".
 */
export function truncateEnd(text: string, width: number): string {
  const limit = Math.max(0, Math.trunc(width));
  if (limit === 0) return '';
  if (text.length <= limit) return text;
  if (limit === 1) return ELLIPSIS;
  return `${text.slice(0, limit - 1)}${ELLIPSIS}`;
}
