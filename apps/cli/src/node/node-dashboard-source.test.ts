import { describe, expect, it, vi } from 'vitest';

import { DaemonNotRunningError } from './daemon.js';
import type { DaemonMessage } from './ipc-protocol.js';
import {
  MAX_DASHBOARD_LINES,
  NodeDashboardSource,
  describeEvent,
  elapsedMs,
  formatDuration,
  type DashboardState,
} from './node-dashboard-source.js';
import type { NodeSnapshot } from './node-events.js';

// =============================================================================
// The TUI's data source  (issue #279, epic #254)
// =============================================================================
//
// Tested WITHOUT ink, without a terminal and without React — which is the
// reason it lives in `node/` rather than in `tui/`. The properties that matter
// are all non-visual: it never sends a command, it reconnects, and it tears
// down cleanly.
// =============================================================================

function snapshot(overrides: Partial<NodeSnapshot> = {}): NodeSnapshot {
  return {
    nodeId: 'node-1',
    status: 'idle',
    concurrency: 2,
    eligibleTypes: ['example.checksum'],
    activeJobs: [],
    history: [],
    counters: { claimed: 0, succeeded: 0, failed: 0, rateLimited: 0 },
    startedAt: '2026-01-01T00:00:00.000Z',
    lastHeartbeatAt: null,
    heartbeatAgeMs: null,
    ...overrides,
  };
}

/**
 * A fake daemon connection whose messages a test pushes by hand.
 *
 * `send` and `close` are spies, because "the dashboard never sends anything"
 * is the criterion that keeps a headless production worker safe to inspect.
 */
function fakeConnection() {
  const send = vi.fn();
  const close = vi.fn();
  let push: ((message: DaemonMessage) => void) | undefined;
  let closePeer: (() => void) | undefined;
  let attempts = 0;

  return {
    send,
    close,
    attempts: () => attempts,
    push: (message: DaemonMessage) => push?.(message),
    dropConnection: () => closePeer?.(),
    connect: (async (options: {
      onMessage: (message: DaemonMessage) => void;
      onClose?: (() => void) | undefined;
    }) => {
      attempts += 1;
      push = options.onMessage;
      closePeer = options.onClose;
      return { send, close };
    }) as never,
  };
}

describe('NodeDashboardSource', () => {
  it('renders live events without ever sending a command', async () => {
    const peer = fakeConnection();
    const states: DashboardState[] = [];

    const source = new NodeDashboardSource({
      socketPath: '/tmp/node.sock',
      connect: peer.connect,
      onChange: (state) => states.push(state),
    });

    await source.start();

    peer.push({ type: 'snapshot', snapshot: snapshot({ status: 'working' }) });
    peer.push({ type: 'event', event: { kind: 'idle', at: '2026-01-01T00:00:00.000Z' } });
    peer.push({ type: 'log-tail', lines: [{ ts: 'T', level: 'info', msg: 'hello' }] });

    const state = source.getState();
    expect(state.connected).toBe(true);
    expect(state.snapshot?.status).toBe('working');
    expect(state.events).toHaveLength(1);
    expect(state.logs).toHaveLength(1);

    // THE criterion: an operator can inspect a container running production
    // work without perturbing it.
    expect(peer.send).not.toHaveBeenCalled();
  });

  it('publishes a NEW object every time, so React actually re-renders', async () => {
    const peer = fakeConnection();
    const states: DashboardState[] = [];
    const source = new NodeDashboardSource({
      socketPath: '/tmp/node.sock',
      connect: peer.connect,
      onChange: (state) => states.push(state),
    });

    await source.start();
    peer.push({ type: 'snapshot', snapshot: snapshot() });

    // Mutating in place renders the first frame and then never updates — the
    // classic "the TUI is frozen" bug.
    expect(states.length).toBeGreaterThan(1);
    expect(states[0]).not.toBe(states[states.length - 1]);
  });

  it('detaching closes the client and leaves the daemon alone', async () => {
    const peer = fakeConnection();
    const source = new NodeDashboardSource({
      socketPath: '/tmp/node.sock',
      connect: peer.connect,
      onChange: () => {},
    });

    await source.start();
    source.stop();

    expect(peer.close).toHaveBeenCalledOnce();
    // Nothing was ever asked of the daemon, including on the way out.
    expect(peer.send).not.toHaveBeenCalled();
    expect(source.getState().connected).toBe(false);
  });

  it('stop() is idempotent and clears the reconnect timer', async () => {
    const peer = fakeConnection();
    const cleared: unknown[] = [];
    const source = new NodeDashboardSource({
      socketPath: '/tmp/node.sock',
      connect: peer.connect,
      onChange: () => {},
      setTimer: () => 'timer-handle',
      clearTimer: (handle) => cleared.push(handle),
    });

    await source.start();
    peer.dropConnection();
    source.stop();
    source.stop();

    // A timer left behind keeps a finished ink process alive, which looks
    // exactly like a hang. Cleared exactly once, even though stop() was
    // called twice.
    expect(cleared).toEqual(['timer-handle']);
    // No client to close: the peer had already dropped, so the source released
    // it then. Closing a stale handle would be the bug here, not a nicety.
    expect(peer.close).not.toHaveBeenCalled();
    expect(source.getState().connected).toBe(false);
  });

  it('reconnects when the worker restarts under it', async () => {
    const peer = fakeConnection();
    let fire: (() => void) | undefined;

    const source = new NodeDashboardSource({
      socketPath: '/tmp/node.sock',
      connect: peer.connect,
      onChange: () => {},
      setTimer: (fn) => {
        fire = fn;
        return 1;
      },
      clearTimer: () => {},
    });

    await source.start();
    expect(peer.attempts()).toBe(1);

    // The memory valve exits deliberately and a supervisor brings the worker
    // back; a dashboard that died with it would be useless in exactly the
    // situation somebody opened it for.
    peer.dropConnection();
    expect(source.getState().connected).toBe(false);

    fire?.();
    await vi.waitFor(() => expect(peer.attempts()).toBe(2));
    await vi.waitFor(() => expect(source.getState().connected).toBe(true));
  });

  it('reports "no worker is running" distinctly from any other failure', async () => {
    const source = new NodeDashboardSource({
      socketPath: '/tmp/node.sock',
      connect: (async () => {
        throw new DaemonNotRunningError('/tmp/node.sock');
      }) as never,
      onChange: () => {},
      setTimer: () => 1,
      clearTimer: () => {},
    });

    await source.start();
    expect(source.getState().error).toBe('No worker is running here.');
    expect(source.getState().everConnected).toBe(false);
  });

  it('does not reconnect after stop()', async () => {
    const peer = fakeConnection();
    let fire: (() => void) | undefined;

    const source = new NodeDashboardSource({
      socketPath: '/tmp/node.sock',
      connect: peer.connect,
      onChange: () => {},
      setTimer: (fn) => {
        fire = fn;
        return 1;
      },
      clearTimer: () => {},
    });

    await source.start();
    peer.dropConnection();
    source.stop();
    fire?.();

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(peer.attempts()).toBe(1);
  });

  it('bounds the log and event buffers', async () => {
    const peer = fakeConnection();
    const source = new NodeDashboardSource({
      socketPath: '/tmp/node.sock',
      connect: peer.connect,
      onChange: () => {},
      maxLines: 5,
    });

    await source.start();
    for (let i = 0; i < 20; i += 1) {
      peer.push({ type: 'event', event: { kind: 'idle', at: `t${i}` } });
      peer.push({ type: 'log-tail', lines: [{ ts: `t${i}`, level: 'info', msg: `line ${i}` }] });
    }

    expect(source.getState().events).toHaveLength(5);
    expect(source.getState().logs).toHaveLength(5);
    expect(source.getState().logs[4]?.msg).toBe('line 19');
    expect(MAX_DASHBOARD_LINES).toBe(200);
  });

  it('ignores an ack — this source sends nothing, so one can only be another client’s', async () => {
    const peer = fakeConnection();
    const source = new NodeDashboardSource({
      socketPath: '/tmp/node.sock',
      connect: peer.connect,
      onChange: () => {},
    });

    await source.start();
    peer.push({ type: 'ack', command: 'set-concurrency', detail: { value: 8 } });

    expect(source.getState().error).toBeUndefined();
    expect(source.getState().events).toEqual([]);
  });

  it('surfaces a daemon error message', async () => {
    const peer = fakeConnection();
    const source = new NodeDashboardSource({
      socketPath: '/tmp/node.sock',
      connect: peer.connect,
      onChange: () => {},
    });

    await source.start();
    peer.push({ type: 'error', message: 'Heap snapshots are disabled on this worker.' });
    expect(source.getState().error).toContain('disabled');
  });
});

describe('describeEvent', () => {
  it('renders every event kind to a single line', () => {
    // Exhaustive by construction: `describeEvent` switches on the union with
    // no default, so a new kind is a compile error rather than a blank row.
    expect(describeEvent({ kind: 'idle', at: 't' })).toBe('idle');
    expect(
      describeEvent({
        kind: 'job-failed',
        at: 't',
        jobId: 'j1',
        type: 'example.checksum',
        durationMs: 5,
        error: 'boom',
        rateLimited: true,
        willRetry: true,
      }),
    ).toContain('rate limited');
    expect(
      describeEvent({ kind: 'job-succeeded', at: 't', jobId: 'j1', type: 'x', durationMs: 12, outcome: 'succeeded' }),
    ).toContain('12ms');
  });
});

describe('formatDuration', () => {
  it('stays short enough for a narrow column', () => {
    expect(formatDuration(5_000)).toBe('5s');
    expect(formatDuration(64_000)).toBe('1m 04s');
    expect(formatDuration(7_500_000)).toBe('2h 05m');
  });
});

describe('elapsedMs', () => {
  it('measures from an ISO timestamp and never goes negative', () => {
    const now = Date.parse('2026-01-01T00:01:00.000Z');
    expect(elapsedMs('2026-01-01T00:00:00.000Z', now)).toBe(60_000);
    expect(elapsedMs('2026-01-01T00:02:00.000Z', now)).toBe(0);
    expect(elapsedMs('not a date', now)).toBe(0);
  });
});
