import { describe, it, expect } from 'vitest';

import {
  INTERVAL_MERGE_GAP_MS,
  buildIntervals,
  findSegmentIndexAt,
  findWordIndexAt,
  formatDuration,
  formatTimestamp,
  intervalIndexAt,
  nextIntervalIndexFrom,
  resolveSeekTarget,
  toMs,
  toSeconds,
} from '../../utils/playbackIntervals';

/**
 * The arithmetic behind per-speaker playback, checked as a table of numbers.
 *
 * These functions exist as a separate module precisely so this suite can be
 * this boring: the engine that consumes them owns an `HTMLAudioElement` and a
 * `requestAnimationFrame` loop, and everything here is pure.
 */

const range = (startMs: number, endMs: number) => ({ startMs, endMs });

describe('buildIntervals — merging (spec §7.2)', () => {
  it('merges two ranges separated by less than the 300ms threshold', () => {
    // The case the threshold exists for: diarization leaves a breath between
    // two segments of one continuous thought, and seeking across it is audible
    // as a stutter rather than as filtering.
    expect(buildIntervals([range(0, 1000), range(1200, 2000)])).toEqual([
      { startMs: 0, endMs: 2000 },
    ]);
  });

  it('merges a gap of EXACTLY 300ms, and splits at 301ms', () => {
    // The boundary is inclusive (`<= gapMs`), and the pair of assertions is
    // what pins that down — either alone passes under an off-by-one.
    expect(buildIntervals([range(0, 1000), range(1000 + INTERVAL_MERGE_GAP_MS, 2000)])).toEqual([
      { startMs: 0, endMs: 2000 },
    ]);
    expect(
      buildIntervals([range(0, 1000), range(1001 + INTERVAL_MERGE_GAP_MS, 2000)]),
    ).toEqual([
      { startMs: 0, endMs: 1000 },
      { startMs: 1301, endMs: 2000 },
    ]);
  });

  it('keeps a genuine multi-second silence as two intervals', () => {
    expect(buildIntervals([range(0, 1000), range(9000, 10_000)])).toEqual([
      { startMs: 0, endMs: 1000 },
      { startMs: 9000, endMs: 10_000 },
    ]);
  });

  it('sorts by start before merging, so reading order need not be time order', () => {
    // `ordinal` is a gap-based float precisely so an inserted segment does not
    // renumber its neighbours — which means an edited transcript can hand this
    // function ranges out of time order.
    expect(buildIntervals([range(5000, 6000), range(0, 1000)])).toEqual([
      { startMs: 0, endMs: 1000 },
      { startMs: 5000, endMs: 6000 },
    ]);
  });

  it('does not let a fully contained range SHORTEN the interval it merges into', () => {
    // `Math.max`, not assignment. Without it the interval would end at 1200
    // and the engine would seek away mid-sentence.
    expect(buildIntervals([range(0, 10_000), range(1000, 1200)])).toEqual([
      { startMs: 0, endMs: 10_000 },
    ]);
  });

  it('drops zero-length and inverted ranges', () => {
    // A window the engine could never leave: "have we passed the end" is true
    // on the frame it seeks in, so it would seek to the same place forever.
    expect(buildIntervals([range(1000, 1000), range(2000, 1500), range(3000, 4000)])).toEqual(
      [{ startMs: 3000, endMs: 4000 }],
    );
  });

  it('answers an empty list for an empty selection', () => {
    expect(buildIntervals([])).toEqual([]);
  });
});

describe('intervalIndexAt / nextIntervalIndexFrom', () => {
  const intervals = buildIntervals([range(0, 1000), range(5000, 6000), range(9000, 10_000)]);

  it('is half-open: the start is inside, the end is not', () => {
    expect(intervalIndexAt(intervals, 0)).toBe(0);
    expect(intervalIndexAt(intervals, 999)).toBe(0);
    expect(intervalIndexAt(intervals, 1000)).toBe(-1);
  });

  it('answers -1 in a gap and past the last interval', () => {
    expect(intervalIndexAt(intervals, 2500)).toBe(-1);
    expect(intervalIndexAt(intervals, 99_999)).toBe(-1);
  });

  it('finds the FIRST interval starting at or after a position', () => {
    expect(nextIntervalIndexFrom(intervals, 0)).toBe(0);
    expect(nextIntervalIndexFrom(intervals, 1)).toBe(1);
    expect(nextIntervalIndexFrom(intervals, 5000)).toBe(1);
    expect(nextIntervalIndexFrom(intervals, 5001)).toBe(2);
  });

  it('answers -1 past the last interval', () => {
    expect(nextIntervalIndexFrom(intervals, 10_000)).toBe(-1);
  });
});

describe('resolveSeekTarget — seeking outside an interval snaps forward', () => {
  const intervals = buildIntervals([range(0, 1000), range(5000, 6000)]);

  it('leaves an in-window position alone', () => {
    // Snapping here would make scrubbing inside one speaker's long monologue
    // impossible.
    expect(resolveSeekTarget(intervals, 500)).toBe(500);
  });

  it('snaps a gap position FORWARD to the next interval start', () => {
    expect(resolveSeekTarget(intervals, 2500)).toBe(5000);
  });

  it('answers null past the last interval — the engine reads that as "stop"', () => {
    expect(resolveSeekTarget(intervals, 7000)).toBeNull();
  });

  it('treats an EMPTY interval list as no filter at all', () => {
    // Not `null`: an empty selection means the whole recording is playable, and
    // answering "stop" would make clearing a filter un-playable.
    expect(resolveSeekTarget([], 7000)).toBe(7000);
  });
});

describe('findSegmentIndexAt — the binary search', () => {
  const segments = [range(0, 1000), range(1000, 2000), range(5000, 6000)];

  it('finds the segment containing the position, half-open', () => {
    expect(findSegmentIndexAt(segments, 0)).toBe(0);
    expect(findSegmentIndexAt(segments, 999)).toBe(0);
    expect(findSegmentIndexAt(segments, 1000)).toBe(1);
    expect(findSegmentIndexAt(segments, 5500)).toBe(2);
  });

  it('answers -1 in the silence between segments, rather than rounding', () => {
    // Highlighting the nearer speaker while nobody is talking would be a lie
    // the reader has no way to check.
    expect(findSegmentIndexAt(segments, 3000)).toBe(-1);
    expect(findSegmentIndexAt(segments, 99_999)).toBe(-1);
  });

  it('agrees with a linear scan across a 6,000-segment fixture', () => {
    // The benchmark size issue #30 names. A binary search that is subtly wrong
    // at one boundary is invisible in a three-element table and obvious here.
    const many = Array.from({ length: 6000 }, (_, index) =>
      range(index * 1000, index * 1000 + 800),
    );
    const linear = (positionMs: number) =>
      many.findIndex((s) => positionMs >= s.startMs && positionMs < s.endMs);

    for (const position of [0, 799, 800, 999, 1000, 2_999_999, 5_999_500, 5_999_999]) {
      expect(findSegmentIndexAt(many, position), `at ${position}`).toBe(linear(position));
    }
  });
});

describe('findWordIndexAt', () => {
  const words = [
    { s: 0, e: 300 },
    { s: 300, e: 700 },
    { s: 900, e: 1200 },
  ];

  it('finds the word under the playhead, half-open', () => {
    expect(findWordIndexAt(words, 0)).toBe(0);
    expect(findWordIndexAt(words, 300)).toBe(1);
    expect(findWordIndexAt(words, 700)).toBe(-1);
    expect(findWordIndexAt(words, 1000)).toBe(2);
  });
});

describe('unit conversion', () => {
  it('round-trips between the element seconds and our milliseconds', () => {
    expect(toMs(1.5)).toBe(1500);
    expect(toSeconds(1500)).toBe(1.5);
    // `currentTime` is a float; rounding is what stops a position from
    // oscillating either side of a boundary.
    expect(toMs(1.0004)).toBe(1000);
  });
});

describe('formatTimestamp', () => {
  it('drops the hour segment below an hour', () => {
    expect(formatTimestamp(0)).toBe('0:00');
    expect(formatTimestamp(65_000)).toBe('1:05');
    expect(formatTimestamp(599_000)).toBe('9:59');
  });

  it('shows hours past an hour, with zero-padded minutes', () => {
    expect(formatTimestamp(3_600_000)).toBe('1:00:00');
    expect(formatTimestamp(3_723_000)).toBe('1:02:03');
  });

  it('clamps nonsense to zero rather than rendering it', () => {
    expect(formatTimestamp(-5)).toBe('0:00');
    expect(formatTimestamp(Number.NaN)).toBe('0:00');
  });
});

describe('formatDuration', () => {
  it('reads as a spoken length, not as a clock face', () => {
    expect(formatDuration(45_000)).toBe('45 sec');
    expect(formatDuration(600_000)).toBe('10 min');
    expect(formatDuration(3_600_000)).toBe('1 hr');
    expect(formatDuration(4_320_000)).toBe('1 hr 12 min');
  });

  it('answers an em dash for an unknown duration', () => {
    // `durationMs` is legitimately null on a transcript that has not been
    // processed yet, and "0 sec" would be a claim about a recording nobody has
    // measured.
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(undefined)).toBe('—');
  });
});
