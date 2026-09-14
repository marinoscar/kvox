// =============================================================================
// The flush cadence (issue #49, epic #45, docs/specs/notes.md §5.1)
// =============================================================================
//
// `note_generations.content` is the ONLY place a token is ever written, and a
// watching client (#52) reads that column rather than an in-process event
// stream. So every delta has to reach the row — but not every delta may reach
// it as its own `UPDATE`: a fast model emits hundreds of tokens a second, and
// one write per token turns a generation into a sustained write storm against
// Postgres for the length of the completion.
//
// The rule is therefore ~250 ms OR N tokens, WHICHEVER COMES FIRST, which
// bounds the write rate from both ends:
//
//   • the INTERVAL bounds how often a fast model can make us write (at most
//     four times a second, however many tokens arrived); and
//   • the TOKEN THRESHOLD bounds how far behind a burst can put us, so a model
//     that emits a paragraph in one chunk is not held back for a quarter of a
//     second before any of it is visible.
//
// Neither alone is enough: an interval alone makes a slow-then-bursty stream
// jerky, and a threshold alone makes a slow model's first sentence sit
// invisible in memory until enough of it accumulates.
//
// ⚠ THIS CLASS IS DELIBERATELY NOT `@Injectable` AND HOLDS NO PRISMA. It owns
// the DECISION ("should I write now?"), never the write, which is what lets a
// test drive the cadence with a fake clock and assert mid-stream behaviour
// without a database.
// =============================================================================

/** Milliseconds between flushes while tokens keep arriving. */
export const DEFAULT_FLUSH_INTERVAL_MS = 250;

/**
 * Characters that stand in for "N tokens".
 *
 * FOUR CHARACTERS PER TOKEN is the same rule of thumb `OpenAiProvider
 * .countTokens` uses, so ~64 tokens is ~256 characters. An approximation is
 * entirely adequate here: this number decides how often a row is written, and
 * being wrong by a factor of two changes a write rate, never a result.
 */
export const DEFAULT_FLUSH_CHARS = 256;

/** Reads the wall clock. Injected so a test can drive the cadence exactly. */
export type FlushClock = () => number;

export interface StreamFlusherOptions {
  intervalMs?: number;
  /** Pending characters that force a flush regardless of the interval. */
  chars?: number;
  now?: FlushClock;
}

/**
 * Decides when accumulated deltas should be written down.
 *
 * Usage is `append(text)` per delta, `shouldFlush()` to ask, and `commit()`
 * once the caller has actually written — `commit` is separate from the question
 * so a failed write does not reset the clock and silently swallow the pending
 * text.
 */
export class StreamFlusher {
  private readonly intervalMs: number;

  private readonly chars: number;

  private readonly now: FlushClock;

  /** Everything received so far — the full content, not a window. */
  private buffer = '';

  /** Characters not yet covered by a `commit()`. */
  private pending = 0;

  private lastCommitAt: number;

  constructor(options: StreamFlusherOptions = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.chars = options.chars ?? DEFAULT_FLUSH_CHARS;
    this.now = options.now ?? (() => Date.now());
    this.lastCommitAt = this.now();
  }

  /** Record one delta. Never writes anything. */
  append(text: string): void {
    if (text.length === 0) return;

    this.buffer += text;
    this.pending += text.length;
  }

  /** The full content so far — what a flush writes and what completion commits. */
  get content(): string {
    return this.buffer;
  }

  /** Characters not yet written down. */
  get pendingChars(): number {
    return this.pending;
  }

  /**
   * Is it time to write?
   *
   * FALSE WHEN NOTHING IS PENDING, always — an idle interval must not produce
   * an `UPDATE` that changes no text but still bumps `last_event_id`, which
   * would publish an SSE event carrying nothing.
   */
  shouldFlush(): boolean {
    if (this.pending === 0) return false;

    return (
      this.pending >= this.chars || this.now() - this.lastCommitAt >= this.intervalMs
    );
  }

  /**
   * Record that the pending text has been written.
   *
   * ⚠ CALL IT AFTER THE WRITE SUCCEEDS, not before. A flush that threw and had
   * already reset this counter would leave the row permanently missing that
   * text while the in-memory buffer still contained it — and the final commit
   * writes the buffer, so the note would be right and the live stream would
   * have a hole nobody could explain.
   */
  commit(): void {
    this.pending = 0;
    this.lastCommitAt = this.now();
  }
}
