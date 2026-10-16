// =============================================================================
// Word timings that survive an edit (issue #27, epic #19, spec §3.5)
// =============================================================================
//
// A segment's `words[]` is the only thing that lets a player highlight the word
// being spoken. Every correction a user makes would destroy it under the naive
// implementation — "the text changed, throw the timings away" — and the feature
// that made the transcript trustworthy would be the feature that made it
// unplayable.
//
// So an edit RE-ALIGNS rather than discards:
//
//   • a token-level LONGEST COMMON SUBSEQUENCE between the segment's old word
//     list and the new text, tokenized the same way;
//   • every token the LCS matched keeps its original `{s, e, c}` untouched;
//   • a token with no match takes the timing of the old token it replaced when
//     there is one (a substitution — "wrld" becomes "world", and "world" is
//     spoken exactly when "wrld" was), and is otherwise INTERPOLATED between
//     the nearest matched neighbours;
//   • `words_alignment` becomes `interpolated`, which is what tells a client
//     that some of these numbers are reconstructed rather than measured.
//
// The last resort is `none`: nothing matched at all (a full retype), and the
// timings are spread evenly across the segment's span purely so a player has
// SOME array to walk rather than crashing on a missing one.
//
// -----------------------------------------------------------------------------
// SPLIT AND JOIN INVENT NOTHING, SO THEY STAY `exact`
// -----------------------------------------------------------------------------
//
// `segment.split` divides the array at the split point and `segment.join`
// concatenates two arrays in order. Neither one produces a timing that was not
// already there, which is exactly what `exact` means (spec §3.5) — so both
// halves of a split and the result of a join inherit the alignment they came
// from rather than being downgraded.
//
// -----------------------------------------------------------------------------
// THE LCS IS BOUNDED, BECAUSE IT IS QUADRATIC
// -----------------------------------------------------------------------------
//
// The dynamic program is O(old × new) in both time and memory. Ordinary
// segments are a dozen tokens; a provider that emitted one segment for a
// forty-minute monologue is not ordinary but is entirely possible. Past
// `LCS_CELL_BUDGET` cells the alignment gives up honestly and answers `none`
// with evenly spread timings, rather than spending a worker for a second and a
// half on a better guess nobody asked for.
// =============================================================================

import type { TimedWord, WordsAlignmentValue } from './editing-state';

/** The largest DP table this alignment will build. See the header. */
export const LCS_CELL_BUDGET = 250_000;

/**
 * Split text into the tokens a word timing corresponds to.
 *
 * Whitespace only — punctuation stays attached, because the provider's own
 * word list attaches it too ("world," is one word with one timing), and a
 * tokenizer that disagreed with the provider's would fail to match tokens that
 * did not change.
 */
export function tokenize(text: string): string[] {
  const trimmed = text.trim();

  return trimmed.length === 0 ? [] : trimmed.split(/\s+/);
}

/**
 * The form two tokens are compared in.
 *
 * Case and edge punctuation are folded away so that capitalising a word, or
 * adding the comma a provider omitted, still counts as "the same word" and
 * keeps its measured timing. The token's own text is never replaced by this —
 * it is a comparison key only.
 */
export function foldToken(token: string): string {
  return token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase();
}

/**
 * Matched `[oldIndex, newIndex]` pairs, in order, of a longest common
 * subsequence.
 *
 * Returns `null` when the table would exceed `LCS_CELL_BUDGET` — see the
 * header for why that is an honest answer rather than a failure.
 */
export function lcsPairs(oldTokens: string[], newTokens: string[]): Array<[number, number]> | null {
  const rows = oldTokens.length;
  const cols = newTokens.length;

  if (rows === 0 || cols === 0) return [];
  if (rows * cols > LCS_CELL_BUDGET) return null;

  const a = oldTokens.map(foldToken);
  const b = newTokens.map(foldToken);

  // (rows + 1) × (cols + 1), flattened — one allocation instead of `rows + 1`.
  const table = new Uint32Array((rows + 1) * (cols + 1));
  const width = cols + 1;

  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + (j + 1)] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
    }
  }

  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;

  while (i < rows && j < cols) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
      i += 1;
    } else {
      j += 1;
    }
  }

  return pairs;
}

/** Timings spread evenly across a span — the `none` alignment's last resort. */
export function spreadEvenly(tokens: string[], startMs: number, endMs: number): TimedWord[] {
  if (tokens.length === 0) return [];

  const span = Math.max(0, endMs - startMs);
  const step = span / tokens.length;

  return tokens.map((token, index) => ({
    t: token,
    s: Math.round(startMs + step * index),
    e: Math.round(startMs + step * (index + 1)),
    c: null,
  }));
}

/** What a re-alignment produced. */
export interface AlignmentResult {
  words: TimedWord[];
  alignment: WordsAlignmentValue;
}

/**
 * Re-align a segment's word timings onto new text.
 *
 * `previousAlignment` is carried through unchanged when the tokens did not
 * actually move — re-saving a segment whose text is byte-identical must not
 * silently downgrade an `exact` segment to `interpolated`.
 */
export function realignWords(input: {
  oldWords: TimedWord[];
  newText: string;
  startMs: number;
  endMs: number;
  previousAlignment: WordsAlignmentValue;
}): AlignmentResult {
  const { oldWords, newText, startMs, endMs, previousAlignment } = input;
  const newTokens = tokenize(newText);

  if (newTokens.length === 0) return { words: [], alignment: 'none' };

  // Nothing to align against: the provider emitted no word timings for this
  // segment at all (spec §2.2 allows it), so there is no measurement to keep.
  if (oldWords.length === 0) {
    return { words: spreadEvenly(newTokens, startMs, endMs), alignment: 'none' };
  }

  const pairs = lcsPairs(
    oldWords.map((word) => word.t),
    newTokens,
  );

  if (pairs === null || pairs.length === 0) {
    return { words: spreadEvenly(newTokens, startMs, endMs), alignment: 'none' };
  }

  const matchedNew = new Map<number, number>(pairs.map(([oldIndex, newIndex]) => [newIndex, oldIndex]));
  const out: TimedWord[] = new Array<TimedWord>(newTokens.length);

  // Walk the gaps BETWEEN consecutive matched pairs. Each gap has a run of
  // unmatched old words (what was removed) and a run of unmatched new tokens
  // (what was typed), bounded by two anchors whose timings are known.
  let previousOld = -1;
  let previousNew = -1;

  const fillGap = (oldFrom: number, oldTo: number, newFrom: number, newTo: number): void => {
    const oldRun = oldWords.slice(oldFrom, oldTo);
    const lo = oldFrom > 0 ? oldWords[oldFrom - 1].e : startMs;
    const hi = oldTo < oldWords.length ? oldWords[oldTo].s : endMs;

    let cursor = lo;

    for (let index = newFrom; index < newTo; index += 1) {
      const position = index - newFrom;
      const replaced = oldRun[position];

      if (replaced) {
        // A substitution: the new token is spoken exactly when the old one was.
        // Confidence is dropped — the provider measured a DIFFERENT word.
        out[index] = { t: newTokens[index], s: replaced.s, e: replaced.e, c: null };
        cursor = replaced.e;
        continue;
      }

      // A pure insertion past the end of what was replaced: share what is left
      // of the gap evenly among the tokens that still need a timing.
      const remaining = newTo - index;
      const step = Math.max(0, hi - cursor) / remaining;

      out[index] = {
        t: newTokens[index],
        s: Math.round(cursor),
        e: Math.round(cursor + step),
        c: null,
      };
      cursor += step;
    }
  };

  for (const [oldIndex, newIndex] of pairs) {
    fillGap(previousOld + 1, oldIndex, previousNew + 1, newIndex);

    const kept = oldWords[oldIndex];

    // Matched: the provider's own measurement, untouched, confidence included.
    out[newIndex] = { t: newTokens[newIndex], s: kept.s, e: kept.e, c: kept.c };

    previousOld = oldIndex;
    previousNew = newIndex;
  }

  fillGap(previousOld + 1, oldWords.length, previousNew + 1, newTokens.length);

  const unchanged = pairs.length === oldWords.length && pairs.length === newTokens.length;

  return { words: out, alignment: unchanged ? previousAlignment : 'interpolated' };
}

/**
 * Divide a word array at a token index, without inventing a timing.
 *
 * `tokenCount` is the number of TEXT tokens the split index refers to. It is
 * normally equal to `words.length`, and the index is used directly. It is not
 * equal after an edit that added or removed words while the alignment was
 * already approximate, and the index is then scaled proportionally — the
 * honest answer for an array that no longer lines up token-for-token with the
 * text it belongs to.
 */
export function splitWords(
  words: TimedWord[],
  atTokenIndex: number,
  tokenCount: number,
): [TimedWord[], TimedWord[]] {
  if (words.length === 0) return [[], []];

  const index =
    tokenCount === words.length
      ? atTokenIndex
      : Math.round((atTokenIndex / Math.max(1, tokenCount)) * words.length);

  const clamped = Math.min(Math.max(index, 0), words.length);

  return [words.slice(0, clamped), words.slice(clamped)];
}

/** Lay two word arrays end to end. Nothing is invented, so nothing degrades. */
export function joinWords(first: TimedWord[], second: TimedWord[]): TimedWord[] {
  return [...first, ...second];
}

/** The worse of two alignments — `exact` < `interpolated` < `none`. */
export function worstAlignment(
  a: WordsAlignmentValue,
  b: WordsAlignmentValue,
): WordsAlignmentValue {
  const rank: Record<WordsAlignmentValue, number> = { exact: 0, interpolated: 1, none: 2 };

  return rank[a] >= rank[b] ? a : b;
}

/**
 * The character offset each token starts at, plus a final entry at the end of
 * the string.
 *
 * There are `tokens.length + 1` split BOUNDARIES in a segment — before every
 * token, and after the last one — and this returns the character offset of each
 * of them in order, which is what turns a caret position into a word index.
 */
export function tokenBoundaries(text: string): number[] {
  const boundaries: number[] = [];
  const pattern = /\S+/gu;
  let match = pattern.exec(text);

  while (match !== null) {
    boundaries.push(match.index);
    match = pattern.exec(text);
  }

  boundaries.push(text.length);

  return boundaries;
}

/**
 * The word index a character offset splits at, resolved to the NEAREST word
 * boundary (spec §3.5).
 *
 * A caret sits between characters, not between words, so a client that reports
 * one has to be snapped somewhere — and snapping to the nearest boundary is the
 * only rule that behaves the way a user expects when they click in the middle
 * of a word: the split lands on whichever side of that word they were closer
 * to, rather than always before it or always after it.
 */
export function wordIndexAtCharOffset(text: string, charOffset: number): number {
  const boundaries = tokenBoundaries(text);

  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < boundaries.length; index += 1) {
    const distance = Math.abs(boundaries[index] - charOffset);

    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }

  return best;
}
