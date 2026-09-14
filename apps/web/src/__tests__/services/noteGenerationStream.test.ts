import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The generation stream client — issue #56, epic #45.
 *
 * `services/sse.ts` is MOCKED, `services/noteGenerationStream.ts` is not: the
 * SSE framing already has its own suite (`sse.test.ts`), and what is worth
 * proving here is the layer above it — that a `delta` frame is written at its
 * OFFSET rather than appended, that a terminal frame closes the connection
 * before the callback runs, and that a malformed frame costs one frame instead
 * of the stream.
 */

const connections: Array<{
  url: string;
  onFrame: (frame: { event: string; data: string; id: string | null }) => void;
  close: ReturnType<typeof vi.fn>;
}> = [];

vi.mock('../../services/sse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/sse')>();
  return {
    ...actual,
    connectSse: vi.fn((options: Parameters<typeof actual.connectSse>[0]) => {
      const close = vi.fn();
      connections.push({ url: options.url, onFrame: options.onFrame, close });
      return { close };
    }),
  };
});

import { API_BASE_URL } from '../../services/api';
import {
  applyDelta,
  connectNoteGenerationStream,
  describeStreamError,
  noteGenerationStreamUrl,
  parseDeltaFrame,
  parseDoneFrame,
  parseErrorFrame,
} from '../../services/noteGenerationStream';

function frame(event: string, data: unknown) {
  return { event, data: JSON.stringify(data), id: null };
}

describe('noteGenerationStream — parsing', () => {
  it('parses a delta frame', () => {
    expect(parseDeltaFrame('{"delta":"# Sync\\n","offset":8}')).toEqual({
      delta: '# Sync\n',
      offset: 8,
    });
  });

  it('rejects a delta frame whose offset is not a number, rather than doing arithmetic on undefined', () => {
    expect(parseDeltaFrame('{"delta":"x"}')).toBeNull();
    expect(parseDeltaFrame('{"delta":"x","offset":"12"}')).toBeNull();
    expect(parseDeltaFrame('not json at all')).toBeNull();
  });

  it('parses a preview’s done frame, whose currentVersion is null by design', () => {
    expect(parseDoneFrame('{"status":"succeeded","offset":812,"currentVersion":null}')).toEqual({
      status: 'succeeded',
      offset: 812,
      currentVersion: null,
    });
  });

  it('widens an unknown errorClass to "other" instead of dropping the frame', () => {
    // A newer server naming a class this bundle has never heard of is still
    // saying the generation failed; dropping it would spin forever.
    const parsed = parseErrorFrame(
      '{"status":"failed","offset":4,"errorClass":"quota_exhausted","reason":null}',
    );

    expect(parsed?.errorClass).toBe('other');
  });

  it('prefers the server’s own reason over the generic sentence for the class', () => {
    expect(
      describeStreamError({
        status: 'failed',
        offset: 0,
        errorClass: 'auth',
        reason: 'Incorrect API key provided.',
      }),
    ).toBe('Incorrect API key provided.');

    expect(
      describeStreamError({ status: 'failed', offset: 0, errorClass: 'auth', reason: null }),
    ).toMatch(/rejected the key/i);
  });
});

describe('noteGenerationStream — applyDelta', () => {
  it('writes at the offset the frame ends at, so a replay is idempotent', () => {
    let buffer = '';
    buffer = applyDelta(buffer, { delta: 'Hello', offset: 5 });
    buffer = applyDelta(buffer, { delta: ' world', offset: 11 });
    expect(buffer).toBe('Hello world');

    // The reconnect case: `services/sse.ts` sends no `Last-Event-ID`, so the
    // server replays from zero. Appending would double the text.
    buffer = applyDelta(buffer, { delta: 'Hello', offset: 5 });
    buffer = applyDelta(buffer, { delta: ' world', offset: 11 });
    buffer = applyDelta(buffer, { delta: ' again', offset: 17 });
    expect(buffer).toBe('Hello world again');
  });

  it('appends rather than inventing padding when a frame starts past the buffer', () => {
    // A gap the API's contract says cannot happen. Whitespace invented to
    // preserve an offset would be characters no model produced.
    expect(applyDelta('ab', { delta: 'z', offset: 99 })).toBe('abz');
  });
});

describe('noteGenerationStream — the connection', () => {
  beforeEach(() => {
    connections.length = 0;
  });

  it('addresses the generation by id, on the same base as every other call', () => {
    // Resolved against `API_BASE_URL`, not a second literal `'/api'`: a
    // hardcoded base here would be a same-origin assumption that breaks the
    // day `VITE_API_BASE_URL` is set, in the one code path that fails by going
    // quiet rather than by erroring.
    expect(noteGenerationStreamUrl('gen-1')).toBe(
      `${API_BASE_URL}/note-generations/gen-1/stream`,
    );
  });

  it('reports the whole buffer on every delta, not just the new text', () => {
    const onContent = vi.fn();
    connectNoteGenerationStream('gen-1', { onContent, onDone: vi.fn(), onError: vi.fn() });

    connections[0].onFrame(frame('delta', { delta: '# Sync\n', offset: 7 }));
    connections[0].onFrame(frame('delta', { delta: 'Decisions', offset: 16 }));

    expect(onContent).toHaveBeenNthCalledWith(1, '# Sync\n');
    expect(onContent).toHaveBeenNthCalledWith(2, '# Sync\nDecisions');
  });

  it('closes the connection BEFORE announcing done — a handler may unmount the panel', () => {
    const order: string[] = [];
    connectNoteGenerationStream('gen-1', {
      onContent: vi.fn(),
      onDone: () => order.push('done'),
      onError: vi.fn(),
    });
    connections[0].close.mockImplementation(() => order.push('close'));

    connections[0].onFrame(frame('done', { status: 'succeeded', offset: 0, currentVersion: null }));

    expect(order).toEqual(['close', 'done']);
  });

  it('closes on an error frame too, and hands over a described failure', () => {
    const onError = vi.fn();
    connectNoteGenerationStream('gen-1', { onContent: vi.fn(), onDone: vi.fn(), onError });

    connections[0].onFrame(
      frame('error', { status: 'failed', offset: 3, errorClass: 'rate_limit', reason: null }),
    );

    expect(connections[0].close).toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: 'rate_limit' }),
    );
  });

  it('ignores frames that arrive after a terminal one, so onDone cannot fire twice', () => {
    const onDone = vi.fn();
    const onContent = vi.fn();
    connectNoteGenerationStream('gen-1', { onContent, onDone, onError: vi.fn() });

    connections[0].onFrame(frame('done', { status: 'succeeded', offset: 0, currentVersion: null }));
    connections[0].onFrame(frame('done', { status: 'succeeded', offset: 0, currentVersion: null }));
    connections[0].onFrame(frame('delta', { delta: 'late', offset: 4 }));

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onContent).not.toHaveBeenCalled();
  });

  it('drops a malformed frame without killing the stream', () => {
    const onContent = vi.fn();
    connectNoteGenerationStream('gen-1', { onContent, onDone: vi.fn(), onError: vi.fn() });

    connections[0].onFrame({ event: 'delta', data: '{ truncated', id: null });
    connections[0].onFrame(frame('delta', { delta: 'ok', offset: 2 }));

    expect(onContent).toHaveBeenCalledTimes(1);
    expect(onContent).toHaveBeenCalledWith('ok');
  });

  it('ignores an event name it does not know — a newer server, not an error', () => {
    const handlers = { onContent: vi.fn(), onDone: vi.fn(), onError: vi.fn() };
    connectNoteGenerationStream('gen-1', handlers);

    connections[0].onFrame(frame('progress', { percent: 10 }));

    expect(handlers.onContent).not.toHaveBeenCalled();
    expect(handlers.onDone).not.toHaveBeenCalled();
    expect(handlers.onError).not.toHaveBeenCalled();
  });
});
