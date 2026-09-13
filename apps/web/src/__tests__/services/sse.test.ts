import { describe, it, expect } from 'vitest';
import { SseParser } from '../../services/sse';

/**
 * Issue #127, epic #109. `SseParser` is a pure, synchronous SSE framer — no
 * I/O, fed decoded text chunks via `.push()`. These tests exercise the
 * framing grammar directly, including the ambiguous chunk-boundary cases
 * called out in the class's own comments: a CR that might be half of a CRLF,
 * comment lines that must never surface, the one-leading-space rule, and
 * multi-byte UTF-8 characters split across a network read boundary.
 */
describe('SseParser', () => {
  describe('line terminators', () => {
    it('accepts LF-terminated lines', () => {
      const parser = new SseParser();
      const frames = parser.push('data: hello\n\n');
      expect(frames).toEqual([{ event: 'message', data: 'hello', id: null }]);
    });

    it('accepts CRLF-terminated lines within a single chunk', () => {
      const parser = new SseParser();
      const frames = parser.push('data: hello\r\n\r\n');
      expect(frames).toEqual([{ event: 'message', data: 'hello', id: null }]);
    });

    it('accepts bare-CR-terminated lines within a single chunk', () => {
      const parser = new SseParser();
      // The CR here is NOT the last character in the buffer at the moment the
      // scan reaches it (more content and the blank-line terminator follow in
      // the same chunk), so it is unambiguous and must terminate the line
      // immediately rather than being held back - see the dedicated
      // "CR at the very end of the buffer" tests below for the ambiguous case.
      const frames = parser.push('data: a\rdata: b\n\n');
      expect(frames).toEqual([{ event: 'message', data: 'a\nb', id: null }]);
    });

    it('treats a CR at the end of one chunk followed by an LF starting the next chunk as ONE CRLF terminator', () => {
      const parser = new SseParser();

      // First chunk ends with a bare CR - ambiguous: could be a bare-CR
      // terminator, or the first half of a CRLF split across the network
      // read boundary. The parser must hold it rather than dispatch.
      const first = parser.push('data: hello\r');
      expect(first).toEqual([]);

      // Second chunk starts with the LF that completes the CRLF. If this
      // were wrongly treated as CR-terminated-line-then-bare-LF, the LF
      // would be read as an empty line and dispatch a frame here, before the
      // blank-line terminator below ever arrives - which would be wrong in
      // two ways: too early, and the data would still be in the buffer for
      // a phantom second dispatch.
      const second = parser.push('\n\n');
      expect(second).toEqual([{ event: 'message', data: 'hello', id: null }]);
    });

    it('treats a bare CR followed by non-LF content arriving in a LATER chunk as its own terminator', () => {
      const parser = new SseParser();

      // The CR at the end of this chunk is held back, same as above.
      const first = parser.push('data: hello\r');
      expect(first).toEqual([]);

      // But this time the next chunk does NOT start with `\n` - it starts
      // with ordinary content followed by the blank-line terminator. The
      // held CR must be honoured as a bare-CR terminator for `data: hello`,
      // and `data: world` must be its own line, not a continuation of it.
      const second = parser.push('data: world\n\n');
      expect(second).toEqual([{ event: 'message', data: 'hello\nworld', id: null }]);
    });
  });

  describe('comments', () => {
    it('discards a comment line silently - never appears in an emitted frame', () => {
      const parser = new SseParser();
      const frames = parser.push(': heartbeat\ndata: real\n\n');
      expect(frames).toEqual([{ event: 'message', data: 'real', id: null }]);
    });

    it('a comment-only exchange dispatches nothing on the blank line', () => {
      const parser = new SseParser();
      const frames = parser.push(': just a comment\n\n');
      expect(frames).toEqual([]);
    });

    it('the opening `: connected` comment never surfaces', () => {
      const parser = new SseParser();
      const frames = parser.push(': connected\n\n');
      expect(frames).toEqual([]);
    });
  });

  describe('data field accumulation', () => {
    it('joins multiple data: lines with \\n and strips exactly one trailing newline', () => {
      const parser = new SseParser();
      const frames = parser.push('data: line1\ndata: line2\ndata: line3\n\n');
      expect(frames).toEqual([
        { event: 'message', data: 'line1\nline2\nline3', id: null },
      ]);
    });

    it('preserves a legitimate trailing empty data line - only ONE newline is stripped, not trimEnd()', () => {
      const parser = new SseParser();
      // Three `data:` lines, the last one empty, means the accumulated value
      // is "line1\nline2\n\n" before the one-newline strip. Stripping exactly
      // one trailing newline leaves "line1\nline2\n" - the payload's own,
      // legitimate trailing blank line intact. A `trimEnd()` implementation
      // would over-strip this down to "line1\nline2", losing information the
      // sender actually sent.
      const frames = parser.push('data: line1\ndata: line2\ndata:\n\n');
      expect(frames).toEqual([{ event: 'message', data: 'line1\nline2\n', id: null }]);
    });

    it('a bare `data` field with no colon means an empty-string value, not an ignored line', () => {
      const parser = new SseParser();
      const frames = parser.push('data\n\n');
      // data buffer becomes "" + "\n" = "\n", trailing newline stripped -> ""
      // but an EMPTY accumulated data buffer dispatches nothing per spec...
      // here the buffer is "\n" (not ""), so it DOES dispatch, with an empty
      // string payload.
      expect(frames).toEqual([{ event: 'message', data: '', id: null }]);
    });
  });

  describe('leading-space stripping', () => {
    it('strips exactly one leading space after the colon', () => {
      const parser = new SseParser();
      const frames = parser.push('data: {"x":1}\n\n');
      expect(frames[0].data).toBe('{"x":1}');
    });

    it('leaves a second leading space intact', () => {
      const parser = new SseParser();
      const frames = parser.push('data:  x\n\n');
      expect(frames[0].data).toBe(' x');
    });
  });

  describe('empty dispatch suppression', () => {
    it('an empty data buffer dispatches NOTHING - push returns [] with no spurious message frame', () => {
      const parser = new SseParser();
      const frames = parser.push('\n');
      expect(frames).toEqual([]);
    });

    it('a stray blank line after only comments dispatches nothing', () => {
      const parser = new SseParser();
      const frames = parser.push(': a\n: b\n\n');
      expect(frames).toEqual([]);
    });

    it('a run of multiple blank lines dispatches nothing repeatedly', () => {
      const parser = new SseParser();
      const frames = parser.push('\n\n\n');
      expect(frames).toEqual([]);
    });
  });

  describe('event field defaulting', () => {
    it('defaults to "message" when no event: field is present', () => {
      const parser = new SseParser();
      const frames = parser.push('data: x\n\n');
      expect(frames[0].event).toBe('message');
    });

    it('uses the declared event: name when present', () => {
      const parser = new SseParser();
      const frames = parser.push('event: notification\ndata: x\n\n');
      expect(frames[0].event).toBe('notification');
    });

    it('resets the event type after dispatch - a later frame with no event: defaults again', () => {
      const parser = new SseParser();
      const frames = parser.push('event: notification\ndata: x\n\ndata: y\n\n');
      expect(frames).toEqual([
        { event: 'notification', data: 'x', id: null },
        { event: 'message', data: 'y', id: null },
      ]);
    });
  });

  describe('id field', () => {
    it('sets the frame id and lastEventId', () => {
      const parser = new SseParser();
      const frames = parser.push('id: abc123\ndata: x\n\n');
      expect(frames[0].id).toBe('abc123');
      expect(parser.lastEventId).toBe('abc123');
    });

    it('ignores an id containing a NUL character - does not update lastEventId', () => {
      const parser = new SseParser();
      const frames = parser.push(`id: bad\0id\ndata: x\n\n`);
      expect(frames[0].id).toBeNull();
      expect(parser.lastEventId).toBeNull();
    });

    it('a later NUL id does not clobber a previously-set lastEventId, but the frame it appears on has no id', () => {
      const parser = new SseParser();
      parser.push('id: first\ndata: a\n\n');
      const frames = parser.push(`id: bad\0\ndata: b\n\n`);
      expect(frames[0].id).toBeNull();
      expect(parser.lastEventId).toBe('first');
    });

    it('frameId resets to null after dispatch even without a NUL id involved', () => {
      const parser = new SseParser();
      const frames = parser.push('id: a\ndata: x\n\ndata: y\n\n');
      expect(frames[0].id).toBe('a');
      expect(frames[1].id).toBeNull();
    });
  });

  describe('retry field', () => {
    it('sets retryMs from a pure-digit value', () => {
      const parser = new SseParser();
      parser.push('retry: 5000\ndata: x\n\n');
      expect(parser.retryMs).toBe(5000);
    });

    it('ignores a non-digit retry value rather than poisoning it to NaN', () => {
      const parser = new SseParser();
      parser.push('retry: soon\ndata: x\n\n');
      expect(parser.retryMs).toBeNull();
      expect(parser.retryMs).not.toBeNaN();
    });

    it('a later invalid retry does not clobber a previously valid one', () => {
      const parser = new SseParser();
      parser.push('retry: 2000\ndata: a\n\n');
      parser.push('retry: nope\ndata: b\n\n');
      expect(parser.retryMs).toBe(2000);
    });
  });

  describe('unknown fields', () => {
    it('ignores an unrecognised field without affecting the frame', () => {
      const parser = new SseParser();
      const frames = parser.push('futurefield: whatever\ndata: x\n\n');
      expect(frames).toEqual([{ event: 'message', data: 'x', id: null }]);
    });
  });

  describe('buffering across chunks', () => {
    it('carries an unterminated line across two push() calls', () => {
      const parser = new SseParser();
      expect(parser.push('data: hel')).toEqual([]);
      expect(parser.push('lo\n\n')).toEqual([
        { event: 'message', data: 'hello', id: null },
      ]);
    });

    it('splits the field name itself across chunks', () => {
      const parser = new SseParser();
      expect(parser.push('da')).toEqual([]);
      expect(parser.push('ta: x\n\n')).toEqual([
        { event: 'message', data: 'x', id: null },
      ]);
    });

    it('emits multiple frames completed within one push() call', () => {
      const parser = new SseParser();
      const frames = parser.push('data: a\n\ndata: b\n\ndata: c\n\n');
      expect(frames.map((f) => f.data)).toEqual(['a', 'b', 'c']);
    });
  });

  describe('multi-byte UTF-8 characters split across chunk boundaries', () => {
    it('reassembles a multi-byte character whose bytes are split mid-sequence across two decoder feeds', () => {
      // Simulate the real caller: `TextDecoder({ stream: true })` decoding
      // raw network bytes, with the byte split landing mid-character, and
      // ONLY the decoder's already-reassembled text ever reaching push().
      const payload = 'café 😀'; // "café 😀" - accented char + emoji
      const frameText = `data: ${payload}\n\n`;
      const bytes = new TextEncoder().encode(frameText);

      // Pick a split point guaranteed to land inside a multi-byte sequence:
      // find the byte offset of the euro/e-acute (0xC3 0xA9, 2 bytes) and
      // split between its two bytes.
      // Locate "é" (U+00E9) bytes within `bytes`.
      const eAcuteBytes = new TextEncoder().encode('é');
      let splitIndex = -1;
      for (let i = 0; i <= bytes.length - eAcuteBytes.length; i++) {
        if (
          bytes[i] === eAcuteBytes[0] &&
          bytes[i + 1] === eAcuteBytes[1]
        ) {
          splitIndex = i + 1; // split between the two bytes of "é"
          break;
        }
      }
      expect(splitIndex).toBeGreaterThan(0);

      const firstHalf = bytes.slice(0, splitIndex);
      const secondHalf = bytes.slice(splitIndex);

      const decoder = new TextDecoder();
      const parser = new SseParser();

      const decodedFirst = decoder.decode(firstHalf, { stream: true });
      const framesFromFirst = parser.push(decodedFirst);
      expect(framesFromFirst).toEqual([]);

      const decodedSecond = decoder.decode(secondHalf, { stream: true });
      const framesFromSecond = parser.push(decodedSecond);

      expect(framesFromSecond).toEqual([
        { event: 'message', data: payload, id: null },
      ]);
    });

    it('does not mangle a complete multi-byte character arriving as a single chunk', () => {
      const payload = 'accenté emoji🎉';
      const parser = new SseParser();
      const frames = parser.push(`data: ${payload}\n\n`);
      expect(frames).toEqual([{ event: 'message', data: payload, id: null }]);
    });
  });
});
