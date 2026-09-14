// =============================================================================
// Word timings across an edit (issue #27, epic #19, spec §3.5)
// =============================================================================
//
// The spec's own test vector is the first case below, verbatim: `"Hello wrld"`
// with words `[{Hello,0,400},{wrld,420,700}]` corrected to `"Hello world"` keeps
// `Hello` at `{0,400}` exactly and gives `world` the `{420,700}` that `wrld`
// had, with the segment becoming `interpolated`.
// =============================================================================

import {
  LCS_CELL_BUDGET,
  foldToken,
  joinWords,
  lcsPairs,
  realignWords,
  spreadEvenly,
  splitWords,
  tokenBoundaries,
  tokenize,
  wordIndexAtCharOffset,
  worstAlignment,
} from './word-alignment';

describe('tokenize', () => {
  it.each([
    ['', []],
    ['   ', []],
    ['one', ['one']],
    ['  two   words  ', ['two', 'words']],
    ['newlines\nand\ttabs', ['newlines', 'and', 'tabs']],
  ])('tokenizes %p', (input, expected) => {
    expect(tokenize(input as string)).toEqual(expected);
  });
});

describe('foldToken', () => {
  it('ignores case and edge punctuation so an unchanged word still matches', () => {
    expect(foldToken('World,')).toBe('world');
    expect(foldToken('"quoted."')).toBe('quoted');
    expect(foldToken('José')).toBe('josé');
  });

  it('keeps interior punctuation, which is part of the word', () => {
    expect(foldToken("don't")).toBe("don't");
  });
});

describe('lcsPairs', () => {
  it('matches the unchanged tokens', () => {
    expect(lcsPairs(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual([
      [0, 0],
      [2, 2],
    ]);
  });

  it('is empty when nothing survives', () => {
    expect(lcsPairs(['a', 'b'], ['x', 'y'])).toEqual([]);
  });

  it('gives up rather than build a table past the budget', () => {
    const size = Math.ceil(Math.sqrt(LCS_CELL_BUDGET)) + 10;
    const tokens = Array.from({ length: size }, (_, index) => `w${index}`);

    expect(lcsPairs(tokens, tokens)).toBeNull();
  });
});

describe('realignWords', () => {
  it("keeps the matched word exactly and inherits the replaced word's timing", () => {
    // Spec §4.1's own test vector.
    const result = realignWords({
      oldWords: [
        { t: 'Hello', s: 0, e: 400, c: 0.99 },
        { t: 'wrld', s: 420, e: 700, c: 0.4 },
      ],
      newText: 'Hello world',
      startMs: 0,
      endMs: 700,
      previousAlignment: 'exact',
    });

    expect(result.alignment).toBe('interpolated');
    expect(result.words).toEqual([
      { t: 'Hello', s: 0, e: 400, c: 0.99 },
      // The replacement inherits the timing of the word it replaced, and loses
      // the confidence — the provider measured a DIFFERENT word.
      { t: 'world', s: 420, e: 700, c: null },
    ]);
  });

  it('leaves an unchanged segment alone, alignment included', () => {
    const oldWords = [
      { t: 'one', s: 0, e: 100, c: 0.5 },
      { t: 'two', s: 100, e: 200, c: 0.5 },
    ];

    const result = realignWords({
      oldWords,
      newText: 'one two',
      startMs: 0,
      endMs: 200,
      previousAlignment: 'exact',
    });

    expect(result.alignment).toBe('exact');
    expect(result.words).toEqual(oldWords);
  });

  it('interpolates a pure insertion between its neighbours', () => {
    const result = realignWords({
      oldWords: [
        { t: 'one', s: 0, e: 100, c: null },
        { t: 'four', s: 300, e: 400, c: null },
      ],
      newText: 'one two three four',
      startMs: 0,
      endMs: 400,
      previousAlignment: 'exact',
    });

    expect(result.alignment).toBe('interpolated');
    expect(result.words.map((word) => word.t)).toEqual(['one', 'two', 'three', 'four']);
    // `two` and `three` share the 100..300 gap evenly.
    expect(result.words[1]).toEqual({ t: 'two', s: 100, e: 200, c: null });
    expect(result.words[2]).toEqual({ t: 'three', s: 200, e: 300, c: null });
    expect(result.words[3]).toEqual({ t: 'four', s: 300, e: 400, c: null });
  });

  it('keeps the survivors when words are deleted', () => {
    const result = realignWords({
      oldWords: [
        { t: 'one', s: 0, e: 100, c: null },
        { t: 'two', s: 100, e: 200, c: null },
        { t: 'three', s: 200, e: 300, c: null },
      ],
      newText: 'one three',
      startMs: 0,
      endMs: 300,
      previousAlignment: 'exact',
    });

    expect(result.alignment).toBe('interpolated');
    expect(result.words).toEqual([
      { t: 'one', s: 0, e: 100, c: null },
      { t: 'three', s: 200, e: 300, c: null },
    ]);
  });

  it('falls back to an even spread for a full retype', () => {
    const result = realignWords({
      oldWords: [
        { t: 'alpha', s: 0, e: 500, c: null },
        { t: 'beta', s: 500, e: 1000, c: null },
      ],
      newText: 'completely different words here',
      startMs: 0,
      endMs: 1000,
      previousAlignment: 'exact',
    });

    expect(result.alignment).toBe('none');
    expect(result.words).toEqual([
      { t: 'completely', s: 0, e: 250, c: null },
      { t: 'different', s: 250, e: 500, c: null },
      { t: 'words', s: 500, e: 750, c: null },
      { t: 'here', s: 750, e: 1000, c: null },
    ]);
  });

  it('answers `none` when the provider emitted no timings at all', () => {
    const result = realignWords({
      oldWords: [],
      newText: 'two words',
      startMs: 0,
      endMs: 1000,
      previousAlignment: 'exact',
    });

    expect(result.alignment).toBe('none');
    expect(result.words).toHaveLength(2);
  });

  it('answers no words at all for text that is entirely whitespace', () => {
    const result = realignWords({
      oldWords: [{ t: 'a', s: 0, e: 1, c: null }],
      newText: '   ',
      startMs: 0,
      endMs: 1,
      previousAlignment: 'exact',
    });

    expect(result).toEqual({ words: [], alignment: 'none' });
  });
});

describe('splitWords', () => {
  const words = [
    { t: 'a', s: 0, e: 100, c: null },
    { t: 'b', s: 100, e: 200, c: null },
    { t: 'c', s: 200, e: 300, c: null },
    { t: 'd', s: 300, e: 400, c: null },
  ];

  it('divides at the index, keeping every original timing', () => {
    const [first, second] = splitWords(words, 2, 4);

    expect(first).toEqual(words.slice(0, 2));
    expect(second).toEqual(words.slice(2));
  });

  it('scales the index when the array no longer lines up with the text', () => {
    // Six text tokens over four word timings: splitting at token 3 is half way.
    const [first, second] = splitWords(words, 3, 6);

    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
  });

  it('is two empty halves for a segment with no timings', () => {
    expect(splitWords([], 1, 2)).toEqual([[], []]);
  });
});

describe('joinWords / worstAlignment', () => {
  it('lays two arrays end to end', () => {
    expect(joinWords([{ t: 'a', s: 0, e: 1, c: null }], [{ t: 'b', s: 1, e: 2, c: null }])).toEqual([
      { t: 'a', s: 0, e: 1, c: null },
      { t: 'b', s: 1, e: 2, c: null },
    ]);
  });

  it.each([
    ['exact', 'exact', 'exact'],
    ['exact', 'interpolated', 'interpolated'],
    ['interpolated', 'none', 'none'],
    ['none', 'exact', 'none'],
  ])('worstAlignment(%s, %s) is %s', (a, b, expected) => {
    expect(worstAlignment(a as never, b as never)).toBe(expected);
  });
});

describe('spreadEvenly', () => {
  it('is empty for no tokens', () => {
    expect(spreadEvenly([], 0, 100)).toEqual([]);
  });

  it('never produces a negative span', () => {
    expect(spreadEvenly(['a'], 500, 100)).toEqual([{ t: 'a', s: 500, e: 500, c: null }]);
  });
});

describe('tokenBoundaries / wordIndexAtCharOffset', () => {
  it('reports one boundary per token plus the end of the string', () => {
    expect(tokenBoundaries('one two three')).toEqual([0, 4, 8, 13]);
  });

  it.each([
    [0, 0],
    // The caret at the end of "one" is nearer the boundary BEFORE "two" than
    // the one before "one", so it snaps forward — which is what a user who
    // clicked just after a word means.
    [3, 1],
    [5, 1],
    [9, 2],
    [13, 3],
  ])('offset %i snaps to word index %i', (offset, expected) => {
    expect(wordIndexAtCharOffset('one two three', offset)).toBe(expected);
  });
});
