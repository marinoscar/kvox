import {
  firstPollDelayMs,
  isPastPollDeadline,
  MAX_POLL_DELAY_MS,
  MIN_POLL_DEADLINE_MS,
  MIN_POLL_DELAY_MS,
  nextPollDelayMs,
  pollDeadline,
} from './poll-schedule';

// =============================================================================
// The poll schedule — the arithmetic the spec fixes (issue #25, §1.5.3)
// =============================================================================
//
// Every case here is a number the spec states rather than one this
// implementation happens to produce: `clamp(duration × 0.05, 30s, 5m)`, `× 1.5`
// to a 5-minute cap, and `submittedAt + max(6h, 3 × duration)`. A change that
// "tidies" one of them has to change this file, which is where the argument
// for each number is available to read.
// =============================================================================

describe('firstPollDelayMs', () => {
  it('is five percent of the recording, between the two clamps', () => {
    // 20 minutes -> 60s, comfortably inside [30s, 5m].
    expect(firstPollDelayMs(20 * 60_000)).toBe(60_000);
  });

  it('never dips below 30 seconds, however short the clip', () => {
    // A 10-second voice memo: 5% is 500ms, which would be a poll storm.
    expect(firstPollDelayMs(10_000)).toBe(MIN_POLL_DELAY_MS);
  });

  it('never exceeds five minutes, however long the recording', () => {
    // A ten-hour recording: 5% is 30 minutes, which would leave the first
    // check half an hour after a job that may already be done.
    expect(firstPollDelayMs(10 * 60 * 60_000)).toBe(MAX_POLL_DELAY_MS);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['zero', 0],
    ['negative', -5],
    ['NaN', Number.NaN],
  ] as Array<[string, number | null | undefined]>)(
    'falls back to the floor for a %s duration — unknown length polls as if short',
    (_label, value) => {
      expect(firstPollDelayMs(value)).toBe(MIN_POLL_DELAY_MS);
    },
  );
});

describe('nextPollDelayMs', () => {
  it('multiplies the previous delay by 1.5', () => {
    expect(nextPollDelayMs(60_000)).toBe(90_000);
    expect(nextPollDelayMs(90_000)).toBe(135_000);
  });

  it('caps at five minutes rather than growing without bound', () => {
    expect(nextPollDelayMs(4 * 60_000)).toBe(MAX_POLL_DELAY_MS);
    expect(nextPollDelayMs(MAX_POLL_DELAY_MS)).toBe(MAX_POLL_DELAY_MS);
  });

  it('climbs the whole schedule from the floor without ever going backwards', () => {
    const schedule: number[] = [];
    let delay = MIN_POLL_DELAY_MS;

    for (let i = 0; i < 10; i += 1) {
      delay = nextPollDelayMs(delay);
      schedule.push(delay);
    }

    expect(schedule).toEqual([
      45_000, 67_500, 101_250, 151_875, 227_813, 300_000, 300_000, 300_000, 300_000,
      300_000,
    ]);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['negative', -1],
  ] as Array<[string, number | null | undefined]>)(
    'restarts at the floor for a %s previous delay rather than producing NaN',
    (_label, value) => {
      // A NaN here would become a `scheduledFor` of Invalid Date, and a job
      // nothing ever claims.
      expect(nextPollDelayMs(value)).toBe(MIN_POLL_DELAY_MS);
    },
  );
});

describe('pollDeadline', () => {
  const submittedAt = new Date('2026-01-01T00:00:00.000Z');

  it('is six hours for a short recording', () => {
    expect(pollDeadline(submittedAt, 5 * 60_000).getTime()).toBe(
      submittedAt.getTime() + MIN_POLL_DEADLINE_MS,
    );
  });

  it('is three times the duration once that exceeds six hours', () => {
    const fourHours = 4 * 60 * 60_000;

    expect(pollDeadline(submittedAt, fourHours).getTime()).toBe(
      submittedAt.getTime() + 12 * 60 * 60_000,
    );
  });

  it('falls back to six hours when the duration is unknown', () => {
    expect(pollDeadline(submittedAt, null).getTime()).toBe(
      submittedAt.getTime() + MIN_POLL_DEADLINE_MS,
    );
  });
});

describe('isPastPollDeadline', () => {
  const submittedAt = new Date('2026-01-01T00:00:00.000Z');

  it('is false right up to the deadline instant', () => {
    const at = new Date(submittedAt.getTime() + MIN_POLL_DEADLINE_MS);

    expect(isPastPollDeadline(submittedAt, null, at)).toBe(false);
  });

  it('is true one millisecond after it', () => {
    const at = new Date(submittedAt.getTime() + MIN_POLL_DEADLINE_MS + 1);

    expect(isPastPollDeadline(submittedAt, null, at)).toBe(true);
  });

  it('gives a long recording the longer window', () => {
    const fourHours = 4 * 60 * 60_000;
    const sevenHoursIn = new Date(submittedAt.getTime() + 7 * 60 * 60_000);

    // Past the 6h floor, but well inside 3 x 4h = 12h.
    expect(isPastPollDeadline(submittedAt, null, sevenHoursIn)).toBe(true);
    expect(isPastPollDeadline(submittedAt, fourHours, sevenHoursIn)).toBe(false);
  });
});
