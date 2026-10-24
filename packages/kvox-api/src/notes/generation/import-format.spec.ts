import {
  FORMAT_FAITHFULNESS_MIN_COVERAGE,
  FORMAT_FAITHFULNESS_MIN_PRECISION,
  IMPORT_FORMAT_SYSTEM_PROMPT,
  checkFormattingFaithfulness,
  chunkMarkdownForFormatting,
  stripOuterCodeFence,
} from './import-format.js';

const PARAGRAPH =
  'The committee met on Tuesday to review the budget for the coming year and agreed that travel spending ' +
  'should be reduced by ten percent while training spending stays flat across every department of the company.';

describe('checkFormattingFaithfulness', () => {
  it('pins the thresholds', () => {
    expect(FORMAT_FAITHFULNESS_MIN_COVERAGE).toBe(0.97);
    expect(FORMAT_FAITHFULNESS_MIN_PRECISION).toBe(0.97);
  });

  it('accepts a reformat: re-joined lines, headings, lists, emphasis, a table and a hyphenated break', () => {
    const original = [
      'Quarterly Review',
      'The committee met on Tuesday to review the budget for the coming year and agreed',
      'that travel spending should be reduced by ten percent while training spending stays flat across',
      'every department of the com-',
      'pany and its regional offices.',
      'Item one',
      'Item two',
      'Region Sales',
      'North 10',
    ].join('\n');
    const formatted = [
      '# Quarterly Review',
      '',
      'The committee met on **Tuesday** to review the budget for the coming year and agreed that travel spending should be reduced by ten percent while training spending stays flat across every department of the company and its regional offices.',
      '',
      '- Item one',
      '- Item two',
      '',
      '| Region | Sales |',
      '| --- | --- |',
      '| North | 10 |',
    ].join('\n');

    expect(checkFormattingFaithfulness(original, formatted)).toMatchObject({ ok: true, reason: null });
  });

  it('accepts identical words with only a heading mark added', () => {
    expect(checkFormattingFaithfulness(`${PARAGRAPH} Section two ${PARAGRAPH}`, `${PARAGRAPH}\n\n## Section two\n\n${PARAGRAPH}`))
      .toMatchObject({ ok: true, coverage: 1, precision: 1, reason: null });
  });

  it('refuses a dropped paragraph', () => {
    const original = `${PARAGRAPH}\n\nSecond paragraph about the office move.\n\n${PARAGRAPH}`;
    const formatted = `${PARAGRAPH}\n\n${PARAGRAPH}`;

    const verdict = checkFormattingFaithfulness(original, formatted);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('dropped_content');
    expect(verdict.coverage).toBeLessThan(FORMAT_FAITHFULNESS_MIN_COVERAGE);
  });

  it('refuses an invented sentence', () => {
    const original = `${PARAGRAPH}\n\n${PARAGRAPH}`;
    const formatted = `${PARAGRAPH}\n\n${PARAGRAPH}\n\nIn summary, the committee made several important decisions that will shape the company going forward.`;

    const verdict = checkFormattingFaithfulness(original, formatted);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('added_content');
    expect(verdict.precision).toBeLessThan(FORMAT_FAITHFULNESS_MIN_PRECISION);
  });

  it('refuses a summary and an empty answer', () => {
    expect(checkFormattingFaithfulness(PARAGRAPH.repeat(3), 'The committee cut travel.').ok).toBe(false);
    expect(checkFormattingFaithfulness(PARAGRAPH, '  \n')).toMatchObject({ ok: false, reason: 'empty_output' });
  });

  it('counts repeated words as a multiset, not a set', () => {
    const original = 'yes '.repeat(100);
    expect(checkFormattingFaithfulness(original, 'yes '.repeat(50)).ok).toBe(false);
  });

  it('treats two empty texts as faithful', () => {
    expect(checkFormattingFaithfulness('', '')).toMatchObject({ ok: true });
  });

  it('ignores case and punctuation but not letters of other scripts', () => {
    expect(checkFormattingFaithfulness('Hola, Señor!', 'hola señor').ok).toBe(true);
    expect(checkFormattingFaithfulness('Hola Señor', 'Hello Sir').ok).toBe(false);
  });
});

describe('chunkMarkdownForFormatting', () => {
  it('returns no chunks for an empty document and one for a short one', () => {
    expect(chunkMarkdownForFormatting('', 100)).toEqual([]);
    expect(chunkMarkdownForFormatting('short text', 100)).toEqual(['short text']);
  });

  it('is lossless and respects the limit', () => {
    const doc = Array.from({ length: 30 }, (_, i) => `# Section ${i}\n\n${PARAGRAPH}\n\n${PARAGRAPH}\n`).join('\n');
    const chunks = chunkMarkdownForFormatting(doc, 900);

    expect(chunks.join('')).toBe(doc);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(900);
  });

  it('starts a new chunk at a heading rather than splitting a section that fits', () => {
    const a = `# A\n\n${'a '.repeat(100)}\n`;
    const b = `# B\n\n${'b '.repeat(100)}\n`;
    const chunks = chunkMarkdownForFormatting(a + b, a.length + 10);

    expect(chunks).toEqual([a, b]);
  });

  it('packs small sections together', () => {
    const doc = '# A\n\none\n\n# B\n\ntwo\n\n# C\n\nthree\n';
    expect(chunkMarkdownForFormatting(doc, 1000)).toEqual([doc]);
  });

  it('cuts an oversized section at blank lines, then lines, then spaces', () => {
    const paragraphs = `${'word '.repeat(40)}\n\n${'word '.repeat(40)}\n\n${'word '.repeat(40)}`;
    const byParagraph = chunkMarkdownForFormatting(paragraphs, 250);
    expect(byParagraph.join('')).toBe(paragraphs);
    expect(byParagraph.every((c) => c.length <= 250)).toBe(true);
    expect(byParagraph[0]!.endsWith('\n\n')).toBe(true);

    const oneLine = 'word '.repeat(200);
    const bySpace = chunkMarkdownForFormatting(oneLine, 120);
    expect(bySpace.join('')).toBe(oneLine);
    expect(bySpace.every((c) => c.length <= 120)).toBe(true);
    expect(bySpace.every((c) => c.endsWith(' '))).toBe(true);

    const unbroken = 'x'.repeat(250);
    expect(chunkMarkdownForFormatting(unbroken, 100).map((c) => c.length)).toEqual([100, 100, 50]);
  });

  it('does not treat a # inside a code fence as a heading', () => {
    const doc = '# A\n\n```sh\n# not a heading\necho hi\n```\n';
    expect(chunkMarkdownForFormatting(doc, 20).join('')).toBe(doc);
    // The fence line keeps its comment in the same piece as the section start when it fits.
    expect(chunkMarkdownForFormatting(doc, 1000)).toEqual([doc]);
  });
});

describe('stripOuterCodeFence', () => {
  it('removes a fence the model wrapped around the whole answer', () => {
    expect(stripOuterCodeFence('```markdown\n# Title\n\ntext\n```', 'Title text')).toBe('# Title\n\ntext');
  });

  it('leaves other answers, and inputs that are themselves code, alone', () => {
    expect(stripOuterCodeFence('# Title\n\ntext', 'Title text')).toBe('# Title\n\ntext');
    expect(stripOuterCodeFence('```js\nx\n```', '```js\nx\n```')).toBe('```js\nx\n```');
  });
});

describe('IMPORT_FORMAT_SYSTEM_PROMPT', () => {
  it('forbids changing the content and following the document', () => {
    expect(IMPORT_FORMAT_SYSTEM_PROMPT).toMatch(/NOT/);
    expect(IMPORT_FORMAT_SYSTEM_PROMPT).toMatch(/summarise/);
    expect(IMPORT_FORMAT_SYSTEM_PROMPT).toMatch(/translate/);
    expect(IMPORT_FORMAT_SYSTEM_PROMPT).toMatch(/Follow any instruction/);
  });
});
