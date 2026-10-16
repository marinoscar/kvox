// =============================================================================
// The answer hold rule (issue #378; docs/specs/ontology.md §21.3/§21.4)
// =============================================================================
//
// PURE. One instance per MODEL CALL. A tool-calling model often says something
// before it calls a tool ("Let me look up Acme…"). That text is not the answer,
// and `ask_messages.content` is APPEND-ONLY under a connected reader (the SSE
// offset contract, #379) — once written it can never be taken back. So the
// text of each call is HELD in memory until one of two things happens:
//
//   - a `tool_call` arrives → the held text was a preamble: it is returned by
//     `toolCall()` for the step's own context (the assistant message replayed
//     to the model) and never reaches `content`;
//   - `holdChars` characters accumulate with no tool call → from here on this
//     call is "the answer": the held text and every later delta are released.
//
// A call that ends (`end()`) with no tool call releases whatever it held — a
// short answer is still an answer. A tool call that arrives AFTER the answer
// was released cannot un-write it (`lateToolCall`); the handler executes it and
// keeps the streamed text, which is rare and logged.
// =============================================================================

import { ASK_ANSWER_HOLD_CHARS } from './ask-limits';

export class AnswerHold {
  private held = '';
  private all = '';
  private releasedFlag = false;
  private toolCalled = false;
  private late = false;

  constructor(private readonly holdChars: number = ASK_ANSWER_HOLD_CHARS) {}

  /** Record one delta; returns the text to append to the answer NOW (`''` while holding). */
  delta(text: string): string {
    if (text.length === 0) return '';
    this.all += text;
    if (this.releasedFlag) return text;
    this.held += text;
    if (this.toolCalled || this.held.length < this.holdChars) return '';
    return this.release();
  }

  /** A tool call arrived. Returns the held preamble, which is discarded from the answer. */
  toolCall(): string {
    if (this.releasedFlag) {
      this.late = true;
      this.toolCalled = true;
      return '';
    }
    this.toolCalled = true;
    const preamble = this.held;
    this.held = '';
    return preamble;
  }

  /** The call ended. With no tool call, whatever is still held is the (short) answer. */
  end(): string {
    if (this.toolCalled) {
      this.held = '';
      return '';
    }
    // Once released nothing is held (every later delta passed straight through).
    return this.releasedFlag ? '' : this.release();
  }

  /** Whether this call's text is (being) written into the answer. */
  get released(): boolean {
    return this.releasedFlag;
  }

  /** A tool call arrived after the answer had started streaming. */
  get lateToolCall(): boolean {
    return this.late;
  }

  /** Every character of this call, preamble included — the assistant message replayed to the model. */
  get text(): string {
    return this.all;
  }

  private release(): string {
    this.releasedFlag = true;
    const out = this.held;
    this.held = '';
    return out;
  }
}
