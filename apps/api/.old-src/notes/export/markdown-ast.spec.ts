import {
  parseBody,
  parseInline,
  parseMarkdown,
  parsePlainText,
  spansText,
  type MdBlock,
} from './markdown-ast';

// =============================================================================
// The markdown parser the PDF and DOCX renderers lay out (issue #54, §8.3)
// =============================================================================
//
// It is hand-written (see the file's header for why every current parser is
// ESM-only and this build is CommonJS), so the subset it supports has to be
// pinned by tests rather than by a library's own suite. The properties that
// matter downstream:
//
//   * NOTHING IS EVER LOST. Syntax outside the subset falls through as literal
//     text — a renderer showing a table's pipes is acceptable; a renderer
//     silently dropping the row is not.
//   * A HALF-WRITTEN NOTE PARSES. `note.generate` streams deltas into the body,
//     so an unterminated fence and a bare list marker are ordinary inputs.
//   * CODE OUTRANKS EMPHASIS, so a code span's asterisks stay asterisks.
// =============================================================================

describe('parseMarkdown', () => {
  it('reads headings at every level, and stops at seven hashes', () => {
    const blocks = parseMarkdown('# One\n\n### Three\n\n####### Seven');

    expect(blocks.map((block) => block.type)).toEqual(['heading', 'heading', 'paragraph']);
    expect(blocks[0]).toMatchObject({ type: 'heading', level: 1 });
    expect(blocks[1]).toMatchObject({ type: 'heading', level: 3 });
    // Seven is not a heading in CommonMark either; it is a paragraph that
    // happens to begin with hashes, and it must keep them.
    expect(text(blocks[2])).toBe('####### Seven');
  });

  it('drops a heading\'s closing hash run but not one inside the text', () => {
    expect(text(parseMarkdown('## Decisions ##')[0])).toBe('Decisions');
    expect(text(parseMarkdown('## C# and F#')[0])).toBe('C# and F#');
  });

  it('joins wrapped paragraph lines and splits on a blank line', () => {
    const blocks = parseMarkdown('one\ntwo\n\nthree');

    expect(blocks).toHaveLength(2);
    expect(text(blocks[0])).toBe('one two');
    expect(text(blocks[1])).toBe('three');
  });

  it('reads bullet and ordered lists, keeping the ordered list\'s start', () => {
    const blocks = parseMarkdown('- a\n- b\n\n3. c\n4. d');

    expect(blocks[0]).toMatchObject({ type: 'list', ordered: false, start: 1 });
    expect(blocks[1]).toMatchObject({ type: 'list', ordered: true, start: 3 });
    expect((blocks[0] as Extract<MdBlock, { type: 'list' }>).items).toHaveLength(2);
  });

  it('starts a new list when the marker family changes', () => {
    // `- a` then `1. b` is two lists. One list whose numbering appeared halfway
    // down would renumber the reader's steps for them.
    const blocks = parseMarkdown('- a\n1. b');

    expect(blocks.map((block) => block.type)).toEqual(['list', 'list']);
  });

  it('nests a list under its parent item', () => {
    const blocks = parseMarkdown('- outer\n  - inner\n- second');
    const list = blocks[0] as Extract<MdBlock, { type: 'list' }>;

    expect(list.items).toHaveLength(2);
    expect(list.items[0]?.map((block) => block.type)).toEqual(['paragraph', 'list']);
    expect(text(list.items[0]?.[0])).toBe('outer');
  });

  it('keeps a fenced code block literal, including its markdown', () => {
    const blocks = parseMarkdown('```ts\nconst a = **1**;\n```');

    expect(blocks[0]).toEqual({ type: 'code', language: 'ts', text: 'const a = **1**;' });
  });

  it('survives an unterminated fence by consuming the rest', () => {
    // `note.generate` appends deltas to the body, so a body read mid-stream
    // ends in the middle of whatever the model was writing.
    const blocks = parseMarkdown('text\n\n```\nhalf a sample');

    expect(blocks.map((block) => block.type)).toEqual(['paragraph', 'code']);
    expect(blocks[1]).toMatchObject({ text: 'half a sample' });
  });

  it('reads a blockquote as nested blocks', () => {
    const blocks = parseMarkdown('> ## Quoted\n> and prose');
    const quote = blocks[0] as Extract<MdBlock, { type: 'quote' }>;

    expect(quote.type).toBe('quote');
    expect(quote.blocks.map((block) => block.type)).toEqual(['heading', 'paragraph']);
  });

  it('reads a thematic break, and does not mistake a bullet for one', () => {
    expect(parseMarkdown('---')[0]).toEqual({ type: 'rule' });
    expect(parseMarkdown('***')[0]).toEqual({ type: 'rule' });
    expect(parseMarkdown('- a')[0]?.type).toBe('list');
  });

  it('never loses a line it does not understand', () => {
    // A pipe table is outside the subset. It must arrive as literal text.
    const blocks = parseMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |');

    expect(blocks.map(text).join('\n')).toContain('| 1 | 2 |');
  });

  it('returns no blocks for an empty body rather than throwing', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('   \n\n  ')).toEqual([]);
  });

  it('ignores a list marker with nothing under it', () => {
    // A stray bullet a renderer would otherwise draw beside nothing.
    expect(parseMarkdown('-')).toEqual([{ type: 'paragraph', spans: [{ text: '-' }] }]);
  });
});

describe('parseInline', () => {
  it('reads bold, italic, strike and code', () => {
    expect(parseInline('**b** *i* ~~s~~ `c`')).toEqual([
      { text: 'b', bold: true },
      { text: ' ' },
      { text: 'i', italic: true },
      { text: ' ' },
      { text: 's', strike: true },
      { text: ' ' },
      { text: 'c', code: true },
    ]);
  });

  it('reads bold-italic as one span carrying both marks', () => {
    expect(parseInline('***both***')).toEqual([{ text: 'both', bold: true, italic: true }]);
  });

  it('lets code outrank emphasis', () => {
    // The whole reason code is matched first: a sample showing markdown syntax
    // must render its asterisks, not apply them.
    expect(parseInline('`**not bold**`')).toEqual([{ text: '**not bold**', code: true }]);
  });

  it('reads a link and carries its href onto every span of the label', () => {
    expect(parseInline('see [the **spec**](https://example.test/s)')).toEqual([
      { text: 'see ' },
      { text: 'the ', href: 'https://example.test/s' },
      { text: 'spec', bold: true, href: 'https://example.test/s' },
    ]);
  });

  it('honours a backslash escape ahead of everything else', () => {
    expect(parseInline('\\*not emphasis\\*')).toEqual([{ text: '*not emphasis*' }]);
  });

  it('leaves an unmatched marker as literal text', () => {
    expect(spansText(parseInline('2 * 3 * 4 = 24'))).toContain('*');
    expect(spansText(parseInline('a ** b'))).toBe('a ** b');
  });
});

/** The plain text of whatever block this is, for the assertions above. */
function text(block: MdBlock | undefined): string {
  if (!block) return '';
  if (block.type === 'heading' || block.type === 'paragraph') return spansText(block.spans);
  if (block.type === 'code') return block.text;
  if (block.type === 'quote') return block.blocks.map(text).join('\n');
  if (block.type === 'list') return block.items.map((item) => item.map(text).join(' ')).join('\n');

  return '';
}

describe('parsePlainText (issue #334)', () => {
  it('splits on blank lines and keeps single line breaks, interpreting nothing', () => {
    expect(parsePlainText('# not a heading\n*not bold*\n\n\n- not a bullet\r\n')).toEqual([
      { type: 'paragraph', spans: [{ text: '# not a heading\n*not bold*' }] },
      { type: 'paragraph', spans: [{ text: '- not a bullet' }] },
    ]);
  });

  it('is total: empty and whitespace-only input yield no blocks', () => {
    expect(parsePlainText('')).toEqual([]);
    expect(parsePlainText('  \n\n \t\n')).toEqual([]);
  });
});

describe('parseBody', () => {
  it('parses Markdown unless the format is exactly `plain_text`', () => {
    expect(parseBody('# Title', 'markdown')).toEqual(parseMarkdown('# Title'));
    expect(parseBody('# Title', undefined)).toEqual(parseMarkdown('# Title'));
    expect(parseBody('# Title', 'rtf')).toEqual(parseMarkdown('# Title'));
    expect(parseBody('# Title', 'plain_text')).toEqual(parsePlainText('# Title'));
  });
});
