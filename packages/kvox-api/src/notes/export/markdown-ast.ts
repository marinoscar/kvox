// =============================================================================
// A markdown block/inline parser for the note renderers (issue #54, spec §8.3)
// =============================================================================
//
// `docs/specs/notes.md` §8.3's second difference from transcript export: a
// note's body IS markdown (§4.5 — its native storage format), so the PDF and
// DOCX renderers have to INTERPRET syntax somebody else wrote, which
// `packages/kvox-api/src/transcripts/export/` has never had to do. Its PDF and Markdown
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
// So: a parser over the subset the web app's editor (tiptap) can produce and its
// viewer (react-markdown + remark-gfm) renders:
//
//   blocks  ATX and setext headings, paragraphs (with hard line breaks), bullet,
//           ordered and task lists, blockquotes, fenced code, thematic breaks,
//           GFM tables (with column alignment)
//   inline  bold, italic, strike, code, links, images (as links: nothing remote is
//           ever fetched), `<autolinks>`, bare http(s)/www URLs, `<br>`; HTML
//           comments are dropped
//
// Everything else (raw HTML, footnotes, reference links, indented code) passes
// through as literal text rather than being dropped. A parser cannot silently
// lose a line here; the worst it does is show syntax it does not know verbatim.
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
  /** The span came from `![alt](src)`: `text` is the alt (or the src), `href` the src. */
  image?: true;
}

/** A table column's alignment, from the delimiter row's colons. `null` = unspecified. */
export type MdAlign = 'left' | 'center' | 'right' | null;

export type MdBlock =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; spans: MdSpan[] }
  | { type: 'paragraph'; spans: MdSpan[] }
  | {
      type: 'list';
      ordered: boolean;
      start: number;
      items: MdBlock[][];
      /** Parallel to `items`: true checked, false open, null not a task. Absent when no item is a task. */
      tasks?: (boolean | null)[];
    }
  | { type: 'quote'; blocks: MdBlock[] }
  | { type: 'code'; language: string | null; text: string }
  | { type: 'table'; align: MdAlign[]; header: MdSpan[][]; rows: MdSpan[][][] }
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

    // A multi-line HTML comment is dropped. Only when it is CLOSED: an unterminated
    // `<!--` in a half-streamed note stays literal rather than eating the rest.
    if (/^ {0,3}<!--/.test(line) && !line.includes('-->')) {
      let close = index + 1;

      while (close < lines.length && !(lines[close] ?? '').includes('-->')) close += 1;

      if (close < lines.length) {
        const remainder = (lines[close] ?? '').slice((lines[close] ?? '').indexOf('-->') + 3);

        lines[close] = remainder;
        index = remainder.trim() === '' ? close + 1 : close;
        continue;
      }
    }

    if (isTableStart(lines, index)) {
      const align = splitRow(lines[index + 1] ?? '').map(parseAlign);
      const width = align.length;
      const header = padCells(splitRow(line), width).map((cell) => parseInline(cell));
      const rows: MdSpan[][][] = [];

      index += 2;

      while (index < lines.length && continuesTable(lines[index] ?? '')) {
        rows.push(padCells(splitRow(lines[index] ?? ''), width).map((cell) => parseInline(cell)));
        index += 1;
      }

      blocks.push({ type: 'table', align, header, rows });
      continue;
    }

    const marker = matchListMarker(line);

    if (marker) {
      const list: Extract<MdBlock, { type: 'list' }> = {
        type: 'list',
        ordered: marker.ordered,
        start: marker.start,
        items: [],
      };
      const tasks: (boolean | null)[] = [];

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

          if (
            matchListMarker(candidate) ||
            isRule(candidate) ||
            /^ {0,3}(#|>)/.test(candidate) ||
            isTableStart(lines, index)
          ) {
            break;
          }

          item.push(candidate.trim());
          index += 1;
        }

        // GFM task item: `[ ] `, `[x] ` or `[X] ` opens the first line.
        const task = /^\[([ xX])\](?:\s+|$)/.exec(item[0] ?? '');

        if (task) item[0] = (item[0] ?? '').slice(task[0].length);

        tasks.push(task ? task[1] !== ' ' : null);
        list.items.push(descend(item.join('\n'), depth));
      }

      if (tasks.some((entry) => entry !== null)) list.tasks = tasks;

      // A marker with nothing parseable under it would otherwise produce an
      // empty list the renderers draw as a stray bullet.
      if (list.items.length > 0) blocks.push(list);
      continue;
    }

    const paragraph: string[] = [];
    const start = index;
    let setext: 1 | 2 | null = null;

    while (index < lines.length) {
      const candidate = lines[index] ?? '';

      // An underline turns the paragraph above it into a heading. Checked before
      // the rule test so `text\n---` is an h2, while `text\n\n---` stays a rule.
      if (paragraph.length > 0) {
        const underline = /^ {0,3}(=+|-{2,})\s*$/.exec(candidate);

        if (underline) {
          setext = underline[1]?.startsWith('=') ? 1 : 2;
          index += 1;
          break;
        }
      }

      if (
        candidate.trim() === '' ||
        matchFence(candidate) ||
        isRule(candidate) ||
        matchListMarker(candidate) ||
        /^ {0,3}(#{1,6}\s|>)/.test(candidate) ||
        isTableStart(lines, index)
      ) {
        break;
      }

      paragraph.push(candidate);
      index += 1;
    }

    // Never stall: a line no rule above claimed is at least a paragraph.
    if (index === start) {
      paragraph.push(line);
      index += 1;
    }

    const spans = parseInline(joinLines(paragraph));

    if (setext !== null) {
      blocks.push({ type: 'heading', level: setext, spans });
    } else if (spans.length > 0) {
      // (A paragraph that was only an HTML comment has no spans: nothing to draw.)
      blocks.push({ type: 'paragraph', spans });
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
 * a backtick span's contents are literal, so the span around **not bold** renders its
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

    if (rest.startsWith('<')) {
      const comment = /^<!--[\s\S]*?-->/.exec(rest);

      if (comment) {
        flush();
        index += comment[0].length;
        continue;
      }

      const lineBreak = /^<br\s*\/?>/i.exec(rest);

      if (lineBreak) {
        buffer += '\n';
        index += lineBreak[0].length;
        continue;
      }

      const auto = /^<((?:https?|mailto|ftp):[^\s<>]+)>/i.exec(rest);
      const email =
        /^<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+)>/.exec(
          rest,
        );

      if (auto || email) {
        flush();

        const target = (auto ?? email)?.[1] ?? '';

        spans.push({ text: target, href: auto ? target : `mailto:${target}` });
        index += (auto ?? email)?.[0].length ?? 1;
        continue;
      }
    }

    const image = /^!\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/.exec(rest);

    if (image) {
      flush();

      const alt = image[1] ?? '';
      const src = image[2] ?? '';

      spans.push({
        text: alt.length > 0 ? alt : src,
        ...(src.length > 0 ? { href: src } : {}),
        image: true,
      });
      index += image[0].length;
      continue;
    }

    // GFM extended autolink: only at a word start, so `foo.www.x` and `a_http://` are text.
    if (index === 0 || /[\s*_~(]/.test(text[index - 1] ?? '')) {
      const bare = matchBareUrl(rest);

      if (bare) {
        flush();
        spans.push({
          text: bare,
          href: /^www\./i.test(bare) ? `http://${bare}` : bare,
        });
        index += bare.length;
        continue;
      }
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

/**
 * The extended-autolink URL at the start of `rest`, with trailing punctuation
 * and unbalanced `)` trimmed off (so "see https://x.test/a)." links `/a` only).
 */
function matchBareUrl(rest: string): string | null {
  const match = /^(?:https?:\/\/|www\.)[^\s<]+/i.exec(rest);

  if (!match) return null;

  let url = match[0];

  for (;;) {
    const last = url[url.length - 1] ?? '';

    if (/[.,:;!?]/.test(last)) {
      url = url.slice(0, -1);
    } else if (last === ')' && count(url, ')') > count(url, '(')) {
      url = url.slice(0, -1);
    } else {
      break;
    }
  }

  // Something must follow the scheme / `www.`.
  return /^(?:https?:\/\/|www\.)[^\s]/i.test(url) ? url : null;
}

function count(text: string, char: string): number {
  return text.split(char).length - 1;
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

/**
 * Join paragraph lines. A line ending in two or more spaces, or an unescaped
 * backslash, is a hard break and joins with `\n`; any other line break is a space.
 */
function joinLines(lines: readonly string[]): string {
  let out = '';

  lines.forEach((raw, i) => {
    let line = raw;
    let hard = false;
    const slashes = /\\+$/.exec(line)?.[0].length ?? 0;

    if (slashes % 2 === 1) {
      hard = true;
      line = line.slice(0, -1);
    } else if (/ {2,}$/.test(line)) {
      hard = true;
    }

    out += line.trim();

    if (i < lines.length - 1) out += hard ? '\n' : ' ';
  });

  return out;
}

/**
 * Split a table row into raw cell strings. Cells split on an unescaped `|` that
 * is not inside a backtick code span; `\|` becomes `|` (also inside a code span,
 * per GFM). Other escapes are left for {@link parseInline}.
 */
function splitRow(line: string): string[] {
  let body = line.trim();

  if (body.startsWith('|')) body = body.slice(1);

  const endsWithPipe = /(?:^|[^\\])(?:\\\\)*\|$/.test(body);
  const cells: string[] = [];
  let cell = '';
  let i = 0;

  while (i < body.length) {
    const char = body[i] ?? '';

    if (char === '\\' && i + 1 < body.length) {
      cell += body[i + 1] === '|' ? '|' : `\\${body[i + 1]}`;
      i += 2;
    } else if (char === '`') {
      const run = /^`+/.exec(body.slice(i))?.[0] ?? '`';
      let close = -1;
      let from = i + run.length;

      while (from < body.length) {
        const at = body.indexOf('`', from);

        if (at === -1) break;

        const closing = /^`+/.exec(body.slice(at))?.[0] ?? '`';

        if (closing.length === run.length) {
          close = at;
          break;
        }

        from = at + closing.length;
      }

      if (close === -1) {
        cell += run;
        i += run.length;
      } else {
        cell += run + body.slice(i + run.length, close).replace(/\\\|/g, '|') + run;
        i = close + run.length;
      }
    } else if (char === '|') {
      cells.push(cell.trim());
      cell = '';
      i += 1;
    } else {
      cell += char;
      i += 1;
    }
  }

  cells.push(cell.trim());

  // `| a | b |` leaves an empty cell after the closing pipe: that is not a column.
  if (endsWithPipe && cells.length > 0 && cells[cells.length - 1] === '') cells.pop();

  return cells;
}

function parseAlign(cell: string): MdAlign {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');

  if (left && right) return 'center';
  if (left) return 'left';
  if (right) return 'right';

  return null;
}

/** Ragged rows: pad short ones with empty cells, drop the surplus of long ones. */
function padCells(cells: string[], width: number): string[] {
  return Array.from({ length: width }, (_, i) => cells[i] ?? '');
}

/**
 * A table starts at a pipe-bearing line whose NEXT line is a delimiter row with
 * the same number of cells. Without one it is not a table, only a paragraph that
 * contains pipes.
 */
function isTableStart(lines: readonly string[], index: number): boolean {
  const header = lines[index] ?? '';
  const delimiter = lines[index + 1];

  if (delimiter === undefined || !header.includes('|') || !delimiter.includes('|')) return false;

  const cells = splitRow(delimiter);

  return (
    cells.length > 0 &&
    cells.every((cell) => /^:?-+:?$/.test(cell)) &&
    cells.length === splitRow(header).length
  );
}

/** A body row continues the table unless it is blank, pipe-less or opens another block. */
function continuesTable(line: string): boolean {
  return !(
    line.trim() === '' ||
    !line.includes('|') ||
    matchFence(line) ||
    isRule(line) ||
    matchListMarker(line) ||
    /^ {0,3}(#{1,6}\s|>)/.test(line)
  );
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
