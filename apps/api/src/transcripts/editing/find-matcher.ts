// =============================================================================
// Literal find & replace — never a regular expression (issue #27, spec §4.2)
// =============================================================================
//
// ⚠ THERE IS NO `new RegExp(userInput)` IN THIS FILE AND THERE MUST NEVER BE.
//
// Two independent reasons, both in spec §4.2:
//
//   1. A regex engine handed end-user input is a ReDoS surface. A hostile — or
//      merely unlucky — pattern pins a worker thread, and this endpoint is
//      reachable by anyone holding an `editor` share on any transcript.
//   2. It is simply the wrong tool for the user this feature exists for. The
//      person correcting a misheard company name across a two-hour meeting
//      typed a NAME. "Find and replace text", not "find and replace a pattern".
//
// The one regular expression that does appear below is a fixed, constant
// character class used to ask "is this code point a word character" for the
// whole-word option, which is a different thing entirely: it never sees user
// input, and it is applied to a single code point at a time.
//
// -----------------------------------------------------------------------------
// CASE-INSENSITIVE MATCHING WITHOUT LOSING THE OFFSETS
// -----------------------------------------------------------------------------
//
// The obvious implementation — `haystack.toLowerCase().indexOf(needle
// .toLowerCase())` — is wrong, and not in an academic way: `'İ'.toLowerCase()`
// is TWO code units, so lower-casing the whole string in one pass silently
// shifts every offset after it and the replacement lands in the wrong place.
// So the scan below compares CODE POINT BY CODE POINT against the original
// strings, folding each one individually and falling back to a raw comparison
// whenever a fold is not length-preserving. Offsets therefore always index the
// caller's own string.
//
// -----------------------------------------------------------------------------
// WHOLE-WORD BOUNDARIES ARE UNICODE-AWARE, NOT `\b`
// -----------------------------------------------------------------------------
//
// `\b` classifies exactly `[A-Za-z0-9_]` as word characters, so it cannot see
// `é` as a letter at all — which means a `\b`-based whole-word search for
// `"os"` matches inside `"José"`, because it believes the `é` is a boundary.
// Boundaries here are decided by `\p{L}\p{N}\p{M}_` with the `u` flag, read a
// full code point at a time so an astral letter is one character rather than
// two lone surrogates.
// =============================================================================

/** The options a caller may set on a search. */
export interface FindOptions {
  /** Distinguish `Kvox` from `kvox`. Default false. */
  matchCase?: boolean;
  /** Require a word boundary on both sides of the hit. Default false. */
  wholeWord?: boolean;
}

/** One hit, as offsets into the string that was searched. */
export interface FindMatch {
  /** Inclusive start offset, in UTF-16 code units. */
  start: number;
  /** Exclusive end offset, in UTF-16 code units. */
  end: number;
}

/** A word character for the purposes of `wholeWord`. One code point at a time. */
const WORD_CHARACTER = /[\p{L}\p{N}\p{M}_]/u;

/**
 * Is this code point (given as a whole code point string) a word character?
 *
 * `undefined` — the position before the start or after the end of the string —
 * is NOT a word character, which is what makes a hit at either end of the
 * string a whole-word hit.
 */
function isWordCharacter(codePoint: string | undefined): boolean {
  return codePoint !== undefined && WORD_CHARACTER.test(codePoint);
}

/** The whole code point ending at `index` (exclusive), surrogate pairs included. */
function codePointBefore(text: string, index: number): string | undefined {
  if (index <= 0) return undefined;

  const unit = text.charCodeAt(index - 1);

  if (unit >= 0xdc00 && unit <= 0xdfff && index >= 2) {
    const lead = text.charCodeAt(index - 2);

    if (lead >= 0xd800 && lead <= 0xdbff) return text.slice(index - 2, index);
  }

  return text[index - 1];
}

/** The whole code point starting at `index`, surrogate pairs included. */
function codePointAt(text: string, index: number): string | undefined {
  if (index >= text.length) return undefined;

  const point = text.codePointAt(index);

  return point === undefined ? undefined : String.fromCodePoint(point);
}

/**
 * Do these two single characters match under the requested case sensitivity?
 *
 * The length guard is the `İ` case from the header: when folding a character
 * changes its length, there is no offset-preserving answer, so the raw
 * comparison is used instead of a wrong one.
 */
function charactersMatch(a: string, b: string, matchCase: boolean): boolean {
  if (a === b) return true;
  if (matchCase) return false;

  const foldedA = a.toLowerCase();
  const foldedB = b.toLowerCase();

  if (foldedA.length !== 1 || foldedB.length !== 1) return false;

  return foldedA === foldedB;
}

/**
 * Every non-overlapping occurrence of `find` in `text`, left to right.
 *
 * An empty `find` matches nothing — a search that matched at every offset
 * would expand into one `segment.update_text` op per segment for a query the
 * user has not finished typing.
 */
export function findMatches(text: string, find: string, options: FindOptions = {}): FindMatch[] {
  if (find.length === 0 || text.length === 0) return [];

  const matchCase = options.matchCase ?? false;
  const wholeWord = options.wholeWord ?? false;
  const matches: FindMatch[] = [];

  const limit = text.length - find.length;

  for (let start = 0; start <= limit; ) {
    let hit = true;

    for (let offset = 0; offset < find.length; offset += 1) {
      if (!charactersMatch(text[start + offset], find[offset], matchCase)) {
        hit = false;
        break;
      }
    }

    if (hit && wholeWord) {
      const end = start + find.length;
      const leftInside = codePointAt(text, start);
      const rightInside = codePointBefore(text, end);

      // A boundary exists where a word character meets a non-word one. When
      // the needle itself starts or ends with punctuation, that side is
      // trivially a boundary — which is why both halves ask about the
      // characters on BOTH sides of the seam rather than assuming the needle
      // is a word.
      const leftOk =
        !isWordCharacter(leftInside) || !isWordCharacter(codePointBefore(text, start));
      const rightOk = !isWordCharacter(rightInside) || !isWordCharacter(codePointAt(text, end));

      if (!leftOk || !rightOk) hit = false;
    }

    if (hit) {
      matches.push({ start, end: start + find.length });
      start += find.length;
    } else {
      start += 1;
    }
  }

  return matches;
}

/**
 * `text` with every match of `find` replaced by `replace`, and how many there
 * were.
 *
 * Built on `findMatches` rather than on `String.replaceAll` so that the
 * whole-word and case rules are defined in exactly one place — and so that
 * `GET /:id/search` and the replacement can never disagree about what counts
 * as a hit.
 */
export function replaceMatches(
  text: string,
  find: string,
  replace: string,
  options: FindOptions = {},
): { text: string; count: number } {
  const matches = findMatches(text, find, options);

  if (matches.length === 0) return { text, count: 0 };

  let out = '';
  let cursor = 0;

  for (const match of matches) {
    out += text.slice(cursor, match.start) + replace;
    cursor = match.end;
  }

  out += text.slice(cursor);

  return { text: out, count: matches.length };
}

/**
 * A short excerpt around a match, for the search result list.
 *
 * Ellipses are added only where text was actually cut, so a short segment
 * renders as itself rather than as a truncated-looking fragment.
 */
export function matchPreview(text: string, match: FindMatch, radius = 40): string {
  const from = Math.max(0, match.start - radius);
  const to = Math.min(text.length, match.end + radius);

  return `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`;
}
