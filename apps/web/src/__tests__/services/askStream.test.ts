import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The Ask answer stream client (#380, #379's frames).
 *
 * `services/sse.ts` is MOCKED (it has its own suite); what is proven here is
 * the layer above it: frames parsed and validated, deltas written at their
 * OFFSET (so a reconnect's replay never duplicates text), steps de-duplicated
 * by `index`, and a terminal frame closing the connection before its callback.
 */

const connections: Array<{
  url: string;
  onFrame: (frame: { event: string; data: string; id: string | null }) => void;
  onOpen: () => void;
  close: ReturnType<typeof vi.fn>;
}> = [];

vi.mock('../../services/sse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/sse')>();
  return {
    ...actual,
    connectSse: vi.fn((options: Parameters<typeof actual.connectSse>[0]) => {
      const close = vi.fn();
      connections.push({ url: options.url, onFrame: options.onFrame, onOpen: options.onOpen, close });
      return { close };
    }),
  };
});

import { API_BASE_URL } from '../../services/api';
import {
  applyDelta,
  askMessageStreamUrl,
  connectAskStream,
  parseAskCitation,
  parseAskDelta,
  parseAskDone,
  parseAskError,
  parseAskStep,
} from '../../services/askStream';
import type { AskStreamHandlers } from '../../services/askStream';

function frame(event: string, data: unknown) {
  return { event, data: typeof data === 'string' ? data : JSON.stringify(data), id: null };
}

function handlers(): AskStreamHandlers & { [K in keyof AskStreamHandlers]: ReturnType<typeof vi.fn> } {
  return {
    onContent: vi.fn(),
    onStep: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
  };
}

beforeEach(() => {
  connections.length = 0;
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
  it('connects to the message stream URL, from the offset it already holds', () => {
    connectAskStream('m-1', handlers());
    connectAskStream('m 2', handlers(), { content: 'Already here' });
    expect(connections[0].url).toBe(`${API_BASE_URL}/ask/messages/m-1/stream`);
    expect(connections[1].url).toBe(`${API_BASE_URL}/ask/messages/m%202/stream?lastEventId=12`);
    expect(askMessageStreamUrl('x', 0)).toBe(`${API_BASE_URL}/ask/messages/x/stream`);
  });

  it('reconciles deltas from a resume offset and survives a reconnect without duplicating text', () => {
    const h = handlers();
    connectAskStream('m-1', h, { content: 'The Atlas' });
    const { onFrame, onOpen } = connections[0];

    onFrame(frame('delta', { delta: ' beta', offset: 14 }));
    expect(h.onContent).toHaveBeenLastCalledWith('The Atlas beta');

    // The socket drops; the reconnect replays from the URL's offset (9).
    onOpen();
    onFrame(frame('delta', { delta: ' beta', offset: 14 }));
    onFrame(frame('delta', { delta: ' ships.', offset: 21 }));
    expect(h.onContent).toHaveBeenLastCalledWith('The Atlas beta ships.');
    // The replayed frame changed nothing, so it did not re-render.
    expect(h.onContent).toHaveBeenCalledTimes(2);
  });

  it('reports each step once, however often it is re-sent, skipping ones already held', () => {
    const h = handlers();
    connectAskStream('m-1', h, { knownStepIndexes: [0] });
    const { onFrame } = connections[0];
    const step = (index: number) =>
      frame('step', { index, name: 'search', summary: `Step ${index}`, resultCount: 1, error: null, offset: 0 });

    onFrame(step(0));
    onFrame(step(1));
    onFrame(step(1));
    onFrame(step(2));
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

  it('closes on done BEFORE calling back, and ignores anything after', () => {
    const h = handlers();
    connectAskStream('m-1', h);
    const conn = connections[0];
    h.onDone.mockImplementation(() => expect(conn.close).toHaveBeenCalledTimes(1));

    conn.onFrame(frame('done', { status: 'succeeded', offset: 0, finishReason: 'stop', citations: [], promptTokens: null, completionTokens: null }));
    conn.onFrame(frame('delta', { delta: 'late', offset: 4 }));
    conn.onFrame(frame('done', { status: 'succeeded', offset: 0, finishReason: 'stop', citations: [] }));
    expect(h.onDone).toHaveBeenCalledTimes(1);
    expect(h.onDone).toHaveBeenCalledWith({ citations: [], finishReason: 'stop' });
    expect(h.onContent).not.toHaveBeenCalled();
  });

  it('dispatches an error frame and closes', () => {
    const h = handlers();
    connectAskStream('m-1', h);
    const conn = connections[0];
    conn.onFrame(frame('error', { status: 'failed', offset: 0, errorClass: 'rate_limit', reason: null }));
    expect(conn.close).toHaveBeenCalled();
    expect(h.onError).toHaveBeenCalledWith({ errorClass: 'rate_limit', reason: null });
  });

  it('costs one frame, not the stream, for garbage and ignores unknown events', () => {
    const h = handlers();
    connectAskStream('m-1', h);
    const { onFrame } = connections[0];
    onFrame(frame('delta', 'not json'));
    onFrame(frame('mystery', { anything: true }));
    onFrame(frame('delta', { delta: 'ok', offset: 2 }));
    expect(h.onContent).toHaveBeenCalledTimes(1);
    expect(h.onContent).toHaveBeenCalledWith('ok');
  });
});
