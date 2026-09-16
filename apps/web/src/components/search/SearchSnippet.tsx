/**
 * One line of "why this matched" — issue #176, epic #164.
 *
 * =============================================================================
 * THE SERVER ESCAPES IT. THIS COMPONENT PARSES IT ANYWAY.
 * =============================================================================
 *
 * `snippet.html` arrives from `GET /api/search` already HTML-escaped, with
 * `<mark>` and `</mark>` as the ONLY tags in it — `apps/api/src/search/
 * search-snippet.ts` builds it in an order chosen precisely so that every angle
 * bracket the corpus contained is `&lt;`/`&gt;` text before the one piece of
 * markup this application authors goes in, and the API's own spec asserts that
 * `html.match(/<[^>]+>/g)` is exactly `['<mark>', '</mark>']`.
 *
 * The obvious thing to do with such a string is
 * `dangerouslySetInnerHTML={{ __html: snippet.html }}`, and this component
 * exists to not do that.
 *
 * The reason is not distrust of that code as written; it is that the guarantee
 * lives in a DIFFERENT PROCESS, behind a `ts_headline` call whose default
 * `StartSel` is a literal `<b>`, on text that is user-supplied at both ends (a
 * transcript is whatever a recording contained, a note body is whatever a model
 * wrote from it, a title is whatever anybody typed). A future change to the
 * headline options, to the escape's ordering, or to the text-search
 * configuration is one edit in one file away from putting a raw tag in this
 * string — and with `dangerouslySetInnerHTML` the consequence of that edit is
 * a stranger's markup executing in every viewer's browser, discovered by
 * nobody, because the snippet still LOOKS fine for every input anyone tests by
 * hand.
 *
 * So the string is PARSED here instead:
 *
 *   1. Split on the `<mark>`/`</mark>` pair and nothing else.
 *   2. Undo the five entity references the server's `escapeHtml` produces
 *      (`&amp;` `&lt;` `&gt;` `&quot;` `&#39;`), in a single pass so a literal
 *      `&amp;lt;` in the corpus decodes to the text `&lt;` rather than to `<`.
 *   3. Render alternating plain strings and real `<mark>` ELEMENTS.
 *
 * React escapes every string it renders as a child, so the failure mode of the
 * server bug above becomes "the user sees `<script>` written out as text in
 * their search result" instead of "the user's browser runs it". That is the
 * whole point: one layer's mistake should be visible and harmless rather than
 * invisible and fatal. `SearchSnippet.test.tsx` pins exactly that case.
 *
 * ⚠ A stray `<mark>` with no partner, or a `</mark>` with no opener, cannot
 * corrupt the surrounding document here the way it could through innerHTML —
 * the parse tracks a boolean, and each rendered `<mark>` is an element React
 * closes for itself.
 */

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { Fragment } from 'react';

import type { SearchSnippet as SearchSnippetData } from '../../services/search';
import { formatTimestamp } from '../../utils/playbackIntervals';

/** A run of snippet text, and whether it was a hit. */
export interface SnippetPart {
  text: string;
  marked: boolean;
}

/**
 * The five entity references `escapeHtml` in `apps/api/src/search/
 * search-snippet.ts` produces, and nothing else.
 *
 * Deliberately NOT a general HTML entity decoder. The server escapes exactly
 * these five characters, so decoding a wider set here would be this client
 * inventing meaning for sequences the server never wrote — turning a `&copy;`
 * that a user literally typed into a `©` they did not.
 */
const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

/**
 * Undo the server's escape.
 *
 * ONE PASS over an alternation, not five sequential `replace` calls. Decoding
 * `&amp;` first and `&lt;` second would turn the corpus text `&amp;lt;` — which
 * the user typed and which must render as the four characters `&lt;` — into a
 * literal `<`, re-manufacturing the angle bracket the escape existed to remove.
 * A single pass consumes each entity once and never revisits its output, which
 * makes the ordering question disappear rather than answering it.
 */
export function unescapeSnippetText(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity);
}

/**
 * Turn the server's `html` into runs of text, flagged by whether they matched.
 *
 * Exported for its own test: this is the security-relevant half of the
 * component and it is worth asserting directly, not only through the DOM.
 */
export function parseSnippetHtml(html: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let marked = false;

  // The capturing group keeps the delimiters in `split`'s output, so the walk
  // below sees the tags rather than having to infer them from their absence.
  for (const token of html.split(/(<mark>|<\/mark>)/)) {
    if (token === '<mark>') {
      marked = true;
      continue;
    }
    if (token === '</mark>') {
      marked = false;
      continue;
    }
    if (token === '') continue;
    parts.push({ text: unescapeSnippetText(token), marked });
  }

  return parts;
}

export interface SearchSnippetProps {
  snippet: SearchSnippetData;
}

/**
 * The rendered snippet: an optional timestamp, then the marked-up line.
 *
 * The timestamp is TEXT, not a link. `startMs` says when in the recording the
 * line was said, and this app has no route that opens a transcript at a
 * position — a link that dropped the reader at 0:00 of a three-hour recording
 * would be worse than the plain number it replaced.
 */
export function SearchSnippet({ snippet }: SearchSnippetProps) {
  const parts = parseSnippetHtml(snippet.html);

  return (
    <Typography variant="body2" color="text.secondary" component="p" sx={{ mt: 0.5 }}>
      {snippet.startMs !== null && (
        <Box
          component="span"
          sx={{ mr: 1, fontVariantNumeric: 'tabular-nums', color: 'text.disabled' }}
        >
          {formatTimestamp(snippet.startMs)}
        </Box>
      )}
      {parts.map((part, index) =>
        part.marked ? (
          <Box
            component="mark"
            key={index}
            sx={{
              // The same tint the transcript viewer's find-in-page uses for a
              // non-active match, and for the same reason: the browser default
              // (`background: yellow; color: black`) is a fixed pair that is
              // unreadable against this app's dark palette, and `color:
              // inherit` keeps the text itself the theme's.
              backgroundColor: 'action.selected',
              color: 'inherit',
              borderRadius: 0.5,
            }}
          >
            {part.text}
          </Box>
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
        ),
      )}
    </Typography>
  );
}

export default SearchSnippet;
