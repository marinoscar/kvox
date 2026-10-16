// =============================================================================
// A markdown block/inline parser for the note renderers (issue #54, spec §8.3)
// =============================================================================
//
// `docs/specs/notes.md` §8.3's second difference from transcript export: a
// note's body IS markdown (§4.5 — its native storage format), so the PDF and
// DOCX renderers have to INTERPRET syntax somebody else wrote, which
// `apps/api/src/transcripts/export/` has never had to do. Its PDF and Markdown
// renderers build their layout directly from segments and speakers; there is no
// user-authored markup anywhere in that path.
//
// -----------------------------------------------------------------------------
// ⚠ HAND-WRITTEN, AND THAT IS A DELIBERATE DEPARTURE FROM THE SPEC'S WORDING
// -----------------------------------------------------------------------------
//
// §8.3 says "wrapping a small, audited parsing library". Every markdown parser
// at a currently-maintained major — `marked` 18, `markdown-it` 15, the whole
// `remark`/`micromark` family — publishes **ESM only**: `"type": "module"` with
// no `require` condition. This API is compiled and executed as CommonJS
// (`tsconfig`'s `module: commonjs`, ts-jest under a CJS Jest), so `require`ing
// one throws `ERR_REQUIRE_ESM` at boot rather than at test time. The two ways
// out are worse than this file:
//
//   * pin an abandoned major (`marked` 4, last published years ago) purely for
//     its CJS build, which is a dependency nobody will ever upgrade; or
//   * convert this API to ESM, which is a change to every file in `apps/api`
//     for the benefit of one renderer.
//
// So: a parser over exactly the subset §8.3 names — **headings, lists,
// emphasis, code** — plus blockquotes and thematic breaks, with everything it
// does not recognise passed through as literal text rather than dropped. A
// parser cannot silently lose a line here; the worst it does is render a table
// row as the paragraph it literally is.
//
// -----------------------------------------------------------------------------
// THE AST IS THE RENDERERS' ONLY INPUT, WHICH IS WHY IT IS PURE
// -----------------------------------------------------------------------------
//
// Same discipline `export-document.ts` states for transcripts: the PDF and the
// DOCX are rendered from ONE parse of ONE body, so the two **cannot disagree
// about what the note says** — only about how they format it. A renderer that
// re-scanned the raw markdown for something the AST did not carry would be a
// renderer able to answer a question the other one never asked.
// =============================================================================

/** One run of text with its marks. `href` set means it is a link. */
export interface MdSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  href?: string;
}

export type MdBlock =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; spans: MdSpan[] }
  | { type: 'paragraph'; spans: MdSpan[] }
  | { type: 'list'; ordered: boolean; start: number; items: MdBlock[][] }
  | { type: 'quote'; blocks: MdBlock[] }
  | { type: 'code'; language: string | null; text: string }
  | { type: 'rule' };

/** How far a heading may go. Seven `#` is a paragraph, per CommonMark. */
const MAX_HEADING = 6;

/** Guard against a pathologically nested document eating the stack. */
const MAX_DEPTH = 12;

/**
 * Parse a markdown document into blocks.
 *
 * Total: every input produces a (possibly empty) block list and nothing throws.
 * A renderer being handed a half-written note mid-stream is an ordinary case —
 * `note.generate` appends deltas — so "unterminated fence" and "list marker
 * with nothing after it" are shapes this must survive, not error on.
 */
export function parseMarkdown(source: string, depth = 0): MdBlock[] {
  const lines = source
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '    ')
    .split('\n');

  const blocks: MdBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    const fence = matchFence(line);

    if (fence) {
      const body: string[] = [];

      index += 1;

      while (index < lines.length && !closesFence(lines[index] ?? '', fence.marker)) {
        body.push(lines[index] ?? '');
        index += 1;
      }

      // An UNTERMINATED fence consumes the rest of the document, which is what
      // every markdown implementation does and what a half-streamed note needs.
      if (index < lines.length) index += 1;

      blocks.push({ type: 'code', language: fence.language, text: body.join('\n') });
      continue;
    }

    if (isRule(line)) {
      blocks.push({ type: 'rule' });
      index += 1;
      continue;
    }

    const heading = /^ {0,3}(#{1,7})\s+(.*)$/.exec(line);

    if (heading && heading[1] && heading[1].length <= MAX_HEADING) {
      blocks.push({
        type: 'heading',
        level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        // A trailing `###` run is closing punctuation, not content.
        spans: parseInline((heading[2] ?? '').replace(/\s+#+\s*$/, '').trim()),
      });
      index += 1;
      continue;
    }

    if (/^ {0,3}>/.test(line)) {
      const quoted: string[] = [];

      while (index < lines.length && /^ {0,3}>/.test(lines[index] ?? '')) {
        quoted.push((lines[index] ?? '').replace(/^ {0,3}> ?/, ''));
        index += 1;
      }

      blocks.push({ type: 'quote', blocks: descend(quoted.join('\n'), depth) });
      continue;
    }

    const marker = matchListMarker(line);

    if (marker) {
      const list: { type: 'list'; ordered: boolean; start: number; items: MdBlock[][] } = {
        type: 'list',
        ordered: marker.ordered,
        start: marker.start,
        items: [],
      };

      while (index < lines.length) {
        const current = lines[index] ?? '';
        const next = matchListMarker(current);

        // A different marker family starts a NEW list rather than continuing
        // this one — `- a` followed by `1. b` is two lists, not one with a
        // surprise numbering change halfway down.
        if (!next || next.ordered !== marker.ordered) break;

        const item: string[] = [current.slice(next.width)];

        index += 1;

        // Continuation lines: indented under the marker, or a lazy paragraph
        // line that starts no block of its own.
        while (index < lines.length) {
          const candidate = lines[index] ?? '';

          if (candidate.trim() === '') {
            const following = lines[index + 1] ?? '';

            if (indentOf(following) >= next.width && following.trim() !== '') {
              item.push('');
              index += 1;
              continue;
            }

            break;
          }

          if (indentOf(candidate) >= next.width) {
            item.push(candidate.slice(next.width));
            index += 1;
            continue;
          }

          if (matchListMarker(candidate) || isRule(candidate) || /^ {0,3}(#|>)/.test(candidate)) {
            break;
          }

          item.push(candidate.trim());
          index += 1;
        }

        list.items.push(descend(item.join('\n'), depth));
      }

      // A marker with nothing parseable under it would otherwise produce an
      // empty list the renderers draw as a stray bullet.
      if (list.items.length > 0) blocks.push(list);
      continue;
    }

    const paragraph: string[] = [];

    while (index < lines.length) {
      const candidate = lines[index] ?? '';

      if (
        candidate.trim() === '' ||
        matchFence(candidate) ||
        isRule(candidate) ||
        matchListMarker(candidate) ||
        /^ {0,3}(#{1,6}\s|>)/.test(candidate)
      ) {
        break;
      }

      paragraph.push(candidate.trim());
      index += 1;
    }

    if (paragraph.length > 0) {
      blocks.push({ type: 'paragraph', spans: parseInline(paragraph.join(' ')) });
    }
  }

  return blocks;
}

/** Recurse, unless the document is nested deeply enough to be an attack. */
function descend(source: string, depth: number): MdBlock[] {
  if (depth >= MAX_DEPTH) return [{ type: 'paragraph', spans: parseInline(source.trim()) }];

  return parseMarkdown(source, depth + 1);
}

/**
 * Parse one line of inline markdown into spans.
 *
 * ⚠ CODE WINS OVER EVERYTHING, which is the one precedence rule worth stating:
 * a backtick span's contents are literal, so `` `**not bold**` `` renders its
 * asterisks. Scanning for emphasis first would eat them.
 */
export function parseInline(text: string): MdSpan[] {
  const spans: MdSpan[] = [];
  let buffer = '';
  let index = 0;

  const flush = (): void => {
    if (buffer.length > 0) {
      spans.push({ text: buffer });
      buffer = '';
    }
  };

  while (index < text.length) {
    const rest = text.slice(index);

    // A backslash escape is the one thing that outranks even code.
    if (rest.startsWith('\\') && rest.length > 1) {
      buffer += rest[1];
      index += 2;
      continue;
    }

    const code = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/.exec(rest);

    if (code) {
      flush();
      spans.push({ text: (code[2] ?? '').trim(), code: true });
      index += code[0].length;
      continue;
    }

    const link = /^\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/.exec(rest);

    if (link) {
      flush();

      const label = link[1] ?? '';
      const href = link[2] ?? '';

      for (const span of parseInline(label)) {
        spans.push({ ...span, href });
      }

      index += link[0].length;
      continue;
    }

    const marked = matchEmphasis(rest);

    if (marked) {
      flush();

      for (const span of parseInline(marked.inner)) {
        spans.push({ ...span, ...marked.mark });
      }

      index += marked.length;
      continue;
    }

    buffer += rest[0];
    index += 1;
  }

  flush();

  return spans.filter((span) => span.text.length > 0 || span.code === true);
}

/** Plain text of a span list. What the provenance assertions read. */
export function spansText(spans: readonly MdSpan[]): string {
  return spans.map((span) => span.text).join('');
}

/** Strongest marker first, so `***x***` is not read as `*` around `**x**`. */
const EMPHASIS: { open: string; mark: Partial<MdSpan> }[] = [
  { open: '***', mark: { bold: true, italic: true } },
  { open: '___', mark: { bold: true, italic: true } },
  { open: '~~', mark: { strike: true } },
  { open: '**', mark: { bold: true } },
  { open: '__', mark: { bold: true } },
  { open: '*', mark: { italic: true } },
  { open: '_', mark: { italic: true } },
];

/**
 * The emphasis run starting at `rest`, if there is one.
 *
 * ⚠ BOTH DELIMITERS MUST HUG THEIR TEXT, which is CommonMark's left/right
 * flanking rule reduced to the part that actually matters here. Without it
 * `2 * 3 * 4 = 24` reads as italic `3` — arithmetic silently reformatted as
 * emphasis, in a note somebody is about to email to a client.
 */
function matchEmphasis(
  rest: string,
): { inner: string; mark: Partial<MdSpan>; length: number } | null {
  for (const candidate of EMPHASIS) {
    if (!rest.startsWith(candidate.open)) continue;

    // Whitespace immediately after the opening run: not an opener.
    if (/\s/.test(rest[candidate.open.length] ?? '')) continue;

    const close = rest.indexOf(candidate.open, candidate.open.length);

    if (close <= candidate.open.length) continue;

    // Whitespace immediately before the closing run: not a closer.
    if (/\s/.test(rest[close - 1] ?? '')) continue;

    return {
      inner: rest.slice(candidate.open.length, close),
      mark: candidate.mark,
      length: close + candidate.open.length,
    };
  }

  return null;
}

function matchFence(line: string): { marker: string; language: string | null } | null {
  const match = /^ {0,3}(`{3,}|~{3,})\s*([^`]*)$/.exec(line);

  if (!match) return null;

  const language = (match[2] ?? '').trim();

  return { marker: (match[1] ?? '').slice(0, 3), language: language.length > 0 ? language : null };
}

function closesFence(line: string, marker: string): boolean {
  return new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{3,}\\s*$`).test(line);
}

function isRule(line: string): boolean {
  return /^ {0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line);
}

function indentOf(line: string): number {
  return /^ */.exec(line)?.[0].length ?? 0;
}

function matchListMarker(
  line: string,
): { ordered: boolean; start: number; width: number } | null {
  const bullet = /^( {0,3})([-*+])(\s+)/.exec(line);

  if (bullet) {
    return {
      ordered: false,
      start: 1,
      width: (bullet[1] ?? '').length + 1 + (bullet[3] ?? '').length,
    };
  }

  const ordered = /^( {0,3})(\d{1,9})([.)])(\s+)/.exec(line);

  if (ordered) {
    return {
      ordered: true,
      start: Number.parseInt(ordered[2] ?? '1', 10),
      width:
        (ordered[1] ?? '').length +
        (ordered[2] ?? '').length +
        1 +
        (ordered[4] ?? '').length,
    };
  }

  return null;
}

/**
 * A PLAIN-TEXT body as blocks (issue #334) — the same node shape
 * {@link parseMarkdown} returns, so the PDF and DOCX renderers draw it with
 * the code they already have, but with NO Markdown interpretation at all.
 *
 * A note whose template asked for `plain_text` was written to be read
 * literally: a line that happens to start with `#` or `-`, or a phrase wrapped
 * in `*`, is text the user sees verbatim, never a heading, a bullet or bold.
 * So the only structure recognised is the one plain text itself has — blank
 * lines separate paragraphs — and every paragraph is exactly one unmarked span
 * whose single line breaks are kept as `\n` for the renderer to honour.
 *
 * Total, like `parseMarkdown`: every input yields a (possibly empty) list.
 */
export function parsePlainText(source: string): MdBlock[] {
  return source
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((block) =>
      block
        .split('\n')
        .map((line) => line.replace(/\s+$/, ''))
        .join('\n')
        .replace(/^\n+|\n+$/g, ''),
    )
    .filter((block) => block.trim().length > 0)
    .map((text): MdBlock => ({ type: 'paragraph', spans: [{ text }] }));
}

/**
 * The body as blocks, by its declared format. `plain_text` is taken literally;
 * anything else — `markdown`, or a value this build does not recognise — is
 * parsed as Markdown, which is what every note written before #334 is.
 */
export function parseBody(source: string, bodyFormat: string | undefined): MdBlock[] {
  return bodyFormat === 'plain_text' ? parsePlainText(source) : parseMarkdown(source);
}
