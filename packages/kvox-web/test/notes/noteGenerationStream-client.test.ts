import { describe, it, expect, vi, beforeEach } from 'vitest';

import { createFakeKvoxWebHost } from '../../src/core/testing/index.js';
import type { FakeKvoxWebHost, FakeSseContext } from '../../src/core/testing/index.js';
import {
  applyDelta,
  connectNoteGenerationStream,
  connectNoteStream,
  describeStreamError,
  noteGenerationStreamPath,
  noteStreamPath,
  parseDeltaFrame,
  parseDoneFrame,
  parseErrorFrame,
} from '../../src/notes/headless/clients/noteGenerationStream.js';

/**
 * The generation stream client — issue #56, epic #45.
 *
 * The stream runs over a fake host (`host.sse.connect`, a script per path) and
 * the REAL reconnect loop of core: what is worth proving here is the layer above
 * it — that a `delta` frame is written at its OFFSET rather than appended, that a
 * terminal frame closes the connection before the callback runs, that a
 * malformed frame costs one frame instead of the stream, and that a reconnect
 * resumes with `Last-Event-ID`.
 */

interface FakeConnection {
  emit: (frame: { event: string; data: string; id?: string }) => void;
  signal: AbortSignal;
  lastEventId: string | undefined;
}

const connections: FakeConnection[] = [];

/** A host whose note and preview streams hand their context to the test and stay open. */
function streamHost(): FakeKvoxWebHost {
  const hold = (context: FakeSseContext): Promise<void> => {
    connections.push({
      emit: (event) => context.emit(event),
      signal: context.signal,
      lastEventId: context.lastEventId,
    });
    return new Promise<void>((resolve) => {
      context.signal.addEventListener('abort', () => resolve());
    });
  };
  return createFakeKvoxWebHost({
    sse: { '/note-generations/gen-1/stream': hold, '/notes/n1/stream': hold },
  });
}

/** Waits for the stream to have connected, then returns its connection. */
async function connected(index = 0): Promise<FakeConnection> {
  await vi.waitFor(() => expect(connections.length).toBeGreaterThan(index));
  return connections[index];
}

function frame(event: string, data: unknown, id?: string) {
  return { event, data: JSON.stringify(data), ...(id === undefined ? {} : { id }) };
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

    // The reconnect case: `connectSse` (`@marinoscar/kvox-web/core/headless`) sends no `Last-Event-ID`, so the
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

  it('addresses the generation by id and the note by id, below the API base the host owns', () => {
    // A PATH, not a URL: the host resolves it against its own base, so a
    // hardcoded origin here would be a same-origin assumption in the one code
    // path that fails by going quiet rather than by erroring.
    expect(noteGenerationStreamPath('gen-1')).toBe('/note-generations/gen-1/stream');
    expect(noteStreamPath('n1')).toBe('/notes/n1/stream');
  });

  it('reports the whole buffer on every delta, not just the new text', async () => {
    const onContent = vi.fn();
    connectNoteGenerationStream(streamHost(), 'gen-1', {
      onContent,
      onDone: vi.fn(),
      onError: vi.fn(),
    });
    const connection = await connected();

    connection.emit(frame('delta', { delta: '# Sync\n', offset: 7 }));
    connection.emit(frame('delta', { delta: 'Decisions', offset: 16 }));

    expect(onContent).toHaveBeenNthCalledWith(1, '# Sync\n');
    expect(onContent).toHaveBeenNthCalledWith(2, '# Sync\nDecisions');
  });

  it('streams a NOTE through its own path', async () => {
    const onContent = vi.fn();
    const host = streamHost();
    connectNoteStream(host, 'n1', { onContent, onDone: vi.fn(), onError: vi.fn() });
    const connection = await connected();

    connection.emit(frame('delta', { delta: 'Hello', offset: 5 }));

    expect(host.callsTo('/notes/n1/stream')).toHaveLength(1);
    expect(onContent).toHaveBeenCalledWith('Hello');
  });

  it('closes the connection BEFORE announcing done — a handler may unmount the panel', async () => {
    const order: string[] = [];
    connectNoteGenerationStream(streamHost(), 'gen-1', {
      onContent: vi.fn(),
      onDone: () => order.push(`done (aborted: ${String(connections[0].signal.aborted)})`),
      onError: vi.fn(),
    });
    const connection = await connected();
    connection.signal.addEventListener('abort', () => order.push('close'));

    connection.emit(frame('done', { status: 'succeeded', offset: 0, currentVersion: null }));

    expect(order).toEqual(['close', 'done (aborted: true)']);
  });

  it('closes on an error frame too, and hands over a described failure', async () => {
    const onError = vi.fn();
    connectNoteGenerationStream(streamHost(), 'gen-1', {
      onContent: vi.fn(),
      onDone: vi.fn(),
      onError,
    });
    const connection = await connected();

    connection.emit(
      frame('error', { status: 'failed', offset: 3, errorClass: 'rate_limit', reason: null }),
    );

    expect(connection.signal.aborted).toBe(true);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ errorClass: 'rate_limit' }));
  });

  it('ignores frames that arrive after a terminal one, so onDone cannot fire twice', async () => {
    const onDone = vi.fn();
    const onContent = vi.fn();
    connectNoteGenerationStream(streamHost(), 'gen-1', { onContent, onDone, onError: vi.fn() });
    const connection = await connected();

    connection.emit(frame('done', { status: 'succeeded', offset: 0, currentVersion: null }));
    connection.emit(frame('done', { status: 'succeeded', offset: 0, currentVersion: null }));
    connection.emit(frame('delta', { delta: 'late', offset: 4 }));

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onContent).not.toHaveBeenCalled();
  });

  it('drops a malformed frame without killing the stream', async () => {
    const onContent = vi.fn();
    connectNoteGenerationStream(streamHost(), 'gen-1', {
      onContent,
      onDone: vi.fn(),
      onError: vi.fn(),
    });
    const connection = await connected();

    connection.emit({ event: 'delta', data: '{ truncated' });
    connection.emit(frame('delta', { delta: 'ok', offset: 2 }));

    expect(onContent).toHaveBeenCalledTimes(1);
    expect(onContent).toHaveBeenCalledWith('ok');
  });

  it('ignores an event name it does not know — a newer server, not an error', async () => {
    const handlers = { onContent: vi.fn(), onDone: vi.fn(), onError: vi.fn() };
    connectNoteGenerationStream(streamHost(), 'gen-1', handlers);
    const connection = await connected();

    connection.emit(frame('progress', { percent: 10 }));

    expect(handlers.onContent).not.toHaveBeenCalled();
    expect(handlers.onDone).not.toHaveBeenCalled();
    expect(handlers.onError).not.toHaveBeenCalled();
  });

  it('closes the connection when the returned handle is closed', async () => {
    const handle = connectNoteGenerationStream(streamHost(), 'gen-1', {
      onContent: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    });
    const connection = await connected();

    handle.close();

    expect(connection.signal.aborted).toBe(true);
  });

  it('resumes with the last frame id after the stream drops, and does not duplicate text', async () => {
    // The API's frame `id:` IS the buffer offset. When the connection ends
    // without a terminal frame the loop reconnects (after its backoff) with
    // `Last-Event-ID`, and the buffer the client holds is kept — so a server
    // that replays from the start, or resumes, yields the same text.
    vi.useFakeTimers();
    try {
      let attempt = 0;
      const lastIds: Array<string | undefined> = [];
      const host = createFakeKvoxWebHost({
        sse: {
          '/notes/n1/stream': (context: FakeSseContext) => {
            lastIds.push(context.lastEventId);
            attempt += 1;
            if (attempt === 1) {
              context.emit(frame('delta', { delta: 'Hello', offset: 5 }, '5'));
              return; // the stream ends: a drop
            }
            context.emit(frame('delta', { delta: 'Hello', offset: 5 }, '5'));
            context.emit(frame('delta', { delta: ' world', offset: 11 }, '11'));
            return new Promise<void>((resolve) => {
              context.signal.addEventListener('abort', () => resolve());
            });
          },
        },
      });
      const onContent = vi.fn();

      const handle = connectNoteStream(host, 'n1', {
        onContent,
        onDone: vi.fn(),
        onError: vi.fn(),
      });
      await vi.advanceTimersByTimeAsync(40_000);

      expect(lastIds).toEqual([undefined, '5']);
      expect(onContent).toHaveBeenLastCalledWith('Hello world');
      handle.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
