// =============================================================================
// The flush cadence (issue #49, docs/specs/notes.md §5.1)
// =============================================================================
//
// ~250 ms OR N tokens, whichever comes first. Both halves are asserted because
// dropping either one has a real, opposite failure mode: without the interval a
// slow model's first sentence sits invisible in memory; without the token
// threshold a fast model writes the same row hundreds of times a second.
// =============================================================================

import {
  DEFAULT_FLUSH_CHARS,
  DEFAULT_FLUSH_INTERVAL_MS,
  StreamFlusher,
} from './stream-flusher';

describe('StreamFlusher', () => {
  let now = 1_000;
  const clock = (): number => now;

  beforeEach(() => {
    now = 1_000;
  });

  it('does not ask for a flush when nothing is pending', () => {
    const flusher = new StreamFlusher({ now: clock });

    now += DEFAULT_FLUSH_INTERVAL_MS * 10;

    expect(flusher.shouldFlush()).toBe(false);
  });

  it('flushes once the interval has passed, however little arrived', () => {
    const flusher = new StreamFlusher({ now: clock });

    flusher.append('a');
    expect(flusher.shouldFlush()).toBe(false);

    now += DEFAULT_FLUSH_INTERVAL_MS;
    expect(flusher.shouldFlush()).toBe(true);
  });

  it('flushes on the character threshold before the interval elapses', () => {
    const flusher = new StreamFlusher({ now: clock });

    flusher.append('x'.repeat(DEFAULT_FLUSH_CHARS));

    expect(flusher.shouldFlush()).toBe(true);
  });

  it('accumulates the whole content, not a window of it', () => {
    const flusher = new StreamFlusher({ now: clock });

    flusher.append('one ');
    flusher.commit();
    flusher.append('two');

    expect(flusher.content).toBe('one two');
  });

  it('resets the pending counter and the clock only on commit', () => {
    const flusher = new StreamFlusher({ now: clock });

    flusher.append('x'.repeat(DEFAULT_FLUSH_CHARS));
    expect(flusher.pendingChars).toBe(DEFAULT_FLUSH_CHARS);

    // Asking twice must not change anything — the question is not the answer.
    expect(flusher.shouldFlush()).toBe(true);
    expect(flusher.shouldFlush()).toBe(true);

    flusher.commit();

    expect(flusher.pendingChars).toBe(0);
    expect(flusher.shouldFlush()).toBe(false);
  });

  it('keeps pending text when a flush was NOT committed (a failed write)', () => {
    const flusher = new StreamFlusher({ now: clock });

    flusher.append('x'.repeat(DEFAULT_FLUSH_CHARS));
    // The caller's write threw; it never called commit().
    expect(flusher.shouldFlush()).toBe(true);
    expect(flusher.content.length).toBe(DEFAULT_FLUSH_CHARS);
  });

  it('ignores an empty delta', () => {
    const flusher = new StreamFlusher({ now: clock });

    flusher.append('');

    expect(flusher.pendingChars).toBe(0);
    expect(flusher.shouldFlush()).toBe(false);
  });
});
