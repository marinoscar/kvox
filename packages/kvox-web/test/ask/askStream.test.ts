import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import type { KvoxSseConnectOptions, KvoxSseEvent } from '../../src/core/headless/index.js';
import { createFakeKvoxWebHost } from '../../src/core/testing/index.js';
import {
  askMessageStreamPath,
  connectAskStream,
  parseAskCitation,
  parseAskDelta,
  parseAskDone,
  parseAskError,
  parseAskStep,
} from '../../src/ask/headless/index.js';
import type { AskStreamHandlers } from '../../src/ask/headless/index.js';
import { applyDelta } from '../../src/notes/headless/index.js';

/**
 * The Ask answer stream client (#380, #379's frames).
 *
 * The host's `sse.connect` is replaced by a recorder, so the real
 * `connectKvoxSse` loop runs and what is proven is the layer above it: frames
 * parsed and validated, deltas written at their OFFSET (so a reconnect's replay
 * never duplicates text), steps de-duplicated by `index`, a terminal frame
 * closing the connection before its callback, and the resume offset the stream
 * asks for.
 */

interface Attempt {
  path: string;
  lastEventId: string | undefined;
  signal: AbortSignal;
  onEvent: (event: KvoxSseEvent) => void;
  onOpen: () => void;
  /** Ends the attempt the way a server closing the stream would. */
  end: () => void;
}

const attempts: Attempt[] = [];

function recordingHost() {
  const host = createFakeKvoxWebHost();
  host.sse.connect = (path: string, options: KvoxSseConnectOptions) =>
    new Promise<void>((resolve) => {
      attempts.push({
        path,
        lastEventId: options.lastEventId,
        signal: options.signal,
        onEvent: options.onEvent,
        onOpen: () => options.onOpen?.(),
        end: resolve,
      });
      options.signal.addEventListener('abort', () => resolve());
    });
  return host;
}

function frame(event: string, data: unknown, id?: string): KvoxSseEvent {
  return {
    event,
    data: typeof data === 'string' ? data : JSON.stringify(data),
    ...(id === undefined ? {} : { id }),
  };
}

function handlers(): { [K in keyof AskStreamHandlers]: Mock<AskStreamHandlers[K]> } {
  return {
    onContent: vi.fn<AskStreamHandlers['onContent']>(),
    onStep: vi.fn<AskStreamHandlers['onStep']>(),
    onDone: vi.fn<AskStreamHandlers['onDone']>(),
    onError: vi.fn<AskStreamHandlers['onError']>(),
  };
}

/** Lets the loop's promise chain run, under fake timers. */
async function pump(iterations = 20) {
  for (let i = 0; i < iterations; i += 1) {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  }
}

beforeEach(() => {
  attempts.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('askStream — parsing', () => {
  it('parses a delta exactly like the note stream', () => {
    expect(parseAskDelta('{"delta":"Hi","offset":2}')).toEqual({ delta: 'Hi', offset: 2 });
    expect(parseAskDelta('{"delta":"Hi"}')).toBeNull();
    expect(parseAskDelta('nope')).toBeNull();
  });

  it('parses a step, requiring index and offset', () => {
    expect(
      parseAskStep('{"index":0,"name":"search","summary":"Searched “Acme”","resultCount":3,"error":null,"offset":0}'),
    ).toEqual({ index: 0, name: 'search', summary: 'Searched “Acme”', resultCount: 3, error: null, offset: 0 });
    expect(parseAskStep('{"name":"search","offset":0}')).toBeNull();
    expect(parseAskStep('{"index":1}')).toBeNull();
    expect(parseAskStep('[1,2]')).toBeNull();
  });

  it('parses a done frame with its citations and finish reason', () => {
    const done = parseAskDone(
      JSON.stringify({
        status: 'succeeded',
        offset: 10,
        finishReason: 'step_cap',
        promptTokens: 100,
        completionTokens: 20,
        citations: [
          { marker: 'ev1', kind: 'evidence', id: 'e1', via: { kind: 'item', id: 'i1' }, valid: true, label: 'Call', documentKind: null, startMs: null },
          { marker: 'bad' },
        ],
      }),
    );
    expect(done).toMatchObject({ status: 'succeeded', offset: 10, finishReason: 'step_cap', promptTokens: 100 });
    // The malformed entry is dropped; the rest of the answer's citations stay true.
    expect(done?.citations).toHaveLength(1);
    expect(done?.citations[0]).toMatchObject({ marker: 'ev1', id: 'e1', via: { kind: 'item', id: 'i1' }, valid: true });
  });

  it('reads an unknown finish reason as stop, and rejects a frame that is not a success', () => {
    expect(parseAskDone('{"status":"succeeded","offset":1,"finishReason":"new_cap","citations":[]}')?.finishReason).toBe('stop');
    expect(parseAskDone('{"status":"failed","offset":1}')).toBeNull();
  });

  it('parses an error frame, widening an unknown class to other and keeping gone', () => {
    expect(parseAskError('{"status":"failed","offset":3,"errorClass":"gone","reason":null}')).toEqual({
      status: 'failed',
      offset: 3,
      errorClass: 'gone',
      reason: null,
    });
    expect(parseAskError('{"status":"failed","offset":3,"errorClass":"meteor"}')?.errorClass).toBe('other');
    expect(parseAskError('{"status":"failed"}')).toBeNull();
  });

  it('treats a citation with no id as invalid, whatever it claims', () => {
    expect(parseAskCitation({ marker: 'ev2', kind: 'evidence', id: null, valid: true })?.valid).toBe(false);
    expect(parseAskCitation({ marker: 'ev2', kind: 'widget', id: 'x', valid: true })).toBeNull();
  });
});

describe('askStream — deltas applied at their offsets', () => {
  it('replays without duplicating, and extends with new text', () => {
    let buffer = '';
    buffer = applyDelta(buffer, { delta: 'Hello ', offset: 6 });
    buffer = applyDelta(buffer, { delta: 'world', offset: 11 });
    // A reconnect replays from offset 0.
    buffer = applyDelta(buffer, { delta: 'Hello world', offset: 11 });
    buffer = applyDelta(buffer, { delta: '!', offset: 12 });
    expect(buffer).toBe('Hello world!');
  });
});

describe('connectAskStream', () => {
  it('connects to the message stream path, from the offset it already holds', async () => {
    const host = recordingHost();
    connectAskStream(host, 'm-1', handlers());
    connectAskStream(host, 'm 2', handlers(), { content: 'Already here' });
    await pump();
    expect(attempts[0].path).toBe('/ask/messages/m-1/stream');
    expect(attempts[1].path).toBe('/ask/messages/m%202/stream?lastEventId=12');
    expect(askMessageStreamPath('x', 0)).toBe('/ask/messages/x/stream');
  });

  it('reconciles deltas from a resume offset and survives a replay without duplicating text', async () => {
    const h = handlers();
    connectAskStream(recordingHost(), 'm-1', h, { content: 'The Atlas' });
    await pump();
    const { onEvent, onOpen } = attempts[0];

    onEvent(frame('delta', { delta: ' beta', offset: 14 }));
    expect(h.onContent).toHaveBeenLastCalledWith('The Atlas beta');

    // The socket drops; the replay starts again from the offset the URL names.
    onOpen();
    onEvent(frame('delta', { delta: ' beta', offset: 14 }));
    onEvent(frame('delta', { delta: ' ships.', offset: 21 }));
    expect(h.onContent).toHaveBeenLastCalledWith('The Atlas beta ships.');
    // The replayed frame changed nothing, so it did not re-render.
    expect(h.onContent).toHaveBeenCalledTimes(2);
  });

  it('reconnects with Last-Event-ID set to the offset of the last frame it saw', async () => {
    const h = handlers();
    connectAskStream(recordingHost(), 'm-1', h);
    await pump();
    attempts[0].onOpen();
    attempts[0].onEvent(frame('delta', { delta: 'Hello', offset: 5 }, '5'));
    attempts[0].onEvent(frame('step', { index: 0, name: 'search', summary: 's', resultCount: 1, error: null, offset: 5 }, '5'));
    // The server ends the stream before a terminal frame; the loop must reconnect.
    attempts[0].end();
    await pump();
    await vi.advanceTimersByTimeAsync(2_100);
    await pump();

    expect(attempts).toHaveLength(2);
    expect(attempts[0].lastEventId).toBeUndefined();
    expect(attempts[1].lastEventId).toBe('5');
    expect(attempts[1].path).toBe('/ask/messages/m-1/stream');

    // The replay of the same step is not reported twice, and the text is not duplicated.
    attempts[1].onEvent(frame('step', { index: 0, name: 'search', summary: 's', resultCount: 1, error: null, offset: 5 }, '5'));
    attempts[1].onEvent(frame('delta', { delta: ' world', offset: 11 }, '11'));
    expect(h.onStep).toHaveBeenCalledTimes(1);
    expect(h.onContent).toHaveBeenLastCalledWith('Hello world');
  });

  it('reports each step once, however often it is re-sent, skipping ones already held', async () => {
    const h = handlers();
    connectAskStream(recordingHost(), 'm-1', h, { knownStepIndexes: [0] });
    await pump();
    const { onEvent } = attempts[0];
    const step = (index: number) =>
      frame('step', { index, name: 'search', summary: `Step ${index}`, resultCount: 1, error: null, offset: 0 });

    onEvent(step(0));
    onEvent(step(1));
    onEvent(step(1));
    onEvent(step(2));
    expect(h.onStep).toHaveBeenCalledTimes(2);
    expect(h.onStep.mock.calls.map(([s]) => s.index)).toEqual([1, 2]);
    expect(h.onStep.mock.calls[0][0]).toEqual({
      index: 1,
      name: 'search',
      arguments: {},
      summary: 'Step 1',
      resultCount: 1,
      durationMs: 0,
      error: null,
    });
  });

  it('closes on done BEFORE calling back, and ignores anything after', async () => {
    const h = handlers();
    connectAskStream(recordingHost(), 'm-1', h);
    await pump();
    const attempt = attempts[0];
    h.onDone.mockImplementation(() => expect(attempt.signal.aborted).toBe(true));

    attempt.onEvent(frame('done', { status: 'succeeded', offset: 0, finishReason: 'stop', citations: [], promptTokens: null, completionTokens: null }));
    attempt.onEvent(frame('delta', { delta: 'late', offset: 4 }));
    attempt.onEvent(frame('done', { status: 'succeeded', offset: 0, finishReason: 'stop', citations: [] }));
    expect(h.onDone).toHaveBeenCalledTimes(1);
    expect(h.onDone).toHaveBeenCalledWith({ citations: [], finishReason: 'stop' });
    expect(h.onContent).not.toHaveBeenCalled();
  });

  it('dispatches an error frame and closes', async () => {
    const h = handlers();
    connectAskStream(recordingHost(), 'm-1', h);
    await pump();
    const attempt = attempts[0];
    attempt.onEvent(frame('error', { status: 'failed', offset: 0, errorClass: 'rate_limit', reason: null }));
    expect(attempt.signal.aborted).toBe(true);
    expect(h.onError).toHaveBeenCalledWith({ errorClass: 'rate_limit', reason: null });
  });

  it('reports a deleted conversation as the wire-only gone class and closes', async () => {
    const h = handlers();
    connectAskStream(recordingHost(), 'm-1', h);
    await pump();
    const attempt = attempts[0];
    attempt.onEvent(frame('error', { status: 'failed', offset: 0, errorClass: 'gone', reason: 'message_gone' }));
    expect(attempt.signal.aborted).toBe(true);
    expect(h.onError).toHaveBeenCalledWith({ errorClass: 'gone', reason: 'message_gone' });
  });

  it('passes the reader giving up through as timeout with its reason', async () => {
    const h = handlers();
    connectAskStream(recordingHost(), 'm-1', h);
    await pump();
    attempts[0].onEvent(frame('error', { status: 'failed', offset: 0, errorClass: 'timeout', reason: 'stream_duration_cap' }));
    expect(h.onError).toHaveBeenCalledWith({ errorClass: 'timeout', reason: 'stream_duration_cap' });
  });

  it('costs one frame, not the stream, for garbage and ignores unknown events', async () => {
    const h = handlers();
    connectAskStream(recordingHost(), 'm-1', h);
    await pump();
    const { onEvent } = attempts[0];
    onEvent(frame('delta', 'not json'));
    onEvent(frame('mystery', { anything: true }));
    onEvent(frame('delta', { delta: 'ok', offset: 2 }));
    expect(h.onContent).toHaveBeenCalledTimes(1);
    expect(h.onContent).toHaveBeenCalledWith('ok');
  });

  it('close() ends the attempt', async () => {
    const connection = connectAskStream(recordingHost(), 'm-1', handlers());
    await pump();
    connection.close();
    expect(attempts[0].signal.aborted).toBe(true);
  });
});
