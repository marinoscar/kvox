import { RICH_NOTE_BODY } from '../testing/export-fixtures.js';
import {
  parseBody,
  parseInline,
  parseMarkdown,
  parsePlainText,
  spansText,
  type MdBlock,
} from './markdown-ast.js';

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
    // Raw HTML and footnotes are outside the subset. They must arrive as literal text.
    const blocks = parseMarkdown('<div>raw</div>\n\nNote[^1]\n\n[^1]: the footnote');

    expect(blocks.map(text).join('\n')).toContain('<div>raw</div>');
    expect(blocks.map(text).join('\n')).toContain('[^1]: the footnote');
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

// -----------------------------------------------------------------------------
// The GFM subset the web app renders: tables, task lists, hard breaks, autolinks,
// images, setext headings
// -----------------------------------------------------------------------------

type TableBlock = Extract<MdBlock, { type: 'table' }>;
type ListBlock = Extract<MdBlock, { type: 'list' }>;

const cellTexts = (cells: MdSpanList[]): string[] => cells.map((cell) => spansText(cell));

type MdSpanList = ReturnType<typeof parseInline>;

describe('GFM tables', () => {
  it('parses header, alignment and rows', () => {
    const [table] = parseMarkdown(
      '| A | B | C | D |\n| :-- | :-: | --: | --- |\n| 1 | 2 | 3 | 4 |\n| **x** | y | z | w |',
    ) as TableBlock[];

    expect(table?.type).toBe('table');
    expect(table?.align).toEqual(['left', 'center', 'right', null]);
    expect(cellTexts(table?.header ?? [])).toEqual(['A', 'B', 'C', 'D']);
    expect(table?.rows).toHaveLength(2);
    expect(table?.rows[1]?.[0]).toEqual([{ text: 'x', bold: true }]);
  });

  it('accepts rows without leading or trailing pipes', () => {
    const [table] = parseMarkdown('a | b\n--- | ---\n1 | 2') as TableBlock[];

    expect(cellTexts(table?.header ?? [])).toEqual(['a', 'b']);
    expect(cellTexts(table?.rows[0] ?? [])).toEqual(['1', '2']);
  });

  it('turns an escaped pipe into a literal one', () => {
    const [table] = parseMarkdown('| a | b |\n|---|---|\n| x \\| y | z |') as TableBlock[];

    expect(cellTexts(table?.rows[0] ?? [])).toEqual(['x | y', 'z']);
  });

  it('does not split on a pipe inside a code span, and unescapes \\| there', () => {
    const [table] = parseMarkdown('| a | b |\n|---|---|\n| `x|y` | `p\\|q` |') as TableBlock[];

    expect(table?.rows[0]?.[0]).toEqual([{ text: 'x|y', code: true }]);
    expect(table?.rows[0]?.[1]).toEqual([{ text: 'p|q', code: true }]);
  });

  it('pads short rows and truncates long ones', () => {
    const [table] = parseMarkdown('| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 | 5 |') as TableBlock[];

    expect(cellTexts(table?.rows[0] ?? [])).toEqual(['1', '', '']);
    expect(cellTexts(table?.rows[1] ?? [])).toEqual(['1', '2', '3']);
  });

  it('interrupts a paragraph', () => {
    const blocks = parseMarkdown('Intro line\n| a | b |\n|---|---|\n| 1 | 2 |');

    expect(blocks.map((block) => block.type)).toEqual(['paragraph', 'table']);
    expect(text(blocks[0])).toBe('Intro line');
  });

  it('ends at a blank line or at another block', () => {
    const blocks = parseMarkdown('| a |\n| - |\n| 1 |\n## Next\n\n| a |\n| - |\n| 2 |\nno pipe here');

    expect(blocks.map((block) => block.type)).toEqual(['table', 'heading', 'table', 'paragraph']);
    expect((blocks[0] as TableBlock).rows).toHaveLength(1);
    expect((blocks[2] as TableBlock).rows).toHaveLength(1);
  });

  it('works inside a list item and a quote', () => {
    const [list] = parseMarkdown('- item\n  | a | b |\n  |---|---|\n  | 1 | 2 |') as ListBlock[];

    expect(list?.items[0]?.map((block) => block.type)).toEqual(['paragraph', 'table']);

    const [quote] = parseMarkdown('> | a |\n> |---|\n> | 1 |');

    expect(quote).toMatchObject({ type: 'quote' });
    expect((quote as Extract<MdBlock, { type: 'quote' }>).blocks[0]?.type).toBe('table');
  });

  it('keeps a pipe line without a delimiter row as a paragraph', () => {
    const blocks = parseMarkdown('| a | b |\n| 1 | 2 |');

    expect(blocks.map((block) => block.type)).toEqual(['paragraph']);
    expect(text(blocks[0])).toBe('| a | b | | 1 | 2 |');
  });

  it('is not a table when the delimiter cell count differs', () => {
    expect(parseMarkdown('| a | b |\n|---|').map((block) => block.type)).toEqual(['paragraph']);
  });
});

describe('task lists', () => {
  it('marks checked, open and plain items and strips the prefix', () => {
    const [list] = parseMarkdown('- [x] done\n- [ ] open\n- [X] also done\n- plain') as ListBlock[];

    expect(list?.tasks).toEqual([true, false, true, null]);
    expect(text(list?.items[0]?.[0])).toBe('done');
    expect(text(list?.items[1]?.[0])).toBe('open');
    expect(text(list?.items[3]?.[0])).toBe('plain');
  });

  it('omits tasks when no item is a task, and ignores a link-looking [x](url)', () => {
    const [list] = parseMarkdown('- [x](https://a.test)\n- b') as ListBlock[];

    expect(list).not.toHaveProperty('tasks');
  });
});

describe('hard line breaks', () => {
  it('breaks on two trailing spaces and on a backslash', () => {
    expect(text(parseMarkdown('one  \ntwo')[0])).toBe('one\ntwo');
    expect(text(parseMarkdown('one\\\ntwo')[0])).toBe('one\ntwo');
    expect(text(parseMarkdown('one \ntwo')[0])).toBe('one two');
    expect(text(parseMarkdown('one\\\\\ntwo')[0])).toBe('one\\ two');
  });

  it('reads <br> in any form, in paragraphs, list items and table cells', () => {
    expect(text(parseMarkdown('a<br>b<BR/>c<br />d')[0])).toBe('a\nb\nc\nd');

    const [list] = parseMarkdown('- a  \n  b') as ListBlock[];

    expect(text(list?.items[0]?.[0])).toBe('a\nb');

    const [table] = parseMarkdown('| a |\n|---|\n| x<br>y |') as TableBlock[];

    expect(spansText(table?.rows[0]?.[0] ?? [])).toBe('x\ny');
  });
});

describe('inline extras', () => {
  it('links <angle> autolinks and email autolinks', () => {
    expect(parseInline('<https://a.test/x>')).toEqual([
      { text: 'https://a.test/x', href: 'https://a.test/x' },
    ]);
    expect(parseInline('<a@b.co>')).toEqual([{ text: 'a@b.co', href: 'mailto:a@b.co' }]);
    expect(parseInline('<mailto:a@b.co>')[0]?.href).toBe('mailto:a@b.co');
  });

  it('links bare URLs and trims trailing punctuation and unbalanced parens', () => {
    expect(parseInline('see https://a.test/x.')).toEqual([
      { text: 'see ' },
      { text: 'https://a.test/x', href: 'https://a.test/x' },
      { text: '.' },
    ]);
    expect(parseInline('(https://a.test/x)')[1]).toEqual({
      text: 'https://a.test/x',
      href: 'https://a.test/x',
    });
    expect(parseInline('https://a.test/f_(x)')[0]?.text).toBe('https://a.test/f_(x)');
    expect(parseInline('go http://a.test?q=1, now')[1]?.text).toBe('http://a.test?q=1');
  });

  it('links www. URLs with an http:// href', () => {
    expect(parseInline('www.example.com')).toEqual([
      { text: 'www.example.com', href: 'http://www.example.com' },
    ]);
  });

  it('does not link inside code or mid-word', () => {
    expect(parseInline('`https://a.test`')).toEqual([{ text: 'https://a.test', code: true }]);
    expect(parseInline('xhttps://a.test')).toEqual([{ text: 'xhttps://a.test' }]);
  });

  it('turns an image into a link span flagged image', () => {
    expect(parseInline('![A chart](https://a.test/c.png "t")')).toEqual([
      { text: 'A chart', href: 'https://a.test/c.png', image: true },
    ]);
    expect(parseInline('![](https://a.test/c.png)')).toEqual([
      { text: 'https://a.test/c.png', href: 'https://a.test/c.png', image: true },
    ]);
  });

  it('drops HTML comments', () => {
    expect(spansText(parseInline('a<!-- hidden -->b'))).toBe('ab');
    expect(parseMarkdown('<!-- only -->')).toEqual([]);
    expect(parseMarkdown('<!-- multi\nline -->\n\nafter').map(text)).toEqual(['after']);
    // Unterminated: stays literal instead of swallowing the rest.
    expect(text(parseMarkdown('<!-- open\nstill here')[0])).toBe('<!-- open still here');
  });
});

describe('setext headings', () => {
  it('reads === as h1 and --- as h2', () => {
    const blocks = parseMarkdown('Title\n=====\n\nSub title\n---\n\nbody');

    expect(blocks[0]).toMatchObject({ type: 'heading', level: 1 });
    expect(blocks[1]).toMatchObject({ type: 'heading', level: 2 });
    expect(text(blocks[1])).toBe('Sub title');
    expect(blocks[2]?.type).toBe('paragraph');
  });

  it('keeps a rule after a blank line, and a leading --- a rule', () => {
    expect(parseMarkdown('text\n\n---').map((block) => block.type)).toEqual(['paragraph', 'rule']);
    expect(parseMarkdown('---\ntext').map((block) => block.type)).toEqual(['rule', 'paragraph']);
  });
});

describe('RICH_NOTE_BODY', () => {
  it('parses into every block kind', () => {
    const blocks = parseMarkdown(RICH_NOTE_BODY);
    const kinds = new Set(blocks.map((block) => block.type));

    for (const kind of ['heading', 'paragraph', 'table', 'list', 'quote', 'code', 'rule']) {
      expect(kinds).toContain(kind);
    }

    expect(blocks.find((block) => block.type === 'table')).toMatchObject({
      align: ['left', 'center', 'right', null],
    });
    expect(blocks.some((block) => block.type === 'list' && block.tasks !== undefined)).toBe(true);
  });
});
