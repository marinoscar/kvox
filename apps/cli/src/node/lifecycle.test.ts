import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DaemonNotRunningError } from './daemon.js';
import type { DaemonMessage } from './ipc-protocol.js';
import { applyConcurrency, readLiveStatus, spawnDetachedDaemon, stopNode } from './lifecycle.js';
import type { NodeSnapshot } from './node-events.js';
import { writePidfile } from './pidfile.js';

// =============================================================================
// stop / status / set-concurrency  (issue #275, epic #254)
// =============================================================================
//
// The connection is injected, so every rung of the ladder is exercised
// deterministically — including the one that is hardest to reach on a real
// machine: "IPC is unavailable AND the process is alive".
// =============================================================================

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'appctl-lifecycle-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function paths(): { pidPath: string; socketPath: string } {
  return { pidPath: join(dir, 'node.pid'), socketPath: join(dir, 'node.sock') };
}

/** A connect that answers with the given messages, then stays open. */
function fakeConnect(messages: DaemonMessage[]) {
  return async (options: { onMessage: (message: DaemonMessage) => void }) => {
    return {
      send: () => {
        for (const message of messages) options.onMessage(message);
      },
      close: () => {},
    };
  };
}

const refusing = async () => {
  throw new DaemonNotRunningError('/nowhere.sock');
};

describe('stopNode — the three-rung ladder', () => {
  it('rung 1: a daemon that acks the stop', async () => {
    const outcome = await stopNode({
      ...paths(),
      connect: fakeConnect([{ type: 'ack', command: 'stop' }]) as never,
    });

    expect(outcome.attempted).toEqual(['ipc']);
    expect(outcome.stoppedBy).toBe('ipc');
    expect(outcome.wasRunning).toBe(true);
  });

  it('rung 2: IPC unavailable, but the pidfile names a live process', async () => {
    const { pidPath, socketPath } = paths();
    writePidfile(pidPath, 4242);
    const killed: Array<[number, string]> = [];
    let alive = true;

    const outcome = await stopNode({
      pidPath,
      socketPath,
      connect: refusing as never,
      kill: (pid, signal) => {
        killed.push([pid, signal]);
        alive = false;
      },
      isAlive: () => alive,
      sleep: async () => {},
    });

    expect(outcome.attempted).toEqual(['ipc', 'signal']);
    expect(outcome.stoppedBy).toBe('signal');
    expect(killed).toEqual([[4242, 'SIGTERM']]);
    expect(outcome.detail).toContain('has exited');
  });

  it('rung 2 reports honestly when the process is still draining', async () => {
    const { pidPath, socketPath } = paths();
    writePidfile(pidPath, 4242);

    const outcome = await stopNode({
      pidPath,
      socketPath,
      timeoutMs: 100,
      connect: refusing as never,
      kill: () => {},
      isAlive: () => true,
      sleep: async () => {},
    });

    expect(outcome.detail).toContain('still draining');
  });

  it('rung 3: nothing running locally, so the SERVER is told the node is gone', async () => {
    const deregister = vi.fn(async () => {});

    const outcome = await stopNode({
      ...paths(),
      connect: refusing as never,
      deregister,
    });

    expect(outcome.attempted).toEqual(['ipc', 'deregister']);
    expect(outcome.stoppedBy).toBe('deregister');
    expect(deregister).toHaveBeenCalledOnce();
  });

  it('reports plainly when there is nothing to stop and no deregister available', async () => {
    const outcome = await stopNode({ ...paths(), connect: refusing as never });
    expect(outcome.stoppedBy).toBeUndefined();
    expect(outcome.wasRunning).toBe(false);
    expect(outcome.detail).toContain('No worker is running');
  });

  it('does not fail the command when rung 3 itself fails', async () => {
    const outcome = await stopNode({
      ...paths(),
      connect: refusing as never,
      deregister: async () => {
        throw new Error('server unreachable');
      },
    });
    expect(outcome.detail).toContain('server unreachable');
  });

  it('skips the signal rung when the pidfile names a dead process', async () => {
    const { pidPath, socketPath } = paths();
    writePidfile(pidPath, 4242);
    const kill = vi.fn();

    const outcome = await stopNode({
      pidPath,
      socketPath,
      connect: refusing as never,
      kill,
      isAlive: () => false,
    });

    expect(kill).not.toHaveBeenCalled();
    expect(outcome.attempted).toEqual(['ipc']);
  });
});

describe('readLiveStatus', () => {
  const snapshot: NodeSnapshot = {
    nodeId: 'node-1',
    status: 'working',
    concurrency: 2,
    eligibleTypes: [],
    activeJobs: [],
    history: [],
    counters: { claimed: 1, succeeded: 1, failed: 0, rateLimited: 0 },
    startedAt: '2026-01-01T00:00:00.000Z',
    lastHeartbeatAt: null,
    heartbeatAgeMs: null,
  };

  it('returns the live snapshot when a daemon answers', async () => {
    const result = await readLiveStatus({
      ...paths(),
      connect: fakeConnect([{ type: 'snapshot', snapshot }]) as never,
    });

    expect(result.live).toBe(true);
    expect(result.snapshot?.nodeId).toBe('node-1');
  });

  it('reports not-live rather than throwing when there is no daemon', async () => {
    // The command falls back to stored config; "cannot connect" is never the
    // whole answer.
    const result = await readLiveStatus({ ...paths(), connect: refusing as never, timeoutMs: 50 });
    expect(result.live).toBe(false);
    expect(result.snapshot).toBeUndefined();
  });
});

describe('applyConcurrency', () => {
  it('applies live over IPC AND persists, so a restart keeps the decision', async () => {
    const persisted: number[] = [];
    const outcome = await applyConcurrency({
      value: 6,
      socketPath: paths().socketPath,
      persist: (value) => persisted.push(value),
      connect: fakeConnect([{ type: 'ack', command: 'set-concurrency' }]) as never,
    });

    expect(outcome.applied).toBe(true);
    expect(persisted).toEqual([6]);
  });

  it('persists without a running daemon — the same command works in both states', async () => {
    const persisted: number[] = [];
    const outcome = await applyConcurrency({
      value: 3,
      socketPath: paths().socketPath,
      persist: (value) => persisted.push(value),
      connect: refusing as never,
      timeoutMs: 50,
    });

    expect(outcome.applied).toBe(false);
    expect(persisted).toEqual([3]);
  });

  it('surfaces the daemon’s refusal of an out-of-range value', async () => {
    await expect(
      applyConcurrency({
        value: 999,
        socketPath: paths().socketPath,
        persist: () => {
          throw new Error('must not persist a refused value');
        },
        connect: fakeConnect([{ type: 'error', message: 'Concurrency must be between 1 and 64 (got 999).' }]) as never,
      }),
    ).rejects.toThrow(/between 1 and 64/);
  });
});

describe('spawnDetachedDaemon', () => {
  it('spawns detached with stdio to the log file and unrefs the child', () => {
    const unref = vi.fn();
    let seen: { command: string; args: string[]; options: Record<string, unknown> } | undefined;

    const pid = spawnDetachedDaemon({
      logPath: join(dir, 'node.log'),
      args: ['node', 'start', '--headless'],
      execPath: '/usr/bin/node',
      scriptPath: '/app/cli.js',
      openFile: () => 7,
      spawnFn: ((command: string, args: string[], options: Record<string, unknown>) => {
        seen = { command, args, options };
        return { pid: 1234, unref } as never;
      }) as never,
    });

    expect(pid).toBe(1234);
    expect(seen?.command).toBe('/usr/bin/node');
    expect(seen?.args).toEqual(['/app/cli.js', 'node', 'start', '--headless']);
    expect(seen?.options.detached).toBe(true);
    expect(seen?.options.stdio).toEqual(['ignore', 7, 7]);
    // Without unref the parent would hold a handle to the child it just
    // detached, and `--daemon` would never return.
    expect(unref).toHaveBeenCalledOnce();
  });
});
