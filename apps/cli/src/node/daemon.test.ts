import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DaemonAlreadyRunningError, connectToDaemon, startDaemonHost, DaemonNotRunningError } from './daemon.js';
import { type DaemonMessage } from './ipc-protocol.js';
import { NodeLogger } from './logger.js';
import type { NodeEngine } from './node-engine.js';
import type { NodeSnapshot } from './node-events.js';
import { checkForRunningInstance, isProcessAlive, readPidfile, removeOwnPidfile, writePidfile } from './pidfile.js';

// =============================================================================
// The daemon host  (issue #275, epic #254)
// =============================================================================
//
// These drive REAL Unix sockets in a temp directory. Framing and command
// dispatch are unit-tested separately; what needs a real socket is the part
// that is about sockets: stale detection, the `0600` mode, and the fact that a
// dropped client does not disturb the others.
// =============================================================================

let dir: string;
let cleanups: Array<() => Promise<void> | void>;

function paths(): { pidPath: string; socketPath: string } {
  return { pidPath: join(dir, 'node.pid'), socketPath: join(dir, 'node.sock') };
}

function snapshot(): NodeSnapshot {
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
  };
}

/** Just enough engine for the host: the host only ever calls these three. */
function fakeEngine(overrides: Partial<NodeEngine> = {}): NodeEngine {
  return {
    getSnapshot: () => snapshot(),
    setConcurrency: () => {},
    drain: async () => {},
    stop: async () => {},
    ...overrides,
  } as unknown as NodeEngine;
}

function logger(): NodeLogger {
  return new NodeLogger({ path: join(dir, 'logs', 'node.log') });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'appctl-daemon-'));
  cleanups = [];
});

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  rmSync(dir, { recursive: true, force: true });
});

describe('pidfile helpers', () => {
  it('treats this process as alive and a nonsense pid as dead', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
  });

  it('counts EPERM as alive — a live process owned by someone else', () => {
    const kill = (): never => {
      const error = new Error('EPERM') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    };
    expect(isProcessAlive(4242, kill)).toBe(true);
  });

  it('removes the pidfile only when it still names this process', () => {
    const { pidPath } = paths();
    writePidfile(pidPath, 111);
    // A slow drain can outlive its replacement; removing another instance's
    // pidfile would make every later stop/status report no daemon running.
    expect(removeOwnPidfile(pidPath, 222)).toBe(false);
    expect(readPidfile(pidPath)).toBe(111);
    expect(removeOwnPidfile(pidPath, 111)).toBe(true);
    expect(existsSync(pidPath)).toBe(false);
  });

  it('reclaims a stale pidfile and a stale socket file', async () => {
    const { pidPath, socketPath } = paths();
    writePidfile(pidPath, 999_999); // almost certainly not a live pid
    writeFileSync(socketPath, ''); // a leftover file, nothing listening

    const check = await checkForRunningInstance({ pidPath, socketPath });
    expect(check.running).toBe(false);
    expect(check.reclaimed).toEqual(['pidfile', 'socket']);
    expect(existsSync(socketPath)).toBe(false);
  });

  it('refuses when something is actually listening on the socket', async () => {
    const { pidPath, socketPath } = paths();
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const check = await checkForRunningInstance({ pidPath, socketPath });
    expect(check.running).toBe(true);
    // NOT unlinked: unlinking a live socket would leave a running daemon
    // permanently unreachable.
    expect(existsSync(socketPath)).toBe(true);
  });
});

describe('startDaemonHost', () => {
  it('listens, creates a 0600 socket and pidfile, and pushes a snapshot on connect', async () => {
    const { pidPath, socketPath } = paths();
    const host = await startDaemonHost(fakeEngine(), logger(), { pidPath, socketPath });
    cleanups.push(() => host.close());

    expect(statSync(pidPath).mode & 0o777).toBe(0o600);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(readPidfile(pidPath)).toBe(process.pid);

    const messages: DaemonMessage[] = [];
    const client = await connectToDaemon({ socketPath, onMessage: (message) => messages.push(message) });
    cleanups.push(() => client.close());

    await waitFor(() => messages.some((message) => message.type === 'snapshot'));
    expect(messages[0]).toMatchObject({ type: 'snapshot' });
  });

  it('refuses to start when a live daemon already holds the directory', async () => {
    const { pidPath, socketPath } = paths();
    const host = await startDaemonHost(fakeEngine(), logger(), { pidPath, socketPath });
    cleanups.push(() => host.close());

    await expect(startDaemonHost(fakeEngine(), logger(), { pidPath, socketPath })).rejects.toBeInstanceOf(
      DaemonAlreadyRunningError,
    );
  });

  it('applies set-concurrency live and acks it', async () => {
    const { pidPath, socketPath } = paths();
    const applied: number[] = [];
    const host = await startDaemonHost(fakeEngine({ setConcurrency: (value: number) => applied.push(value) }), logger(), {
      pidPath,
      socketPath,
    });
    cleanups.push(() => host.close());

    const messages: DaemonMessage[] = [];
    const client = await connectToDaemon({ socketPath, onMessage: (message) => messages.push(message) });
    cleanups.push(() => client.close());

    client.send({ type: 'set-concurrency', value: 6 });
    await waitFor(() => messages.some((message) => message.type === 'ack'));
    expect(applied).toEqual([6]);
  });

  it('refuses an out-of-range concurrency with a clear error and keeps serving', async () => {
    const { pidPath, socketPath } = paths();
    const applied: number[] = [];
    const host = await startDaemonHost(fakeEngine({ setConcurrency: (value: number) => applied.push(value) }), logger(), {
      pidPath,
      socketPath,
    });
    cleanups.push(() => host.close());

    const messages: DaemonMessage[] = [];
    const client = await connectToDaemon({ socketPath, onMessage: (message) => messages.push(message) });
    cleanups.push(() => client.close());

    client.send({ type: 'set-concurrency', value: 999 });
    await waitFor(() => messages.some((message) => message.type === 'error'));
    expect(applied).toEqual([]);

    client.send({ type: 'status' });
    await waitFor(() => messages.filter((message) => message.type === 'snapshot').length >= 2);
  });

  it('answers an unrecognised command with an error rather than closing', async () => {
    const { pidPath, socketPath } = paths();
    const host = await startDaemonHost(fakeEngine(), logger(), { pidPath, socketPath });
    cleanups.push(() => host.close());

    const messages: DaemonMessage[] = [];
    const client = await connectToDaemon({ socketPath, onMessage: (message) => messages.push(message) });
    cleanups.push(() => client.close());

    client.send({ type: 'nonsense' } as never);
    await waitFor(() => messages.some((message) => message.type === 'error'));
  });

  it('says heap snapshots are unsupported when none is wired', async () => {
    const { pidPath, socketPath } = paths();
    const host = await startDaemonHost(fakeEngine(), logger(), { pidPath, socketPath });
    cleanups.push(() => host.close());

    const messages: DaemonMessage[] = [];
    const client = await connectToDaemon({ socketPath, onMessage: (message) => messages.push(message) });
    cleanups.push(() => client.close());

    client.send({ type: 'heap-snapshot' });
    await waitFor(() =>
      messages.some((message) => message.type === 'error' && message.message.includes('disabled')),
    );
  });

  it('broadcasts events to every attached client', async () => {
    const { pidPath, socketPath } = paths();
    const host = await startDaemonHost(fakeEngine(), logger(), { pidPath, socketPath });
    cleanups.push(() => host.close());

    const a: DaemonMessage[] = [];
    const b: DaemonMessage[] = [];
    const clientA = await connectToDaemon({ socketPath, onMessage: (message) => a.push(message) });
    const clientB = await connectToDaemon({ socketPath, onMessage: (message) => b.push(message) });
    cleanups.push(() => {
      clientA.close();
      clientB.close();
    });

    await waitFor(() => host.clientCount() === 2);
    host.broadcast({ kind: 'idle', at: '2026-01-01T00:00:00.000Z' });

    await waitFor(() => a.some((message) => message.type === 'event'));
    await waitFor(() => b.some((message) => message.type === 'event'));
  });

  it('drops a client whose write backlog exceeds the cap, and keeps serving the others', async () => {
    const { pidPath, socketPath } = paths();
    const host = await startDaemonHost(fakeEngine(), logger(), { pidPath, socketPath });
    cleanups.push(() => host.close());

    // A HEALTHY client — it reads, so its backlog stays at zero.
    const healthy: DaemonMessage[] = [];
    const client = await connectToDaemon({ socketPath, onMessage: (message) => healthy.push(message) });
    cleanups.push(() => client.close());

    // A WEDGED client: connected, never reads. This is a scrolled terminal, a
    // Ctrl-Z'd `logs --follow`, a stopped tmux pane. Note that its writes do
    // NOT fail — Node buffers them on the worker's heap, which is exactly how
    // a stuck terminal can OOM production work.
    const wedged = connect(socketPath);
    await new Promise<void>((resolve) => wedged.once('connect', () => resolve()));
    cleanups.push(() => {
      wedged.destroy();
    });

    await waitFor(() => host.clientCount() === 2);

    const big = 'x'.repeat(512 * 1024);
    for (let i = 0; i < 8 && host.clientCount() > 1; i += 1) {
      host.broadcast({
        kind: 'job-failed',
        at: '2026-01-01T00:00:00.000Z',
        jobId: `j${i}`,
        type: 'test',
        durationMs: 1,
        error: big,
        rateLimited: false,
        willRetry: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await waitFor(() => host.clientCount() === 1);
    // The healthy client is still attached and still receiving.
    host.broadcast({ kind: 'idle', at: '2026-01-01T00:00:01.000Z' });
    await waitFor(() => healthy.some((message) => message.type === 'event'));
  });

  it('removes the socket and the pidfile on close', async () => {
    const { pidPath, socketPath } = paths();
    const host = await startDaemonHost(fakeEngine(), logger(), { pidPath, socketPath });
    await host.close();

    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(pidPath)).toBe(false);
    // Idempotent.
    await expect(host.close()).resolves.toBeUndefined();
  });
});

describe('connectToDaemon', () => {
  it('reports a named error when nothing is listening', async () => {
    await expect(
      connectToDaemon({ socketPath: join(dir, 'absent.sock'), onMessage: () => {}, timeoutMs: 200 }),
    ).rejects.toBeInstanceOf(DaemonNotRunningError);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for a condition');
}
