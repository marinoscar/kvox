import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFetchSseConnect } from '../../src/core/headless/index.js';
import type { KvoxSseEvent } from '../../src/core/headless/index.js';

/** A streamed event-stream response made of the given chunks. */
function streamResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(status === 200 ? body : null, { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createFetchSseConnect', () => {
  it('frames events across chunk boundaries, ignores comments and reports the stream open', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([': connected\n\nid: 5\nevent: de', 'lta\ndata: hel', 'lo\n\n'])));
    const connect = createFetchSseConnect({
      baseUrl: '/api',
      authorization: () => 'Bearer t1',
      reauthenticate: async () => true,
    });
    const events: KvoxSseEvent[] = [];
    const onOpen = vi.fn();

    await connect('/ask/stream', { signal: new AbortController().signal, onOpen, onEvent: (e) => events.push(e) });

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{ event: 'delta', data: 'hello', id: '5' }]);
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('/api/ask/stream');
    expect((init as RequestInit).headers).toMatchObject({ Accept: 'text/event-stream', Authorization: 'Bearer t1' });
  });

  it('sends the resume point as Last-Event-ID', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([])));
    const connect = createFetchSseConnect({ baseUrl: '/api', authorization: () => null, reauthenticate: async () => true });

    await connect('/s', { lastEventId: '77', signal: new AbortController().signal, onEvent: () => undefined });

    const headers = (vi.mocked(fetch).mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['Last-Event-ID']).toBe('77');
    expect(headers.Authorization).toBeUndefined();
  });

  it('renews credentials once on a 401 and retries the request', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(streamResponse([], 401))
      .mockResolvedValueOnce(streamResponse(['data: ok\n\n']));
    vi.stubGlobal('fetch', fetchMock);
    let token = 'old';
    const reauthenticate = vi.fn(async () => {
      token = 'new';
      return true;
    });
    const connect = createFetchSseConnect({ baseUrl: '', authorization: () => `Bearer ${token}`, reauthenticate });
    const events: KvoxSseEvent[] = [];

    await connect('/s', { signal: new AbortController().signal, onEvent: (e) => events.push(e) });

    expect(reauthenticate).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1]![1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer new' });
    expect(events).toEqual([{ event: 'message', data: 'ok' }]);
  });

  it('rejects with a 401 KvoxApiError when renewal fails or the retry is refused again', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([], 401)));
    const refused = createFetchSseConnect({ baseUrl: '', authorization: () => null, reauthenticate: async () => false });
    await expect(refused('/s', { signal: new AbortController().signal, onEvent: () => undefined })).rejects.toMatchObject({ status: 401 });

    const again = createFetchSseConnect({ baseUrl: '', authorization: () => null, reauthenticate: async () => true });
    await expect(again('/s', { signal: new AbortController().signal, onEvent: () => undefined })).rejects.toMatchObject({ status: 401 });
  });

  it('rejects on any other failure status so the loop retries', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([], 502)));
    const connect = createFetchSseConnect({ baseUrl: '', authorization: () => null, reauthenticate: async () => true });

    await expect(connect('/s', { signal: new AbortController().signal, onEvent: () => undefined })).rejects.toThrow(/502/);
  });
});
