// =============================================================================
// Literal find & replace (issue #27, epic #19, spec §4.2)
// =============================================================================
//
// The case that motivates the whole file is `'José'`: a `\b`-based whole-word
// search cannot see `é` as a letter, so it happily reports a whole-word hit for
// `"os"` inside a name. That test is the reason `find-matcher.ts` reads code
// points against `\p{L}\p{N}\p{M}_` instead.
// =============================================================================

import { findMatches, matchPreview, replaceMatches } from './find-matcher';

describe('findMatches', () => {
  const cases: Array<{
    name: string;
    text: string;
    find: string;
    options?: { matchCase?: boolean; wholeWord?: boolean };
    expected: Array<[number, number]>;
  }> = [
    {
      name: 'finds every occurrence, case-insensitively by default',
      text: 'Kvox and kvox and KVOX',
      find: 'kvox',
      expected: [
        [0, 4],
        [9, 13],
        [18, 22],
      ],
    },
    {
      name: 'respects matchCase',
      text: 'Kvox and kvox and KVOX',
      find: 'kvox',
      options: { matchCase: true },
      expected: [[9, 13]],
    },
    {
      name: 'wholeWord refuses a hit inside a longer word',
      text: 'the cat concatenated',
      find: 'cat',
      options: { wholeWord: true },
      expected: [[4, 7]],
    },
    {
      name: 'wholeWord is Unicode-aware: "os" is not a whole word inside "José"',
      // A naive `\b` boundary classifies `é` as a non-word character and would
      // report a match here. This is THE regression this implementation exists
      // to prevent.
      text: 'José said so',
      find: 'os',
      options: { wholeWord: true },
      expected: [],
    },
    {
      name: 'wholeWord still matches a word ending in a non-ASCII letter',
      text: 'we met José yesterday',
      find: 'josé',
      options: { wholeWord: true },
      expected: [[7, 11]],
    },
    {
      name: 'a hit at the very start and very end of the string is whole-word',
      text: 'cat sat on a cat',
      find: 'cat',
      options: { wholeWord: true },
      expected: [
        [0, 3],
        [13, 16],
      ],
    },
    {
      name: 'punctuation counts as a boundary',
      text: 'the cat, the cat.',
      find: 'cat',
      options: { wholeWord: true },
      expected: [
        [4, 7],
        [13, 16],
      ],
    },
    {
      name: 'matches are non-overlapping, left to right',
      text: 'aaaa',
      find: 'aa',
      expected: [
        [0, 2],
        [2, 4],
      ],
    },
    {
      name: 'an empty needle matches nothing',
      text: 'anything',
      find: '',
      expected: [],
    },
    {
      name: 'a needle longer than the haystack matches nothing',
      text: 'ab',
      find: 'abc',
      expected: [],
    },
    {
      name: 'never treats the needle as a pattern',
      // The single most important assertion in the file: `.*` is three literal
      // characters, not "everything". A regex implementation would return one
      // enormous match here.
      text: 'a.*b and a literal .* here',
      find: '.*',
      expected: [
        [1, 3],
        [19, 21],
      ],
    },
    {
      name: 'a hostile "pattern" is just text',
      text: '(a+)+$ appears once',
      find: '(a+)+$',
      expected: [[0, 6]],
    },
    {
      name: 'an astral code point is one word character, not two surrogates',
      text: '𝒜bc and bc',
      find: 'bc',
      options: { wholeWord: true },
      expected: [[9, 11]],
    },
  ];

  it.each(cases)('$name', ({ text, find, options, expected }) => {
    expect(findMatches(text, find, options).map((m) => [m.start, m.end])).toEqual(expected);
  });
});

describe('replaceMatches', () => {
  it('replaces every hit and reports the count', () => {
    const result = replaceMatches('Kvox and kvox', 'kvox', 'KVox');

    expect(result).toEqual({ text: 'KVox and KVox', count: 2 });
  });

  it('returns the input untouched when nothing matched', () => {
    const text = 'nothing here';

    expect(replaceMatches(text, 'absent', 'x')).toEqual({ text, count: 0 });
  });

  it('honours wholeWord when replacing', () => {
    expect(
      replaceMatches('cat concatenate cat', 'cat', 'dog', { wholeWord: true }),
    ).toEqual({ text: 'dog concatenate dog', count: 2 });
  });

  it('does not re-scan its own output', () => {
    // A naive loop that replaced and restarted would expand forever here.
    expect(replaceMatches('a', 'a', 'aa')).toEqual({ text: 'aa', count: 1 });
  });

  it('keeps offsets correct when a fold is not length-preserving', () => {
    // `'İ'.toLowerCase()` is two code units. Lower-casing the whole haystack in
    // one pass would shift every later offset; comparing per character does not.
    const text = 'İstanbul and stanbul';
    const result = replaceMatches(text, 'stanbul', 'STANBUL');

    expect(result.count).toBe(2);
    expect(result.text).toBe('İSTANBUL and STANBUL');
  });
});

describe('matchPreview', () => {
  it('adds ellipses only where text was actually cut', () => {
    expect(matchPreview('short text', { start: 0, end: 5 })).toBe('short text');
  });

  it('trims a long segment around the hit', () => {
    const text = `${'x'.repeat(100)}needle${'y'.repeat(100)}`;
    const preview = matchPreview(text, { start: 100, end: 106 }, 10);

    expect(preview).toBe(`…${'x'.repeat(10)}needle${'y'.repeat(10)}…`);
  });
});
