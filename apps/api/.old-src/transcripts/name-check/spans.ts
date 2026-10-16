// =============================================================================
// Where a stored suggestion applies NOW (issue #328, epic #326)
// =============================================================================
//
// A suggestion's `start`/`end` were computed against the segment text at
// `segmentRev`. By the time the user reviews or accepts it, somebody may have
// corrected an unrelated typo earlier in the same line, shifting every offset
// after it. Refusing every such suggestion as stale would punish ordinary
// editing; applying at the stored offset regardless would rewrite the wrong
// characters. The middle path, and the only one here:
//
//   1. the stored offsets still read `original` → use them;
//   2. otherwise `original` occurs EXACTLY ONCE in the current text as a whole
//      word (case-sensitive, Unicode-aware boundaries — the same matcher find &
//      replace uses) → use that occurrence;
//   3. otherwise → stale. Two occurrences are ambiguous, zero means the text
//      the suggestion was about is gone, and guessing either way would be a
//      silent wrong edit.
//
// PURE — `../editing/find-matcher.ts` is the only import.
// =============================================================================

import { findMatches, type FindMatch } from '../editing/find-matcher';

export interface StoredSpan {
  start: number;
  end: number;
  original: string;
}

/** The span to apply at in `currentText`, or `null` when the suggestion is stale. */
export function resolveSpan(currentText: string, span: StoredSpan): FindMatch | null {
  if (
    span.start >= 0 &&
    span.end <= currentText.length &&
    span.start < span.end &&
    currentText.slice(span.start, span.end) === span.original
  ) {
    return { start: span.start, end: span.end };
  }
  const matches = findMatches(currentText, span.original, { matchCase: true, wholeWord: true });
  return matches.length === 1 ? matches[0]! : null;
}

export interface Splice {
  id: string;
  start: number;
  end: number;
  replacement: string;
}

/**
 * Apply `splices` to `text` right to left. Splices overlapping one already
 * applied are skipped and reported, never merged — two suggestions claiming
 * the same characters cannot both be right.
 */
export function applySplices(
  text: string,
  splices: readonly Splice[],
): { text: string; applied: string[]; skipped: string[] } {
  const ordered = [...splices].sort((a, b) => b.start - a.start || b.end - a.end);
  const applied: string[] = [];
  const skipped: string[] = [];
  let out = text;
  let floor = Number.POSITIVE_INFINITY;
  for (const s of ordered) {
    if (s.end > floor) {
      skipped.push(s.id);
      continue;
    }
    out = out.slice(0, s.start) + s.replacement + out.slice(s.end);
    floor = s.start;
    applied.push(s.id);
  }
  return { text: out, applied, skipped };
}
