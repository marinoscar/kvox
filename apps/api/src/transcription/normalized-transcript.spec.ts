import {
  collectSpeakers,
  endsSentence,
  FALLBACK_WORDS_PER_SEGMENT,
  MAX_SEGMENT_MS,
  partitionWords,
  splitLongSegment,
  splitLongSegments,
  type NormalizedSegment,
  type NormalizedWord,
} from './normalized-transcript';

// =============================================================================
// Segment splitting (issue #23, epic #19)
// =============================================================================
//
// THE PROPERTY THAT MATTERS MOST, AND IS ASSERTED IN EVERY SPLIT TEST BELOW:
// every input word appears in exactly one output segment, in order. A
// duplicated word makes two segments claim the same moment of audio; a dropped
// one loses transcript text with nothing anywhere to say so. Both are silent,
// and both look like a correct transcript to anything that does not compare
// against the input — which is why `expectWordsPartitioned` is applied to every
// case rather than only the interesting ones.
// =============================================================================

function word(
  text: string,
  startMs: number,
  endMs: number,
  confidence: number | null = 0.9,
): NormalizedWord {
  return { text, startMs, endMs, confidence };
}

function segmentOf(words: NormalizedWord[], speakerLabel = 'A'): NormalizedSegment {
  return {
    speakerLabel,
    startMs: words[0]?.startMs ?? 0,
    endMs: words[words.length - 1]?.endMs ?? 0,
    text: words.map((w) => w.text).join(' '),
    confidence: 0.9,
    words,
  };
}

/**
 * The invariant, as an assertion.
 *
 * Compares by IDENTITY (`toBe` on each element) rather than by value, so a
 * "split" that helpfully reconstructed equivalent word objects — and in doing
 * so silently re-timed one — still fails.
 */
function expectWordsPartitioned(
  input: NormalizedWord[],
  output: NormalizedSegment[],
) {
  const flattened = output.flatMap((segment) => segment.words);

  expect(flattened).toHaveLength(input.length);
  flattened.forEach((actual, index) => {
    expect(actual).toBe(input[index]);
  });
}

describe('endsSentence', () => {
  it.each(['done.', 'really?', 'stop!', 'well…'])(
    'treats %s as a sentence end',
    (token) => {
      expect(endsSentence(token)).toBe(true);
    },
  );

  it('looks through a closing quote or bracket after the terminator', () => {
    // `he said "stop."` — the terminator is not the last character, and a
    // naive last-character check would miss every quoted sentence in a
    // transcript of a conversation, which is most of them.
    expect(endsSentence('"stop."')).toBe(true);
    expect(endsSentence('(later.)')).toBe(true);
  });

  it('does not treat an ordinary word or a comma as a sentence end', () => {
    expect(endsSentence('however')).toBe(false);
    expect(endsSentence('however,')).toBe(false);
  });

  it('has the documented false positive on an abbreviation', () => {
    // Pinned rather than wished away. Every punctuation heuristic does this,
    // and the cost is ONE EXTRA BOUNDARY — never a lost or duplicated word,
    // which is the property that actually matters. Asserting it here means a
    // future "fix" is a deliberate choice with a failing test to change.
    expect(endsSentence('Dr.')).toBe(true);
  });
});

describe('partitionWords', () => {
  it('returns nothing for no words', () => {
    expect(partitionWords([])).toEqual([]);
  });

  it('leaves a short run in one piece', () => {
    const words = [word('hello', 0, 400), word('there.', 500, 900)];
    const runs = partitionWords(words);

    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual(words);
  });

  it('cuts at the last sentence boundary before the limit, not at the limit', () => {
    // A boundary at 30s inside a 60s run: the cut belongs at the boundary, so
    // the pieces are 30s + 30s rather than two arbitrary 30s halves that split
    // a sentence down the middle.
    const words: NormalizedWord[] = [];
    for (let i = 0; i < 60; i += 1) {
      const start = i * 1000;
      // One sentence end, at the 30-second mark.
      words.push(word(i === 29 ? 'boundary.' : `w${i}`, start, start + 900));
    }

    const runs = partitionWords(words, MAX_SEGMENT_MS);

    expect(runs.length).toBeGreaterThan(1);
    expect(runs[0][runs[0].length - 1].text).toBe('boundary.');
    expectWordsPartitioned(words, runs.map((run) => segmentOf(run)));
  });

  it('falls back to a word count when a long run has no punctuation at all', () => {
    const words: NormalizedWord[] = [];
    for (let i = 0; i < 200; i += 1) {
      const start = i * 500;
      words.push(word(`w${i}`, start, start + 450));
    }

    const runs = partitionWords(words, MAX_SEGMENT_MS, FALLBACK_WORDS_PER_SEGMENT);

    expect(runs.length).toBeGreaterThan(1);
    // The fallback is a WORD COUNT, so the first cut lands on it exactly.
    expect(runs[0]).toHaveLength(FALLBACK_WORDS_PER_SEGMENT);
    expectWordsPartitioned(words, runs.map((run) => segmentOf(run)));
  });

  it('terminates when a single word is longer than the limit', () => {
    // A stall in the provider's timings, or a mis-aligned long pause. The
    // fallback clamp is what stops the `while` from spinning forever, and this
    // is the case that proves the clamp is doing its job rather than being
    // dead code.
    const words = [
      word('interminable', 0, MAX_SEGMENT_MS * 3),
      word('next', MAX_SEGMENT_MS * 3 + 100, MAX_SEGMENT_MS * 3 + 500),
    ];

    const runs = partitionWords(words);

    expectWordsPartitioned(words, runs.map((run) => segmentOf(run)));
  });

  it('re-checks the remainder, so an early boundary cannot leave an over-long tail', () => {
    // Boundary at word 1 of a 90-second run. Cutting there leaves an ~88s
    // remainder that is ITSELF over the limit — if the check were an `if`
    // rather than a `while`, that tail would survive until the next word
    // arrived, and for the last stretch of a run it would survive entirely.
    const words: NormalizedWord[] = [word('yes.', 0, 900)];
    for (let i = 1; i < 90; i += 1) {
      words.push(word(`w${i}`, i * 1000, i * 1000 + 900));
    }

    const runs = partitionWords(words, MAX_SEGMENT_MS);

    for (const run of runs) {
      const span = run[run.length - 1].endMs - run[0].startMs;
      expect(span).toBeLessThanOrEqual(MAX_SEGMENT_MS);
    }
    expectWordsPartitioned(words, runs.map((run) => segmentOf(run)));
  });
});

describe('splitLongSegment', () => {
  it('returns a short segment unchanged, by identity', () => {
    const segment = segmentOf([word('short', 0, 500), word('enough.', 600, 900)]);

    // `toBe`, not `toEqual`: an unchanged segment must be the SAME object, so
    // nothing downstream can be relying on a copy being made.
    expect(splitLongSegment(segment)).toEqual([segment]);
    expect(splitLongSegment(segment)[0]).toBe(segment);
  });

  it('returns a long segment unchanged when it carries no words', () => {
    // Splitting a word-less segment would mean inventing timings and cutting
    // text at a character offset that corresponds to nothing the provider
    // measured. A long un-split segment is a worse editing experience; it is
    // not fiction.
    const segment: NormalizedSegment = {
      speakerLabel: 'A',
      startMs: 0,
      endMs: MAX_SEGMENT_MS * 4,
      text: 'a long stretch with no word timings at all',
      confidence: 0.8,
      words: [],
    };

    expect(splitLongSegment(segment)[0]).toBe(segment);
  });

  it('keeps the speaker label on every piece', () => {
    const words: NormalizedWord[] = [];
    for (let i = 0; i < 120; i += 1) {
      words.push(word(i % 20 === 19 ? 'end.' : `w${i}`, i * 1000, i * 1000 + 900));
    }
    const segment = segmentOf(words, 'speaker_7');

    const pieces = splitLongSegment(segment);

    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.speakerLabel).toBe('speaker_7');
    }
  });

  it('gives each piece the timings of its own first and last word', () => {
    const words: NormalizedWord[] = [];
    for (let i = 0; i < 120; i += 1) {
      words.push(word(i % 20 === 19 ? 'end.' : `w${i}`, i * 1000, i * 1000 + 900));
    }

    const pieces = splitLongSegment(segmentOf(words));

    for (const piece of pieces) {
      expect(piece.startMs).toBe(piece.words[0].startMs);
      expect(piece.endMs).toBe(piece.words[piece.words.length - 1].endMs);
    }
    // And the pieces tile the original exactly, with no gap invented and no
    // overlap.
    expect(pieces[0].startMs).toBe(words[0].startMs);
    expect(pieces[pieces.length - 1].endMs).toBe(words[words.length - 1].endMs);
  });

  it('derives each piece\'s confidence from the words that landed in it', () => {
    const words = [
      word('one', 0, 900, 0.2),
      word('two.', 1000, 1900, 0.4),
      ...Array.from({ length: 60 }, (_, i) =>
        word(`w${i}`, 2000 + i * 1000, 2900 + i * 1000, 1),
      ),
    ];

    const pieces = splitLongSegment(segmentOf(words));

    expect(pieces.length).toBeGreaterThan(1);
    // First piece is the two low-confidence words: mean 0.3, not the parent
    // segment's 0.9 and not a fabricated 1.
    expect(pieces[0].confidence).toBeCloseTo(0.3, 5);
  });

  it('reports null confidence when no word in a piece had one', () => {
    const words = Array.from({ length: 120 }, (_, i) =>
      word(i % 20 === 19 ? 'end.' : `w${i}`, i * 1000, i * 1000 + 900, null),
    );

    for (const piece of splitLongSegment(segmentOf(words))) {
      // `null`, never 0 and never 1: "the provider did not say" is a different
      // fact from "the provider was certain", and a UI dimming low-confidence
      // words must not dim on a number nobody produced.
      expect(piece.confidence).toBeNull();
    }
  });
});

describe('splitLongSegments', () => {
  it('leaves short segments alone and splits only the long one', () => {
    const short = segmentOf([word('fine.', 0, 400)]);
    const longWords = Array.from({ length: 120 }, (_, i) =>
      word(i % 20 === 19 ? 'end.' : `w${i}`, i * 1000, i * 1000 + 900),
    );
    const long = segmentOf(longWords, 'B');

    const result = splitLongSegments([short, long]);

    expect(result[0]).toBe(short);
    expect(result.length).toBeGreaterThan(2);
    expectWordsPartitioned(longWords, result.slice(1));
  });
});

describe('collectSpeakers', () => {
  it('lists distinct speakers in first-appearance order, not alphabetically', () => {
    const segments = [
      segmentOf([word('hi.', 0, 400)], 'B'),
      segmentOf([word('hello.', 500, 900)], 'A'),
      segmentOf([word('again.', 1000, 1400)], 'B'),
    ];

    // B first, because B spoke first. A UI colouring speakers wants "whoever
    // spoke first is speaker one"; alphabetical order only coincidentally
    // agrees with that, and here it does not.
    expect(collectSpeakers(segments)).toEqual([{ label: 'B' }, { label: 'A' }]);
  });

  it('returns nothing for no segments', () => {
    expect(collectSpeakers([])).toEqual([]);
  });
});
