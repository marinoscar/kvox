import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { connectSse } from '../../services/sse';

/**
 * OPTIONAL / STRETCH coverage for `connectSse` (the reconnect/backoff half of
 * `services/sse.ts`, as opposed to the pure `SseParser` covered in
 * `sse.test.ts`). Kept in its own file so a flaky timing assertion here can
 * never threaten the required parser/stream/context/bell/link/browser-notif
 * suites.
 *
 * A prior code review flagged this exact area - the attempt counter must
 * reset ONLY after a connection that held for `STABLE_CONNECTION_MS`, never
 * merely on connecting - as worth extra scrutiny, so these tests simulate an
 * accept-then-immediately-drop cycle (a struggling backend / restarting API)
 * and assert the reconnect delay keeps growing rather than resetting on every
 * accept.
 */

function makeDroppedResponse() {
  const read = vi.fn().mockResolvedValueOnce({ done: true, value: undefined });
  return {
    status: 200,
    ok: true,
    body: {
      getReader: () => ({ read, releaseLock: vi.fn() }),
      cancel: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function make401Response() {
  return {
    status: 401,
    ok: false,
    body: { cancel: vi.fn().mockResolvedValue(undefined) },
  };
}

/** A response whose stream opens and then simply stays open (read() never resolves). */
function makeOpenResponse() {
  return {
    status: 200,
    ok: true,
    body: {
      getReader: () => ({
        read: () => new Promise(() => {}),
        releaseLock: vi.fn(),
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
    },
  };
}

/** Flush a chain of already-resolved promises under fake timers. */
async function pump(iterations = 25) {
  for (let i = 0; i < iterations; i++) {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  }
}

describe('connectSse (optional stretch coverage)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('the reconnect delay grows across repeated accept-then-immediately-drop cycles (each held well under STABLE_CONNECTION_MS)', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(makeDroppedResponse()));
    vi.stubGlobal('fetch', fetchMock);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const conn = connectSse({
      url: 'http://x/stream',
      authorization: () => null,
      reauthenticate: vi.fn(),
      onOpen: vi.fn(),
      onFrame: vi.fn(),
    });

    // Let the first attempt (fetch -> immediate end-of-stream -> backoff
    // sleep scheduled) settle.
    await pump();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const delays: number[] = [];
    const sleepDelayCalls = () =>
      setTimeoutSpy.mock.calls
        .map((call) => call[1] as number)
        // The sleep() delays are the only "long" setTimeout calls this
        // module schedules; filter out any 0ms bookkeeping ticks.
        .filter((ms) => typeof ms === 'number' && ms > 0);

    // Capture the delay already scheduled by the very first (pre-loop)
    // attempt, then step through exactly THREE more full cycles - kept
    // comfortably under the 30s ceiling (windows for attempts 1-4 are
    // [1000,2000) [2000,4000) [4000,8000) [8000,16000), none overlapping)
    // so growth is unambiguous even with the jitter.
    //
    // `advanceTimersToNextTimerAsync()` (not a large fixed budget) is
    // load-bearing here: advancing by a big fixed window risks firing the
    // NEWLY-scheduled backoff timer too within the same call, cascading
    // through several reconnect cycles at once and corrupting the count.
    delays.push(sleepDelayCalls()[0]);
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersToNextTimerAsync();
      await pump();
      const all = sleepDelayCalls();
      delays.push(all[all.length - 1]);
    }

    conn.close();
    await pump();

    expect(delays).toHaveLength(4);
    // Strictly increasing: proves the counter is INCREMENTING across
    // consecutive accept-then-drop cycles, not resetting to 0 on every
    // accept (the exact bug this test guards against).
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1]);
    }
  });

  it('a 401 triggers reauthenticate() and reconnects WITHOUT a backoff delay when it succeeds', async () => {
    // The second response stays open forever (read() never resolves) so the
    // assertion window below is not polluted by a THIRD, legitimate fetch
    // attempt scheduling its own unrelated backoff.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(make401Response())
      .mockResolvedValueOnce(makeOpenResponse());
    vi.stubGlobal('fetch', fetchMock);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const reauthenticate = vi.fn().mockResolvedValue(true);
    const onOpen = vi.fn();

    const conn = connectSse({
      url: 'http://x/stream',
      authorization: () => null,
      reauthenticate,
      onOpen,
      onFrame: vi.fn(),
    });

    await pump();

    expect(reauthenticate).toHaveBeenCalledTimes(1);
    // Reconnected immediately: the second fetch already happened without
    // needing any timer to advance.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onOpen).toHaveBeenCalledTimes(1);

    // No positive-duration sleep() was scheduled between the two fetches -
    // only the 401 path's "immediate" reconnect, which bypasses backoff
    // entirely.
    const positiveDelays = setTimeoutSpy.mock.calls
      .map((call) => call[1] as number)
      .filter((ms) => typeof ms === 'number' && ms > 0);
    expect(positiveDelays).toHaveLength(0);

    conn.close();
    await pump();
  });

  it('a 401 STOPS retrying (no further fetch calls) when reauthenticate() resolves false', async () => {
    const fetchMock = vi.fn().mockResolvedValue(make401Response());
    vi.stubGlobal('fetch', fetchMock);
    const reauthenticate = vi.fn().mockResolvedValue(false);
    const onStateChange = vi.fn();

    const conn = connectSse({
      url: 'http://x/stream',
      authorization: () => null,
      reauthenticate,
      onOpen: vi.fn(),
      onFrame: vi.fn(),
      onStateChange,
    });

    await pump();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(reauthenticate).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledWith('closed');

    // Advancing time well past any conceivable backoff must not cause a
    // second fetch - the loop has stopped permanently.
    await vi.advanceTimersByTimeAsync(60_000);
    await pump();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    conn.close();
    await pump();
  });
});
