// =============================================================================
// Chunking a note (issue #186, epic #165)
// =============================================================================

import { MAX_CHUNK_CHARS, MAX_TITLE_PREFIX_CHARS } from './chunk.types';
import { contentHash } from './content-hash';
import { chunkNote, noteChunkPrefix, noteSourceBody } from './note-chunker';

const TITLE = 'Q3 Budget Review';
const PREFIX = `${TITLE}\n\n`;

const paragraph = (seed: number, chars: number): string => {
  const words = [
    'budget',
    'forecast',
    'headcount',
    'runway',
    'contract',
    'renewal',
    'pipeline',
    'variance',
    'quarter',
    'approval',
  ];
  const parts: string[] = [];
  let index = seed;
  let length = 0;
  while (length < chars) {
    const word = words[index % words.length];
    parts.push(word);
    length += word.length + 1;
    index += 1;
  }
  return `${parts.join(' ')}.`;
};

const body = (count: number, chars = 400): string =>
  Array.from({ length: count }, (_unused, index) =>
    paragraph(index, chars),
  ).join('\n\n');

const sharedTail = (previous: string, next: string): number => {
  for (let length = Math.min(previous.length, next.length); length > 0; length -= 1) {
    if (previous.endsWith(next.slice(0, length))) return length;
  }
  return 0;
};

// -----------------------------------------------------------------------------

describe('noteChunkPrefix', () => {
  it('collapses whitespace and ends with a blank line', () => {
    expect(noteChunkPrefix('  Q3   Budget\nReview ')).toBe('Q3 Budget Review\n\n');
  });

  it('is empty for an untitled note rather than a decorative blank', () => {
    expect(noteChunkPrefix('')).toBe('');
    expect(noteChunkPrefix('   \n\t ')).toBe('');
  });

  it('bounds a pathological title', () => {
    const prefix = noteChunkPrefix('T'.repeat(1000));
    expect(prefix).toBe(`${'T'.repeat(MAX_TITLE_PREFIX_CHARS)}\n\n`);
  });
});

describe('chunkNote: nothing in, nothing out', () => {
  it('returns [] for an empty body, whatever the title says', () => {
    expect(chunkNote(TITLE, '')).toEqual([]);
  });

  it('returns [] for a whitespace-only body', () => {
    expect(chunkNote(TITLE, '\n\n   \t\n\n')).toEqual([]);
  });

  it('never emits an empty or whitespace-only chunk', () => {
    for (const chunk of chunkNote(TITLE, body(20))) {
      expect(chunk.text.trim()).not.toBe('');
      expect(chunk.text.slice(PREFIX.length).trim()).not.toBe('');
    }
  });
});

describe('chunkNote: the title prefix', () => {
  it('starts every chunk with the title', () => {
    const chunks = chunkNote(TITLE, body(20));
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) expect(chunk.text.startsWith(PREFIX)).toBe(true);
  });

  it('counts the title against the budget', () => {
    for (const chunk of chunkNote('T'.repeat(MAX_TITLE_PREFIX_CHARS), body(20))) {
      expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    }
  });

  it('chunks an untitled note without a prefix', () => {
    const chunks = chunkNote('', 'A single paragraph.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('A single paragraph.');
  });

  it('separates two notes whose body is identical but whose title is not', () => {
    const shared = 'We agreed to defer it until the numbers come back.';
    expect(chunkNote('Q3 Budget Review', shared)[0].contentHash).not.toBe(
      chunkNote('Offsite Retro', shared)[0].contentHash,
    );
  });
});

describe('chunkNote: determinism and stability', () => {
  it('produces identical hashes for the same input, twice', () => {
    const markdown = body(20);
    expect(chunkNote(TITLE, markdown)).toEqual(chunkNote(TITLE, markdown));
  });

  it('hashes exactly the chunk text that will be embedded', () => {
    for (const chunk of chunkNote(TITLE, body(20))) {
      expect(chunk.contentHash).toBe(contentHash(chunk.text));
    }
  });

  it('leaves every chunk before an edit unchanged', () => {
    const paragraphs = Array.from({ length: 20 }, (_unused, index) =>
      paragraph(index, 400),
    );
    const before = chunkNote(TITLE, paragraphs.join('\n\n'));
    const edited = [...paragraphs];
    edited[14] = `${edited[14]} One more clause added here.`;
    const after = chunkNote(TITLE, edited.join('\n\n'));

    const firstChanged = before.findIndex(
      (chunk, index) =>
        after[index] === undefined ||
        chunk.contentHash !== after[index].contentHash,
    );
    expect(firstChanged).toBeGreaterThan(1);
    for (let index = 0; index < firstChanged; index += 1) {
      expect(after[index]).toEqual(before[index]);
    }
  });

  it('re-embeds a bounded number of chunks for a same-length edit', () => {
    const paragraphs = Array.from({ length: 20 }, (_unused, index) =>
      paragraph(index, 400),
    );
    const before = chunkNote(TITLE, paragraphs.join('\n\n'));
    const edited = [...paragraphs];
    edited[14] = edited[14].replace('contract', 'renewals');
    expect(edited[14]).not.toBe(paragraphs[14]);
    expect(edited[14]).toHaveLength(paragraphs[14].length);

    const after = chunkNote(TITLE, edited.join('\n\n'));
    expect(after).toHaveLength(before.length);
    const changed = before.filter(
      (chunk, index) => chunk.contentHash !== after[index].contentHash,
    );
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.length).toBeLessThanOrEqual(2);
  });
});

describe('chunkNote: budget and overlap', () => {
  it('never exceeds the character budget', () => {
    for (const chunk of chunkNote(TITLE, body(40))) {
      expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    }
  });

  it('numbers chunks 0, 1, 2, ...', () => {
    const chunks = chunkNote(TITLE, body(20));
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual(
      chunks.map((_unused, index) => index),
    );
  });

  it('overlaps: each chunk opens with a suffix of its predecessor', () => {
    const chunks = chunkNote(TITLE, body(20));
    expect(chunks.length).toBeGreaterThan(3);
    for (let index = 1; index < chunks.length; index += 1) {
      const previous = chunks[index - 1].text;
      const next = chunks[index].text.slice(PREFIX.length);
      expect(sharedTail(previous, next)).toBeGreaterThan(20);
    }
  });

  it('packs several paragraphs into one chunk rather than one chunk each', () => {
    const chunks = chunkNote(TITLE, body(20, 150));
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.length).toBeLessThan(20);
  });
});

describe('chunkNote: markdown structure', () => {
  const structured = [
    '# Overview',
    '',
    paragraph(0, 300),
    '',
    '## Section Two',
    '',
    paragraph(1, 300),
    '',
    '## Section Three',
    '',
    paragraph(2, 300),
  ].join('\n');

  it('starts a new chunk at a heading', () => {
    const chunks = chunkNote(TITLE, structured);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    const bodies = chunks.map((chunk) => chunk.text.slice(PREFIX.length));
    expect(bodies[0].startsWith('# Overview')).toBe(true);
    expect(bodies.some((text) => text.startsWith('## Section Two'))).toBe(true);
    expect(bodies.some((text) => text.startsWith('## Section Three'))).toBe(true);
  });

  it('does not carry the previous section across a heading boundary', () => {
    // A heading is a topical boundary; carrying the old section's tail into the
    // new section dilutes its embedding with the subject it was written to
    // leave. So `## Section Two`'s chunk starts AT the heading.
    const chunks = chunkNote(TITLE, structured);
    const two = chunks.find((chunk) =>
      chunk.text.slice(PREFIX.length).startsWith('## Section Two'),
    );
    expect(two).toBeDefined();
    expect(two?.text).not.toContain('# Overview');
  });

  it('treats all six heading levels as breaks and ignores a non-heading hash', () => {
    for (const level of ['#', '##', '###', '####', '#####', '######']) {
      const chunks = chunkNote(TITLE, `${paragraph(0, 50)}\n\n${level} Head\n\nTail.`);
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      expect(chunks[1].text.slice(PREFIX.length).startsWith(`${level} Head`)).toBe(
        true,
      );
    }
    // Seven hashes is not a heading, and neither is a bare `#word`.
    const chunks = chunkNote(TITLE, `${paragraph(0, 50)}\n\n####### Not a heading`);
    expect(chunks).toHaveLength(1);
  });

  it('splits paragraphs on blank lines, keeping internal line breaks', () => {
    const chunks = chunkNote(TITLE, 'Line one\nline two\n\nSecond paragraph.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(
      `${PREFIX}Line one\nline two\n\nSecond paragraph.`,
    );
  });

  it('collapses runs of blank lines in the reconstructed source', () => {
    expect(noteSourceBody('One.\n\n\n\n\nTwo.')).toBe('One.\n\nTwo.');
    expect(noteSourceBody('One.\r\n\r\nTwo.')).toBe('One.\n\nTwo.');
  });
});

describe('chunkNote: fenced code blocks', () => {
  const fence = ['```ts', 'const a = 1;', '', 'const b = 2;', '```'].join('\n');

  it('never splits a fence that fits, even across its blank lines', () => {
    const chunks = chunkNote(TITLE, `${paragraph(0, 200)}\n\n${fence}\n\nAfter.`);
    const holder = chunks.filter((chunk) => chunk.text.includes('```ts'));
    expect(holder.length).toBeGreaterThan(0);
    for (const chunk of holder) expect(chunk.text).toContain(fence);
  });

  it('keeps a fence whole when it would not fit beside its neighbours', () => {
    const big = ['```', paragraph(0, 1200), '```'].join('\n');
    const chunks = chunkNote(TITLE, `${paragraph(3, 400)}\n\n${big}\n\nAfter.`);
    const holder = chunks.find((chunk) => chunk.text.includes('```'));
    expect(holder).toBeDefined();
    expect(holder?.text).toContain(big);
  });

  it('treats a tilde fence the same way, and does not close one with the other', () => {
    const tilde = ['~~~', 'a', '```', 'b', '~~~'].join('\n');
    const chunks = chunkNote(TITLE, tilde);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(`${PREFIX}${tilde}`);
  });

  it('runs an unterminated fence to the end of the note, as renderers do', () => {
    const chunks = chunkNote(TITLE, '```\nopen\n\nstill open');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(`${PREFIX}\`\`\`\nopen\n\nstill open`);
  });

  it('hard-splits a fence far larger than the budget rather than dropping it', () => {
    const huge = ['```', paragraph(0, MAX_CHUNK_CHARS * 3), '```'].join('\n');
    const chunks = chunkNote(TITLE, huge);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    }
  });
});

describe('chunkNote: source offsets', () => {
  const markdown = [
    '# Overview',
    '',
    paragraph(0, 400),
    '',
    '## Detail',
    '',
    paragraph(1, 400),
    '',
    paragraph(2, 400),
    '',
    paragraph(3, 400),
    '',
    paragraph(4, 400),
  ].join('\n');

  it('slices back to exactly the chunk text minus the title prefix', () => {
    // A note chunk carries no per-unit decoration, so its body IS a substring of
    // the reconstructed source. That makes the frame of reference assertable
    // exactly rather than approximately.
    const source = noteSourceBody(markdown);
    const chunks = chunkNote(TITLE, markdown);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(source.slice(chunk.charStart, chunk.charEnd)).toBe(
        chunk.text.slice(PREFIX.length),
      );
    }
  });

  it('keeps offsets in bounds and ordered', () => {
    const source = noteSourceBody(markdown);
    const chunks = chunkNote(TITLE, markdown);
    expect(chunks[0].charStart).toBe(0);
    expect(chunks[chunks.length - 1].charEnd).toBe(source.length);
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      expect(chunk.charStart).toBeGreaterThanOrEqual(0);
      expect(chunk.charEnd).toBeLessThanOrEqual(source.length);
      expect(chunk.charEnd).toBeGreaterThan(chunk.charStart);
      if (index > 0) {
        expect(chunk.charStart).toBeGreaterThan(chunks[index - 1].charStart);
        expect(chunk.charEnd).toBeGreaterThan(chunks[index - 1].charEnd);
      }
    }
  });

  it('puts every block wholly inside at least one chunk', () => {
    const source = noteSourceBody(markdown);
    const chunks = chunkNote(TITLE, markdown);
    for (const block of source.split('\n\n')) {
      const start = source.indexOf(block);
      const end = start + block.length;
      expect(
        chunks.some((chunk) => chunk.charStart <= start && chunk.charEnd >= end),
      ).toBe(true);
    }
  });

  it('loses no character of an oversized paragraph', () => {
    const huge = paragraph(0, MAX_CHUNK_CHARS * 3);
    const source = noteSourceBody(huge);
    const chunks = chunkNote(TITLE, huge);
    let rebuilt = '';
    for (const chunk of chunks) {
      const from = Math.max(chunk.charStart, rebuilt.length);
      expect(from).toBeLessThanOrEqual(chunk.charEnd);
      rebuilt += source.slice(from, chunk.charEnd);
    }
    expect(rebuilt).toBe(source);
  });
});
