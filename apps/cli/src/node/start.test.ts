import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONFIG_DIR_NAME, CONFIG_FILE_NAME } from '../branding.js';
import type { NodeApi } from './node-api.js';
import { EXIT_MISSING_CAPABILITY, startNode } from './start.js';
import { WORKER_ENV } from './worker-env.js';

// =============================================================================
// `node start` wiring  (issue #275, epic #254)
// =============================================================================
//
// One property is asserted here above all others: `--headless` drains on
// SIGTERM WITHOUT deregistering. A container that deregistered on every
// SIGTERM would leak a node row per restart, and a crash-looping replica would
// fill the fleet page with corpses.
// =============================================================================

let home: string;
let started: Array<{ stop: () => Promise<void> }>;

function writeConfig(body: unknown): void {
  const dir = join(home, CONFIG_DIR_NAME);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, CONFIG_FILE_NAME), JSON.stringify(body), { mode: 0o600 });
}

function api(record: { deregisters: number; claims: number }): NodeApi {
  return {
    async claim() {
      record.claims += 1;
      return [];
    },
    async heartbeat() {
      return {} as never;
    },
    async deregister() {
      record.deregisters += 1;
    },
    register: async () => ({
      node: {
        id: 'node-new',
        name: 'worker-1',
        hostname: 'box',
        platform: 'linux',
        cliVersion: '1.0.0',
        eligibleTypes: [],
        concurrency: 1,
        status: 'online',
        capabilities: {},
        registeredAt: '2026-01-01T00:00:00.000Z',
        lastHeartbeatAt: null,
      },
      reattached: false,
    }),
    jobTypes: async () => [],
    listNodes: async () => [],
    getNode: async () => {
      throw new Error('unexpected');
    },
    renewLease: async () => {
      throw new Error('unexpected');
    },
    downloadUrl: async () => {
      throw new Error('unexpected');
    },
    uploadUrl: async () => {
      throw new Error('unexpected');
    },
    jobSecret: async () => {
      throw new Error('unexpected');
    },
    submitResult: async () => {
      throw new Error('unexpected');
    },
    reportJobFailure: async () => {
      throw new Error('unexpected');
    },
  } as NodeApi;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'appctl-start-'));
  started = [];
});

afterEach(async () => {
  for (const handle of started) await handle.stop();
  rmSync(home, { recursive: true, force: true });
});

describe('startNode', () => {
  it('registers on first start, hosts the socket, and persists the node id', async () => {
    writeConfig({ serverUrl: 'https://app.example.com', token: 'nod_x' });
    const record = { deregisters: 0, claims: 0 };
    const stderr = { lines: [] as string[], write(chunk: string) { this.lines.push(chunk); return true; } };

    const node = await startNode({
      home,
      env: { [WORKER_ENV.stateDir]: join(home, 'state'), [WORKER_ENV.pollMs]: '250' },
      stderr,
      createApi: () => api(record),
      installSignalHandlers: () => {},
    });
    started.push({ stop: async () => { await node.engine.stop({ deregister: false }); await node.finished; } });

    expect(node.engine.nodeId).toBe('node-new');
    expect(stderr.lines.join('')).toContain('node-new');
  });

  it('headless: SIGTERM drains WITHOUT deregistering', async () => {
    writeConfig({ serverUrl: 'https://app.example.com', token: 'nod_x', nodeId: 'node-1' });
    const record = { deregisters: 0, claims: 0 };
    let fire: ((signal: NodeJS.Signals) => void) | undefined;

    const node = await startNode({
      home,
      env: { [WORKER_ENV.stateDir]: join(home, 'state'), [WORKER_ENV.pollMs]: '250' },
      headless: true,
      createApi: () => api(record),
      installSignalHandlers: (handler) => {
        fire = handler;
      },
    });

    fire?.('SIGTERM');
    await node.finished;

    // The node row survives, so a restarting replica re-attaches instead of
    // leaking a second one.
    expect(record.deregisters).toBe(0);
    expect(node.engine.getSnapshot().status).toBe('stopped');
  });

  it('interactive: SIGINT stops AND deregisters', async () => {
    writeConfig({ serverUrl: 'https://app.example.com', token: 'nod_x', nodeId: 'node-1' });
    const record = { deregisters: 0, claims: 0 };
    let fire: ((signal: NodeJS.Signals) => void) | undefined;

    const node = await startNode({
      home,
      env: { [WORKER_ENV.stateDir]: join(home, 'state2'), [WORKER_ENV.pollMs]: '250' },
      stderr: { write: () => true },
      createApi: () => api(record),
      installSignalHandlers: (handler) => {
        fire = handler;
      },
    });

    fire?.('SIGINT');
    await node.finished;

    // A human stopping a worker on their laptop means it is going away.
    expect(record.deregisters).toBe(1);
  });

  it('hard-exits when an advertised type is missing a REQUIRED capability', async () => {
    // The worst failure a worker has is starting successfully and then failing
    // every job it claims — it looks healthy while draining the queue into the
    // failed pile, charging each job an attempt on the way.
    writeConfig({
      serverUrl: 'https://app.example.com',
      token: 'nod_x',
      nodeId: 'node-1',
      node: { eligibleTypes: ['video.transcode'] },
    });

    const exits: number[] = [];
    const stderr = { lines: [] as string[], write(chunk: string) { this.lines.push(chunk); return true; } };

    await expect(
      startNode({
        home,
        env: { [WORKER_ENV.stateDir]: join(home, 'state-fail') },
        headless: true,
        stderr,
        createApi: () => api({ deregisters: 0, claims: 0 }),
        installSignalHandlers: () => {},
        requirements: { 'video.transcode': { required: ['binary:ffmpeg'], degradable: [] } },
        probe: {
          platform: 'linux',
          arch: 'x64',
          nodeVersion: process.version,
          cpus: 1,
          totalMemoryMb: 1024,
          freeMemoryMb: 512,
          binaries: {},
          capabilities: [],
        },
        exit: ((code: number) => {
          exits.push(code);
          throw new Error(`exit ${code}`);
        }) as never,
      }),
    ).rejects.toThrow(/exit 70/);

    expect(exits).toEqual([EXIT_MISSING_CAPABILITY]);
    expect(stderr.lines.join('')).toContain('video.transcode');
  });

  it('reads headless from the environment, not only from the flag', async () => {
    writeConfig({ serverUrl: 'https://app.example.com', token: 'nod_x', nodeId: 'node-1' });
    const record = { deregisters: 0, claims: 0 };
    let fire: ((signal: NodeJS.Signals) => void) | undefined;

    const node = await startNode({
      home,
      env: {
        [WORKER_ENV.stateDir]: join(home, 'state3'),
        [WORKER_ENV.pollMs]: '250',
        [WORKER_ENV.headless]: 'true',
      },
      createApi: () => api(record),
      installSignalHandlers: (handler) => {
        fire = handler;
      },
    });

    fire?.('SIGTERM');
    await node.finished;
    expect(record.deregisters).toBe(0);
  });
});
