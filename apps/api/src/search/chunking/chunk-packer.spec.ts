// =============================================================================
// The shared packer (issue #186, epic #165)
// =============================================================================
//
// `transcript-chunker.spec.ts` and `note-chunker.spec.ts` exercise this through
// real documents. These tests drive it directly, with tiny budgets, so that the
// boundary rules are pinned in isolation rather than inferred from a 20-chunk
// transcript where one off-by-one would not be visible.
// =============================================================================

import { ChunkUnit, overlapCut, packChunks } from './chunk-packer';
import { contentHash } from './content-hash';

/** Units over a source body of `texts` joined by `separator`. */
const unitsOf = (
  texts: readonly string[],
  separator = '\n',
  decorations: readonly string[] = [],
  breaks: readonly boolean[] = [],
): ChunkUnit[] => {
  const units: ChunkUnit[] = [];
  let offset = 0;
  texts.forEach((text, index) => {
    const preceding = index === 0 ? '' : separator;
    offset += preceding.length;
    units.push({
      source: text,
      sourceStart: offset,
      decoration: decorations[index] ?? '',
      precedingSeparator: preceding,
      breakBefore: breaks[index] ?? false,
    });
    offset += text.length;
  });
  return units;
};

const options = (over: Partial<Parameters<typeof packChunks>[1]> = {}) => ({
  prefix: '',
  maxChars: 40,
  overlapChars: 8,
  sentenceLookaheadChars: 10,
  ...over,
});

describe('overlapCut', () => {
  it('returns no overlap for a body too short to halve', () => {
    expect(overlapCut('', 8, 10)).toBe(0);
    expect(overlapCut('a', 8, 10)).toBe(1);
  });

  it('caps the overlap at half the body, so a chunk is never duplicated whole', () => {
    // 'abcdefgh' with a budget of 8 would otherwise carry the entire chunk.
    expect(overlapCut('abcdefgh', 8, 0)).toBe(4);
  });

  it('takes a hard character cut when no boundary is in the window', () => {
    const body = 'x'.repeat(100);
    expect(overlapCut(body, 8, 10)).toBe(92);
  });

  it('prefers a sentence boundary found forward of the raw cut', () => {
    // Raw cut lands at index 92; the '.' at 95 is inside the lookahead, so the
    // overlap starts after it and its trailing space.
    const body = `${'x'.repeat(95)}. tail here`;
    expect(overlapCut(body, 14, 10)).toBe(97);
  });

  it('never lengthens the overlap: the search runs forward only', () => {
    const body = `head. ${'x'.repeat(100)}`;
    const cut = overlapCut(body, 8, 10);
    expect(body.length - cut).toBeLessThanOrEqual(8);
  });

  it('treats a newline as a boundary', () => {
    const body = `${'x'.repeat(95)}\nnext line`;
    expect(overlapCut(body, 14, 10)).toBe(96);
  });

  it('does not treat a decimal point as a sentence end', () => {
    // '.' only ends a sentence when whitespace or the end of text follows it.
    const body = `${'x'.repeat(92)}3.14159265`;
    expect(overlapCut(body, 10, 10)).toBe(92);
  });
});

describe('packChunks', () => {
  it('returns [] for no units', () => {
    expect(packChunks([], options())).toEqual([]);
  });

  it('packs what fits into one chunk and hashes the final text', () => {
    const chunks = packChunks(unitsOf(['alpha', 'beta']), options());
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({
      ordinal: 0,
      text: 'alpha\nbeta',
      contentHash: contentHash('alpha\nbeta'),
      charStart: 0,
      charEnd: 10,
    });
  });

  it('applies the prefix to every chunk and charges it to the budget', () => {
    const chunks = packChunks(
      unitsOf(['aaaa', 'bbbb', 'cccc', 'dddd']),
      options({ prefix: 'T: ', maxChars: 14, overlapChars: 2 }),
    );
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.startsWith('T: ')).toBe(true);
      expect(chunk.text.length).toBeLessThanOrEqual(14);
    }
  });

  it('never exceeds the budget however the units fall', () => {
    const texts = Array.from({ length: 30 }, (_unused, index) =>
      'w'.repeat((index % 7) + 1),
    );
    for (const chunk of packChunks(unitsOf(texts), options())) {
      expect(chunk.text.length).toBeLessThanOrEqual(40);
    }
  });

  it('emits decoration on a change and at the head of each chunk, never between', () => {
    const chunks = packChunks(
      unitsOf(
        ['one', 'two', 'three', 'four'],
        '\n',
        ['A: ', 'A: ', 'B: ', 'B: '],
      ),
      options({ maxChars: 200 }),
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('A: one\ntwo\nB: three\nfour');
  });

  it('re-states decoration after a chunk boundary', () => {
    const texts = Array.from({ length: 8 }, () => 'w'.repeat(12));
    const chunks = packChunks(
      unitsOf(texts, '\n', texts.map(() => 'A: ')),
      options({ maxChars: 40, overlapChars: 4 }),
    );
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) expect(chunk.text).toContain('A: ');
  });

  it('breaks before a unit that asks for it, and drops the overlap there', () => {
    const chunks = packChunks(
      unitsOf(
        ['alpha beta', 'HEADING', 'gamma delta'],
        '\n',
        [],
        [false, true, false],
      ),
      options({ maxChars: 200 }),
    );
    expect(chunks).toHaveLength(2);
    expect(chunks[0].text).toBe('alpha beta');
    expect(chunks[1].text).toBe('HEADING\ngamma delta');
  });

  it('does not open with a break when the break is the first unit', () => {
    const chunks = packChunks(
      unitsOf(['HEADING', 'body'], '\n', [], [true, false]),
      options({ maxChars: 200 }),
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('HEADING\nbody');
  });

  it('carries overlap as a genuine suffix of the previous chunk', () => {
    const texts = Array.from({ length: 10 }, (_unused, index) =>
      `s${index}-${'w'.repeat(10)}`,
    );
    const chunks = packChunks(unitsOf(texts), options({ overlapChars: 10 }));
    expect(chunks.length).toBeGreaterThan(2);
    for (let index = 1; index < chunks.length; index += 1) {
      const previous = chunks[index - 1].text;
      const next = chunks[index].text;
      const shared = (() => {
        for (let length = Math.min(previous.length, next.length); length > 0; length -= 1) {
          if (previous.endsWith(next.slice(0, length))) return length;
        }
        return 0;
      })();
      expect(shared).toBeGreaterThan(0);
    }
  });

  it('never opens a chunk with a fragment of a decoration', () => {
    // The overlap cut is snapped back out of a decoration, so a chunk starting
    // inside 'Speaker A: ' starts at the 'S' instead of at 'eaker A: '.
    const texts = Array.from({ length: 12 }, (_unused, index) =>
      `line ${index} ${'w'.repeat(8)}`,
    );
    const chunks = packChunks(
      unitsOf(
        texts,
        '\n',
        texts.map((_unused, index) => `S${index % 3}: `),
      ),
      options({ maxChars: 60, overlapChars: 14 }),
    );
    for (const chunk of chunks) {
      expect(chunk.text).not.toMatch(/^[0-9]?: /);
      expect(chunk.text.trim()).not.toBe('');
    }
  });

  it('hard-splits an oversized unit instead of dropping it', () => {
    const wall = 'x'.repeat(200);
    const chunks = packChunks(unitsOf([wall]), options({ maxChars: 40 }));
    expect(chunks.length).toBeGreaterThan(4);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(40);
    }
    expect(chunks[0].charStart).toBe(0);
    expect(chunks[chunks.length - 1].charEnd).toBe(200);
  });

  it('prefers whitespace when hard-splitting, without losing a character', () => {
    const words = Array.from({ length: 40 }, (_unused, index) => `w${index}`).join(' ');
    const chunks = packChunks(
      unitsOf([words]),
      options({ maxChars: 40, overlapChars: 6 }),
    );
    let rebuilt = '';
    for (const chunk of chunks) {
      rebuilt += words.slice(Math.max(chunk.charStart, rebuilt.length), chunk.charEnd);
    }
    expect(rebuilt).toBe(words);
  });

  it('numbers chunks 0, 1, 2, ... in emission order', () => {
    const texts = Array.from({ length: 20 }, () => 'w'.repeat(12));
    const chunks = packChunks(unitsOf(texts), options());
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual(
      chunks.map((_unused, index) => index),
    );
  });

  it('keeps chunk text equal to the source slice when there is no decoration', () => {
    const texts = Array.from({ length: 20 }, (_unused, index) =>
      `part${index}-${'w'.repeat(9)}`,
    );
    const source = texts.join('\n');
    for (const chunk of packChunks(unitsOf(texts), options())) {
      expect(source.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.text);
    }
  });

  it('survives a prefix wider than the budget without crashing or looping', () => {
    const chunks = packChunks(
      unitsOf(['alpha', 'beta']),
      options({ prefix: 'P'.repeat(50), maxChars: 40 }),
    );
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) expect(chunk.text.trim()).not.toBe('');
  });
});
