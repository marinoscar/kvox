import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CONFIG_DIR_NAME, CONFIG_FILE_NAME } from '../branding.js';
import { ApiError } from '../errors.js';
import type { DeviceLoginResult } from '../device-login.js';
import {
  NodeCredentialsUnsupportedError,
  enrollNode,
  readMachineInfo,
  registerNode,
} from './enrollment.js';
import type { NodeApi, NodeCredentialApi, WorkerNode } from './node-api.js';
import type { NodeConfig } from './node-config.js';

// =============================================================================
// register / enroll  (issue #273, epic #254)
// =============================================================================
//
// No network, no browser, no `process.env` mutation and no real home
// directory: the login function, the API and the config context are all
// injected. That is the criterion, and it is also what makes these tests
// order-independent — a suite that exports a variable to set up a case leaks
// it into every file that runs afterwards.
// =============================================================================

let home: string;

const NODE: NodeConfig = {
  name: 'worker-1',
  concurrency: 4,
  eligibleTypes: [],
  pollIntervalMs: 5000,
};

function workerNode(overrides: Partial<WorkerNode> = {}): WorkerNode {
  return {
    id: 'node-abc',
    name: 'worker-1',
    hostname: 'box',
    platform: 'linux 6.0',
    cliVersion: '1.0.0',
    eligibleTypes: [],
    concurrency: 4,
    status: 'online',
    capabilities: {},
    registeredAt: '2026-01-01T00:00:00.000Z',
    lastHeartbeatAt: null,
    ...overrides,
  };
}

/** A `NodeApi` with only the methods a test needs; the rest throw loudly. */
function fakeApi(overrides: Partial<NodeApi>): NodeApi {
  const unimplemented = (name: string) => () => {
    throw new Error(`${name} was not expected in this test`);
  };
  return {
    register: unimplemented('register'),
    jobTypes: unimplemented('jobTypes'),
    listNodes: unimplemented('listNodes'),
    getNode: unimplemented('getNode'),
    deregister: unimplemented('deregister'),
    heartbeat: unimplemented('heartbeat'),
    claim: unimplemented('claim'),
    renewLease: unimplemented('renewLease'),
    downloadUrl: unimplemented('downloadUrl'),
    uploadUrl: unimplemented('uploadUrl'),
    jobSecret: unimplemented('jobSecret'),
    submitResult: unimplemented('submitResult'),
    reportJobFailure: unimplemented('reportJobFailure'),
    ...overrides,
  } as NodeApi;
}

function readStored(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, CONFIG_DIR_NAME, CONFIG_FILE_NAME), 'utf8')) as Record<string, unknown>;
}

function writeStored(body: unknown): void {
  const dir = join(home, CONFIG_DIR_NAME);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, CONFIG_FILE_NAME), JSON.stringify(body), { mode: 0o600 });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'appctl-enroll-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('readMachineInfo', () => {
  it('reports a hostname, a platform and this CLI’s version', () => {
    const info = readMachineInfo();
    expect(info.hostname.length).toBeGreaterThan(0);
    expect(info.platform.length).toBeGreaterThan(0);
    expect(info.cliVersion.length).toBeGreaterThan(0);
  });
});

describe('registerNode', () => {
  it('registers and persists the node id, preserving the token already stored', () => {
    writeStored({ serverUrl: 'https://app.example.com', token: 'nod_stored' });

    return registerNode({
      api: fakeApi({ register: async () => ({ node: workerNode(), reattached: false }) }),
      node: NODE,
      configContext: { home, env: {} },
    }).then((result) => {
      expect(result.reattached).toBe(false);
      const stored = readStored();
      expect(stored.nodeId).toBe('node-abc');
      expect(stored.token).toBe('nod_stored');
      expect(stored.node).toMatchObject({ name: 'worker-1', concurrency: 4 });
    });
  });

  it('reports a reattach as a reattach rather than flattening it into "ok"', async () => {
    writeStored({ serverUrl: 'https://app.example.com', token: 'nod_stored' });

    const result = await registerNode({
      api: fakeApi({ register: async () => ({ node: workerNode(), reattached: true }) }),
      node: NODE,
      configContext: { home, env: {} },
    });

    expect(result.reattached).toBe(true);
  });

  it('creates no second row on a repeated register (the server keys on name)', async () => {
    writeStored({ serverUrl: 'https://app.example.com', token: 'nod_stored' });
    const rows = new Map<string, WorkerNode>();
    const api = fakeApi({
      register: async (body) => {
        const existing = rows.get(body.name);
        if (existing !== undefined) return { node: existing, reattached: true };
        const created = workerNode({ id: `node-${rows.size + 1}`, name: body.name });
        rows.set(body.name, created);
        return { node: created, reattached: false };
      },
    });

    const first = await registerNode({ api, node: NODE, configContext: { home, env: {} } });
    const second = await registerNode({ api, node: NODE, configContext: { home, env: {} } });

    expect(first.node.id).toBe(second.node.id);
    expect(second.reattached).toBe(true);
    expect(rows.size).toBe(1);
  });

  it('validates --types against the server’s advertised set and names the valid list', async () => {
    const api = fakeApi({
      jobTypes: async () => [
        { type: 'example.checksum', label: 'Checksum', resultSchema: null },
      ],
      register: async () => {
        throw new Error('register must not be reached with an invalid type');
      },
    });

    await expect(
      registerNode({
        api,
        node: { ...NODE, eligibleTypes: ['example.checksum', 'video.transcode'] },
        configContext: { home, env: {} },
      }),
    ).rejects.toThrow(/video\.transcode[\s\S]*example\.checksum/);
  });

  it('skips the type round trip when told to — `node start` must not need it', async () => {
    writeStored({ serverUrl: 'https://app.example.com', token: 'nod_stored' });
    const jobTypes = vi.fn();

    await registerNode({
      api: fakeApi({ jobTypes, register: async () => ({ node: workerNode(), reattached: true }) }),
      node: { ...NODE, eligibleTypes: ['anything'] },
      validateTypes: false,
      configContext: { home, env: {} },
    });

    expect(jobTypes).not.toHaveBeenCalled();
  });
});

describe('enrollNode', () => {
  const session = {
    grant: {},
    apiBaseUrl: 'https://app.example.com/api',
    credential: { accessToken: 'pat_session', tokenType: 'Bearer', expiresIn: 900 },
  } as unknown as DeviceLoginResult;

  function credentialApi(overrides: Partial<NodeCredentialApi> = {}): NodeCredentialApi {
    return {
      createCredential: async () => ({
        token: 'nod_secret',
        id: 'cred-1',
        name: 'appctl node: tester@box',
        tokenPrefix: 'nod_abcd',
        expiresAt: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
      ...overrides,
    };
  }

  it('logs in, mints a nod_ credential and stores it', async () => {
    const result = await enrollNode({
      serverUrl: 'https://app.example.com',
      login: async () => session,
      createCredentialApi: () => credentialApi(),
      configContext: { home, env: {} },
    });

    expect(result.token).toBe('nod_secret');
    const stored = readStored();
    expect(stored.token).toBe('nod_secret');
    expect(stored.serverUrl).toBe('https://app.example.com');
    expect(stored.tokenId).toBe('cred-1');
  });

  it('mints the credential with the SESSION token, not with whatever was stored', async () => {
    writeStored({ serverUrl: 'https://app.example.com', token: 'nod_old' });
    const seen: string[] = [];

    await enrollNode({
      serverUrl: 'https://app.example.com',
      login: async () => session,
      createCredentialApi: (_url, token) => {
        seen.push(token);
        return credentialApi();
      },
      configContext: { home, env: {} },
    });

    expect(seen).toEqual(['pat_session']);
  });

  it('clears a stored expiry, so a never-expiring credential is not reported as expired', async () => {
    writeStored({
      serverUrl: 'https://app.example.com',
      token: 'pat_old',
      expiresAt: '2020-01-01T00:00:00.000Z',
      tokenId: 'pat-1',
      tokenName: 'old pat',
    });

    await enrollNode({
      serverUrl: 'https://app.example.com',
      login: async () => session,
      createCredentialApi: () => credentialApi(),
      configContext: { home, env: {} },
    });

    const stored = readStored();
    expect(stored.expiresAt).toBeUndefined();
    expect(stored.token).toBe('nod_secret');
  });

  it('keeps a real expiry when the operator asked for one', async () => {
    await enrollNode({
      serverUrl: 'https://app.example.com',
      expiresInDays: 30,
      login: async () => session,
      createCredentialApi: () =>
        credentialApi({
          createCredential: async (body) => {
            expect(body.expiresInDays).toBe(30);
            return {
              token: 'nod_secret',
              id: 'cred-1',
              name: body.name,
              tokenPrefix: 'nod_abcd',
              expiresAt: '2026-02-01T00:00:00.000Z',
              createdAt: '2026-01-01T00:00:00.000Z',
            };
          },
        }),
      configContext: { home, env: {} },
    });

    expect(readStored().expiresAt).toBe('2026-02-01T00:00:00.000Z');
  });

  it('preserves an existing nodeId, so enrolling twice does not leak a second node', async () => {
    writeStored({
      serverUrl: 'https://app.example.com',
      token: 'nod_old',
      nodeId: 'node-abc',
      node: { name: 'worker-1', concurrency: 4 },
    });

    await enrollNode({
      serverUrl: 'https://app.example.com',
      login: async () => session,
      createCredentialApi: () => credentialApi(),
      configContext: { home, env: {} },
    });

    const stored = readStored();
    expect(stored.nodeId).toBe('node-abc');
    expect(stored.node).toMatchObject({ name: 'worker-1' });
  });

  it('turns a 404 into a typed error naming the PAT fallback, not a stack trace', async () => {
    const failing = credentialApi({
      createCredential: async () => {
        throw new ApiError({
          status: 404,
          serverMessage: 'Cannot POST /api/node-credentials',
          code: undefined,
          details: undefined,
          method: 'POST',
          url: 'https://app.example.com/api/node-credentials',
          structured: false,
        });
      },
    });

    const promise = enrollNode({
      serverUrl: 'https://app.example.com',
      login: async () => session,
      createCredentialApi: () => failing,
      configContext: { home, env: {} },
    });

    await expect(promise).rejects.toBeInstanceOf(NodeCredentialsUnsupportedError);
    await expect(promise).rejects.toThrow(/personal access token/i);
  });

  it('lets any other API failure through unchanged — a 403 is not a missing route', async () => {
    const failing = credentialApi({
      createCredential: async () => {
        throw new ApiError({
          status: 403,
          serverMessage: 'Missing permission: nodes:write',
          code: undefined,
          details: undefined,
          method: 'POST',
          url: 'https://app.example.com/api/node-credentials',
          structured: true,
        });
      },
    });

    await expect(
      enrollNode({
        serverUrl: 'https://app.example.com',
        login: async () => session,
        createCredentialApi: () => failing,
        configContext: { home, env: {} },
      }),
    ).rejects.toThrow(/nodes:write/);
  });
});
