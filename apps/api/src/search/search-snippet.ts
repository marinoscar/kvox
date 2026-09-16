// =============================================================================
// Snippet rendering: escape at the database boundary, mark afterwards
// (issue #175, epic #164)
// =============================================================================
//
// `ts_headline` DOES NOT ESCAPE ITS INPUT, AND IT IS NOT TRYING TO.
// -----------------------------------------------------------------------------
//
// It is a text-fragment selector, not a sanitiser: it copies the source text
// through verbatim and inserts `StartSel`/`StopSel` around the lexemes that
// matched. Its DEFAULT `StartSel`/`StopSel` are `<b>` and `</b>` - real HTML
// tags - which is exactly the thing that makes the obvious implementation
// wrong in a way that looks right. A transcript segment containing
// `<script>alert(1)</script>` comes back out of `ts_headline` as
// `<script>alert(1)</script>`, and a client that renders the result as HTML
// (which it must, to show the highlight) has just executed a stranger's
// script. The source text here is USER-SUPPLIED at both ends: a transcript is
// whatever a recording contained, a note body is whatever a model wrote from
// it, and a title is whatever anybody typed.
//
// So the order below is load-bearing and the three steps do not commute:
//
//   1. The database is told to mark hits with {@link SNIPPET_START} /
//      {@link SNIPPET_STOP} - two C0 control characters that are not HTML, not
//      markup of any kind, and cannot become markup no matter what escaping
//      runs over them.
//   2. TypeScript escapes the WHOLE string (`&`, `<`, `>`, `"`, `'`), so every
//      angle bracket that came out of the corpus is now `&lt;`/`&gt;` - text.
//   3. ONLY THEN are the sentinel pairs replaced with `<mark>`/`</mark>`, the
//      one piece of markup this application puts in that string and the one
//      piece it knows is balanced.
//
// Swap 2 and 3 and the escape eats the marks. Skip 1 and use `<mark>` as the
// `StartSel` directly and step 2 escapes the highlight along with the payload,
// producing visible `&lt;mark&gt;` and no highlight at all - which is the
// failure a developer "fixes" by dropping the escape, at which point the
// corpus is rendering live markup again.
//
// ⚠ POSTGRES'S TAG-STRIPPING IS NOT A SUBSTITUTE, AND MUST NOT BE MISTAKEN
// FOR ONE. The default text-search parser tokenises `<script>` as a `tag`
// token, and `ts_headline` does not re-emit tag tokens - so in practice a
// well-formed tag in the corpus is dropped before this file ever sees it, and
// an experiment with `<script>` at the database will suggest the escape below
// is dead code. It is not. That behaviour belongs to ONE parser configuration
// and covers ONE shape of hostile input: `&`, `"` and `'` pass through
// `ts_headline` VERBATIM (`test/integration/search.db.spec.ts` asserts exactly
// that against a real row), and any one of them is enough to break out of an
// attribute or corrupt an entity in a rendered snippet. The escape is the
// guarantee; the parser's behaviour is a coincidence this code does not
// depend on.
//
// THE SENTINELS ARE STRIPPED, NOT TRUSTED. Nothing stops a transcript from
// literally containing U+0001 (it is vanishingly unlikely, but "unlikely" is
// not "impossible" for text this application did not author). A stray,
// unpaired sentinel would otherwise emit an unbalanced `<mark>` and break the
// surrounding document's structure, so {@link renderHeadlineHtml} matches
// PAIRS non-greedily and deletes whatever is left over. The output therefore
// contains balanced `<mark>`/`</mark>` and no other markup, by construction
// rather than by the database having behaved.
// =============================================================================

/** Opening hit marker asked of `ts_headline`. U+0001, never markup. */
export const SNIPPET_START = '';

/** Closing hit marker asked of `ts_headline`. U+0002, never markup. */
export const SNIPPET_STOP = '';

/**
 * The `ts_headline` options string, bound as a parameter like every other
 * value this feature sends.
 *
 * The quoted-value form (`StartSel="..."`) is what lets a control character be
 * the delimiter at all - the options parser splits on commas and equals signs
 * and would otherwise have to guess where an unquoted value ended.
 *
 * `MaxFragments=1` picks the single best window rather than stitching several
 * together: a search result row shows one line of context, and a
 * multi-fragment headline reads as a mangled sentence in the space available.
 */
export const HEADLINE_OPTIONS =
  `StartSel="${SNIPPET_START}", StopSel="${SNIPPET_STOP}", ` +
  'MaxFragments=1, MaxWords=32, MinWords=12';

/** How many snippets one result carries. The contract says "at most 3". */
export const MAX_SNIPPETS_PER_RESULT = 3;

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Every character HTML gives a meaning to, turned into text.
 *
 * `&` FIRST is not a style choice - replacing it after `<` would re-escape the
 * ampersand this function had just written and turn `&lt;` into `&amp;lt;`.
 * A single pass over a character class avoids the ordering question entirely.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

/**
 * One `ts_headline` string as safe HTML: escaped first, marked second.
 *
 * See the file header for why that order is the whole point of this function
 * existing rather than the caller doing it inline.
 */
export function renderHeadlineHtml(raw: string): string {
  const escaped = escapeHtml(raw);

  const marked = escaped.replace(
    new RegExp(`${SNIPPET_START}([\\s\\S]*?)${SNIPPET_STOP}`, 'g'),
    (_match, inner: string) => `<mark>${inner}</mark>`,
  );

  // Whatever sentinel survived was unpaired, so it came from the corpus rather
  // than from `ts_headline`. Dropping it keeps the `<mark>` elements balanced.
  return marked.split(SNIPPET_START).join('').split(SNIPPET_STOP).join('');
}

/**
 * A literal, case-insensitive substring marked inside an otherwise escaped
 * string - the degraded (`ILIKE`) path's equivalent of `ts_headline`.
 *
 * There is no tsquery on that path, so there is nothing for the database to
 * highlight; the match is a plain substring and the highlight is computed
 * here. Matching is LITERAL, never a regular expression, for the same reason
 * `GET /api/transcripts/:id/search` matches literally: a regex engine fed
 * end-user input is a ReDoS surface and is the wrong tool for somebody typing
 * words into a search box.
 *
 * The length guard is not paranoia. `toLowerCase()` is not length-preserving
 * for every Unicode input (`'İ'.toLowerCase()` is two code units), and
 * every offset below is an index into the ORIGINAL string. When folding
 * changes a length, the offsets no longer line up and a slice could cut a
 * surrogate pair or straddle an escape - so the whole string is escaped with
 * no highlight rather than highlighted wrongly. A missing `<mark>` is a
 * cosmetic loss; a mis-sliced one is a broken document.
 */
export function markLiteral(text: string, needle: string): string {
  if (!needle) return escapeHtml(text);

  const haystack = text.toLowerCase();
  const target = needle.toLowerCase();

  if (haystack.length !== text.length || target.length !== needle.length) {
    return escapeHtml(text);
  }

  let out = '';
  let cursor = 0;

  for (;;) {
    const at = haystack.indexOf(target, cursor);

    if (at === -1) {
      out += escapeHtml(text.slice(cursor));
      break;
    }

    out += escapeHtml(text.slice(cursor, at));
    out += `<mark>${escapeHtml(text.slice(at, at + needle.length))}</mark>`;
    cursor = at + needle.length;
  }

  return out;
}
