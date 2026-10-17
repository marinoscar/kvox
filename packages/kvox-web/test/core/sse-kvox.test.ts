import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { connectKvoxSse, KvoxApiError } from '../../src/core/headless/index.js';
import type { KvoxSseConnectOptions, SseState } from '../../src/core/headless/index.js';
import { createFakeKvoxWebHost } from '../../src/core/testing/index.js';

/** Flush resolved promises under fake timers. */
async function pump(iterations = 25) {
  for (let i = 0; i < iterations; i += 1) {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  }
}

describe('connectKvoxSse', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers the events of a scripted stream and reports it open', async () => {
    const host = createFakeKvoxWebHost({
      sse: { '/stream': [{ event: 'delta', data: 'a', id: '1' }, { event: 'done', data: 'b', id: '2' }] },
    });
    const controller = new AbortController();
    const events: string[] = [];
    const onOpen = vi.fn();

    const loop = connectKvoxSse(host, '/stream', {
      signal: controller.signal,
      onOpen,
      onEvent: (event) => events.push(`${event.event}:${event.data}`),
    });
    await pump();
    controller.abort();
    await loop;

    expect(events.slice(0, 2)).toEqual(['delta:a', 'done:b']);
    expect(onOpen).toHaveBeenCalled();
  });

  it('resumes with the id of the last event it saw when the stream drops', async () => {
    const attempts: Array<string | undefined> = [];
    const host = createFakeKvoxWebHost();
    host.sse.connect = async (_path: string, options: KvoxSseConnectOptions) => {
      attempts.push(options.lastEventId);
      options.onOpen?.();
      if (attempts.length === 1) {
        options.onEvent({ event: 'delta', data: 'one', id: '10' });
        options.onEvent({ event: 'delta', data: 'two', id: '11' });
      }
      // The stream ends; the loop must reconnect.
    };
    const controller = new AbortController();

    const loop = connectKvoxSse(host, '/stream', { signal: controller.signal, onEvent: () => undefined });
    await pump();
    // The first backoff is 1 to 2 s (the attempt counter moves before the wait).
    await vi.advanceTimersByTimeAsync(2_100);
    await pump();
    controller.abort();
    await loop;

    expect(attempts[0]).toBeUndefined();
    expect(attempts[1]).toBe('11');
  });

  it('starts from the lastEventId the caller seeds', async () => {
    const seen: Array<string | undefined> = [];
    const host = createFakeKvoxWebHost();
    host.sse.connect = async (_path, options) => {
      seen.push(options.lastEventId);
      options.onOpen?.();
      await new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve()));
    };
    const controller = new AbortController();

    const loop = connectKvoxSse(host, '/stream', {
      lastEventId: '42',
      signal: controller.signal,
      onEvent: () => undefined,
    });
    await pump();
    controller.abort();
    await loop;

    expect(seen).toEqual(['42']);
  });

  it('backs off with a growing delay between attempts that drop at once', async () => {
    let attempts = 0;
    const host = createFakeKvoxWebHost();
    host.sse.connect = async (_path, options) => {
      attempts += 1;
      options.onOpen?.();
    };
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const controller = new AbortController();

    const loop = connectKvoxSse(host, '/stream', { signal: controller.signal, onEvent: () => undefined });
    await pump();
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(2_100);
    await pump();
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(4_100);
    await pump();
    expect(attempts).toBe(3);

    const delays = spy.mock.calls.map((call) => call[1]).filter((ms): ms is number => typeof ms === 'number' && ms >= 500);
    controller.abort();
    await loop;
    spy.mockRestore();

    // Jittered into [cap/2, cap] and doubling: 1-2 s, then 2-4 s.
    expect(delays[0]).toBeGreaterThanOrEqual(1_000);
    expect(delays[0]).toBeLessThanOrEqual(2_000);
    expect(delays[1]).toBeGreaterThanOrEqual(2_000);
    expect(delays[1]).toBeLessThanOrEqual(4_000);
  });

  it('stops and rejects when the host reports the session over (401)', async () => {
    let attempts = 0;
    const host = createFakeKvoxWebHost();
    host.sse.connect = async () => {
      attempts += 1;
      throw new KvoxApiError('Unauthorized', 401);
    };
    const states: SseState[] = [];

    const loop = connectKvoxSse(host, '/stream', {
      onEvent: () => undefined,
      onStateChange: (state) => states.push(state),
    });
    const settled = loop.catch((e: unknown) => e);
    await pump();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await settled).toMatchObject({ status: 401 });
    expect(attempts).toBe(1);
    expect(states.at(-1)).toBe('closed');
  });

  it('retries any other failure', async () => {
    let attempts = 0;
    const host = createFakeKvoxWebHost();
    host.sse.connect = async () => {
      attempts += 1;
      throw new Error('502');
    };
    const controller = new AbortController();

    const loop = connectKvoxSse(host, '/stream', { signal: controller.signal, onEvent: () => undefined });
    await pump();
    await vi.advanceTimersByTimeAsync(2_100);
    await pump();
    controller.abort();
    await loop;

    expect(attempts).toBeGreaterThanOrEqual(2);
  });
});
