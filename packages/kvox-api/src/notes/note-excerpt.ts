// =============================================================================
// The plain-text excerpt a Notes list row carries (issue #751)
// =============================================================================
//
// The list used to flatten the RAW markdown, so a row read `# Title ## 0. Header
// | Field | Details | |---|---|`. This reads the parsed blocks instead (the same
// `parseBody` the PDF/DOCX renderers use, so it needs no dependency): prose
// first (paragraphs, list items, quotes), skipping headings, code, rules and
// all-bold pseudo-headings. A table is a fallback for a note that is only a
// table; headings are the last resort. Pure: no I/O, no Nest.
// =============================================================================

import { EXCERPT_CHARS } from './dto/note.dto.js';

import { parseBody, spansText, type MdBlock, type MdSpan } from './export/markdown-ast.js';

/** How much of a body is parsed. The parser is total, so a cut mid-construct is safe. */
export const EXCERPT_SOURCE_CHARS = 16_000;

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Text of a span list with images dropped. */
function inlineText(spans: readonly MdSpan[]): string {
  return collapse(spansText(spans.filter((span) => !span.image)));
}

/** A paragraph whose visible spans are all bold reads as a heading, not prose. */
function isPseudoHeading(spans: readonly MdSpan[]): boolean {
  const visible = spans.filter((span) => !span.image && span.text.trim() !== '');

  return visible.length > 0 && visible.every((span) => span.bold);
}

function collectProse(blocks: readonly MdBlock[], out: string[]): void {
  for (const block of blocks) {
    if (block.type === 'paragraph') {
      if (isPseudoHeading(block.spans)) continue;
      const text = inlineText(block.spans);
      if (text) out.push(text);
    } else if (block.type === 'list') {
      for (const item of block.items) collectProse(item, out);
    } else if (block.type === 'quote') {
      collectProse(block.blocks, out);
    }
  }
}

function collectTables(blocks: readonly MdBlock[], out: string[]): void {
  for (const block of blocks) {
    if (block.type === 'table') {
      for (const row of block.rows) {
        const cells = row.map(inlineText);
        if (cells.every((cell) => !cell)) continue;
        if (cells.length === 2) {
          out.push(cells[0] && cells[1] ? `${cells[0]}: ${cells[1]}` : cells[0] || cells[1]);
        } else {
          out.push(cells.filter(Boolean).join(' · '));
        }
      }
    } else if (block.type === 'list') {
      for (const item of block.items) collectTables(item, out);
    } else if (block.type === 'quote') {
      collectTables(block.blocks, out);
    }
  }
}

function collectHeadings(blocks: readonly MdBlock[], out: string[]): void {
  for (const block of blocks) {
    if (block.type === 'heading') {
      const text = inlineText(block.spans);
      if (text) out.push(text);
    }
  }
}

/** A space after sentence-ending punctuation, ` · ` between anything else. */
function join(pieces: readonly string[]): string {
  let result = '';

  pieces.forEach((piece, index) => {
    if (index > 0) result += /[.!?:;]$/.test(pieces[index - 1]!) ? ' ' : ' · ';
    result += piece;
  });

  return collapse(result);
}

/**
 * A plain-text summary of a note body for a list row: markdown syntax removed,
 * prose first, at most {@link EXCERPT_CHARS} characters (plus a trailing `…`
 * when cut on a whitespace boundary).
 */
export function noteExcerpt(body: string, bodyFormat?: string | null): string {
  const blocks = parseBody(body.slice(0, EXCERPT_SOURCE_CHARS), bodyFormat ?? undefined);

  let pieces: string[] = [];
  collectProse(blocks, pieces);

  if (pieces.length === 0) collectTables(blocks, (pieces = []));
  if (pieces.length === 0) collectHeadings(blocks, (pieces = []));

  const text = join(pieces);

  if (text.length <= EXCERPT_CHARS) return text;

  const cut = text.slice(0, EXCERPT_CHARS);
  const boundary = text[EXCERPT_CHARS] === ' ' ? EXCERPT_CHARS : cut.lastIndexOf(' ');

  return `${(boundary > 0 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}
