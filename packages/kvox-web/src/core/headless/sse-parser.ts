// =============================================================================
// The SSE parser: pure, synchronous, free of both DOM and network
// =============================================================================
//
// `EventSource` cannot send an `Authorization` header, so every stream of the
// domain is read with `fetch()` and framed here. The parser is the half of an
// event-stream client that is easiest to get subtly wrong (a chunk boundary in
// the middle of a UTF-8 sequence, between the CR and LF of one terminator, in
// the middle of a field name), so it is a plain class a test drives with
// strings. Reconnection, backoff and `Last-Event-ID` resume are
// `connectKvoxSse`'s job (`./sse.ts`).
// =============================================================================

/**
 * One dispatched SSE event.
 *
 * @stability experimental
 */
export interface SseFrame {
  /**
   * The `event:` name, or `'message'` when the frame declared none.
   *
   * Defaulted here rather than left `undefined` so a consumer switching on the
   * name never has to spell the default itself. The API always names its
   * frames (`notification`), so a `'message'` arriving is a signal that
   * something upstream changed.
   */
  event: string;
  /**
   * The `data:` payload, with multiple `data:` lines joined by `\n` and the
   * trailing newline removed, per the SSE grammar.
   */
  data: string;
  /** The `id:` field of this frame, or `null`. Tracked; `connectKvoxSse` sends the last one as `Last-Event-ID`. */
  id: string | null;
}

/**
 * An incremental SSE stream parser.
 *
 * Fed decoded text in arbitrary chunks — a network read boundary can land
 * anywhere, including in the middle of a UTF-8 sequence, in the middle of a
 * field name, or between the CR and LF of one line terminator — and emits whole
 * frames only. Every one of those splits is a real thing that happens under
 * load and each has its own comment below.
 *
 * Deliberately a plain class with no I/O so the framing rules can be tested by
 * calling a method with a string.
 *
 * @stability experimental
 */
export class SseParser {
  /** Bytes seen but not yet terminated by a line ending. */
  private buffer = '';

  /** The event-type buffer, per spec: reset to '' after every dispatch. */
  private eventType = '';

  /** The data buffer, per spec: accumulated across `data:` lines. */
  private data = '';

  /** This frame's `id:`, distinct from `lastEventId` below. */
  private frameId: string | null = null;

  /**
   * The last non-null `id:` seen on the stream.
   *
   * Public because it is genuinely part of the stream's state, and read by
   * nothing today — see the header on why it is not sent back.
   */
  lastEventId: string | null = null;

  /**
   * The server's most recent `retry:` directive, in milliseconds, or `null`.
   *
   * A STREAM-LEVEL directive, not a per-frame one: it sets the reconnection
   * delay for every subsequent reconnect until the server says otherwise, which
   * is why it lives on the parser rather than on `SseFrame`. This API never
   * sends one; it is honoured anyway because ignoring a server that asks to be
   * reconnected to more slowly is how a client turns a struggling backend into
   * a hammered one.
   */
  retryMs: number | null = null;

  /**
   * Feed one decoded chunk; get back every frame it completed.
   *
   * @param chunk - decoded text. MUST come from a streaming decoder — see
   *        `TextDecoder({ stream: true })` at the call site. Decoding each
   *        network chunk independently corrupts any multi-byte character that
   *        straddles a chunk boundary, which for this API means a notification
   *        body with an accent or an emoji in it arrives mangled roughly
   *        whenever it is unlucky about packet size.
   */
  push(chunk: string): SseFrame[] {
    this.buffer += chunk;

    const frames: SseFrame[] = [];
    let start = 0;
    let i = 0;

    // Line terminators in SSE are CRLF, LF **or** bare CR — all three, which is
    // why this is a hand-written scan rather than `split('\n')`.
    while (i < this.buffer.length) {
      const ch = this.buffer[i];

      if (ch === '\n') {
        this.handleLine(this.buffer.slice(start, i), frames);
        i += 1;
        start = i;
      } else if (ch === '\r') {
        // A CR AT THE VERY END OF WHAT WE HOLD IS AMBIGUOUS: it is either a
        // bare-CR terminator, or the first half of a CRLF whose LF is in the
        // next network chunk. Treating it as a terminator now would emit the
        // line and then treat the stray LF as an EMPTY line, dispatching a
        // half-built frame. So stop, leave the CR in the buffer, and decide
        // when more bytes arrive.
        if (i === this.buffer.length - 1) break;

        this.handleLine(this.buffer.slice(start, i), frames);
        i += this.buffer[i + 1] === '\n' ? 2 : 1;
        start = i;
      } else {
        i += 1;
      }
    }

    // Keep the unterminated remainder (including a trailing CR we stopped on).
    this.buffer = this.buffer.slice(start);
    return frames;
  }

  private handleLine(line: string, frames: SseFrame[]): void {
    // A BLANK LINE IS THE DISPATCH SIGNAL. Not a separator to skip.
    if (line === '') {
      const frame = this.dispatch();
      if (frame) frames.push(frame);
      return;
    }

    // A COMMENT. `: heartbeat` and the opening `: connected` both land here and
    // are discarded, which is exactly what they are for: they are bytes on the
    // wire that keep nginx and every NAT table in the path from reaping an idle
    // connection, and they must NEVER surface to the page as a message. See
    // `HEARTBEAT_INTERVAL_MS` in `notification-stream.service.ts`.
    //
    // They are not entirely inert to this client either — a comment arriving is
    // a read completing, so it is what keeps the reconnect loop below from ever
    // seeing an idle stream as a dead one.
    if (line.startsWith(':')) return;

    const colon = line.indexOf(':');
    let field: string;
    let value: string;

    if (colon === -1) {
      // A field name with no value, e.g. a bare `data`. Legal, and means an
      // empty value — NOT a line to ignore.
      field = line;
      value = '';
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      // EXACTLY ONE leading space is stripped, per spec. `data:  x` carries a
      // value of ` x`, and trimming would corrupt payloads whose JSON was
      // pretty-printed or whose text legitimately begins with whitespace.
      if (value.startsWith(' ')) value = value.slice(1);
    }

    switch (field) {
      case 'event':
        this.eventType = value;
        break;

      case 'data':
        // Multiple `data:` lines concatenate with `\n` between them. This is
        // what makes a JSON payload containing a newline transmissible, and
        // getting it wrong turns a multi-line frame into unparseable JSON.
        this.data += value + '\n';
        break;

      case 'id':
        // Per spec, an id containing a NUL is ignored rather than honoured.
        if (!value.includes('\0')) {
          this.frameId = value;
          this.lastEventId = value;
        }
        break;

      case 'retry':
        // Digits only. `retry: soon` is ignored rather than becoming `NaN` and
        // poisoning the backoff arithmetic into scheduling a reconnect that
        // never fires.
        if (/^\d+$/.test(value)) this.retryMs = Number(value);
        break;

      default:
        // Unknown field. Ignored, per spec — that is what makes it safe for the
        // server to add fields later.
        break;
    }
  }

  private dispatch(): SseFrame | null {
    // AN EMPTY DATA BUFFER DISPATCHES NOTHING. Per spec, and load-bearing here:
    // a run of blank lines, or a blank line following a comment-only exchange,
    // must not manufacture an empty `message` event that a consumer then tries
    // to `JSON.parse`.
    if (this.data === '') {
      this.eventType = '';
      this.frameId = null;
      return null;
    }

    const frame: SseFrame = {
      event: this.eventType === '' ? 'message' : this.eventType,
      // Strip the ONE trailing newline the accumulation above always adds.
      // `trimEnd()` would be wrong: a payload legitimately ending in a blank
      // line would lose it.
      data: this.data.slice(0, -1),
      id: this.frameId,
    };

    this.eventType = '';
    this.data = '';
    this.frameId = null;

    return frame;
  }
}

