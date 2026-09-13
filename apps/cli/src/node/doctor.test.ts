import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ApiError, NetworkError } from '../errors.js';
import type { CapabilityProbe } from './capabilities.js';
import { formatDoctorReport, runDoctor, splitHostPort, type DoctorCheck } from './doctor.js';
import type { NodeApi, WorkerNode } from './node-api.js';
import type { ResolvedNodeConfig } from './node-config.js';

// =============================================================================
// `node doctor`  (issue #276, epic #254)
// =============================================================================
//
// The two properties worth proving: a failure in one group does not mask the
// others, and "cannot reach the server" is distinguished from "reached it and
// was refused".
// =============================================================================

let dir: string;

const CONFIG: ResolvedNodeConfig = {
  serverUrl: 'https://app.example.com',
  token: 'nod_x',
  serverUrlSource: 'file',
  tokenSource: 'file',
  nodeId: 'node-1',
  node: { name: 'worker-1', concurrency: 2, eligibleTypes: [], pollIntervalMs: 5000 },
  headless: false,
  stateDir: '/state',
  synthesised: false,
};

const PROBE: CapabilityProbe = {
  platform: 'linux',
  arch: 'x64',
  nodeVersion: 'v22.0.0',
  cpus: 4,
  totalMemoryMb: 8192,
  freeMemoryMb: 4096,
  binaries: {},
  capabilities: [],
};

function api(listNodes: () => Promise<WorkerNode[]>): NodeApi {
  return { listNodes } as unknown as NodeApi;
}

function apiError(status: number): ApiError {
  return new ApiError({
    status,
    serverMessage: `server said ${status}`,
    code: undefined,
    details: undefined,
    method: 'GET',
    url: 'https://app.example.com/api/nodes',
    structured: true,
  });
}

function find(checks: DoctorCheck[], id: string): DoctorCheck | undefined {
  return checks.find((check) => check.id === id);
}

const NO_DAEMON = async () => ({ live: false, snapshot: undefined, pid: undefined });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'appctl-doctor-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runDoctor', () => {
  it('reports all three groups even when one of them fails', async () => {
    const report = await runDoctor({
      config: CONFIG,
      socketPath: join(dir, 'node.sock'),
      pidPath: join(dir, 'node.pid'),
      stateDir: dir,
      probe: PROBE,
      api: api(async () => {
        throw new NetworkError({
          kind: 'refused',
          method: 'GET',
          url: 'https://app.example.com/api/nodes',
          message: 'connect ECONNREFUSED',
        });
      }),
      readStatus: NO_DAEMON as never,
    });

    // A server failure must NOT stop the capability or daemon checks — the
    // common real case is two things being wrong at once.
    expect(find(report.checks, 'runtime')?.status).toBe('pass');
    expect(find(report.checks, 'api-reachable')?.status).toBe('fail');
    expect(find(report.checks, 'daemon')).toBeDefined();
    expect(report.ok).toBe(false);
  });

  it('distinguishes "cannot reach" from "reached and refused"', async () => {
    const unreachable = await runDoctor({
      config: CONFIG,
      socketPath: join(dir, 'a.sock'),
      pidPath: join(dir, 'a.pid'),
      stateDir: dir,
      probe: PROBE,
      api: api(async () => {
        throw new NetworkError({
          kind: 'dns',
          method: 'GET',
          url: 'https://app.example.com/api/nodes',
          message: 'getaddrinfo ENOTFOUND',
        });
      }),
      readStatus: NO_DAEMON as never,
    });

    const refused = await runDoctor({
      config: CONFIG,
      socketPath: join(dir, 'b.sock'),
      pidPath: join(dir, 'b.pid'),
      stateDir: dir,
      probe: PROBE,
      api: api(async () => {
        throw apiError(401);
      }),
      readStatus: NO_DAEMON as never,
    });

    // Two failures, two completely different fixes.
    expect(find(unreachable.checks, 'api-reachable')?.status).toBe('fail');
    expect(find(unreachable.checks, 'api-reachable')?.action).toMatch(/DNS/);

    expect(find(refused.checks, 'api-reachable')?.status).toBe('pass');
    expect(find(refused.checks, 'api-auth')?.status).toBe('fail');
    expect(find(refused.checks, 'api-auth')?.action).toMatch(/enroll/);
  });

  it('names a missing permission for a 403 rather than blaming the credential', async () => {
    const report = await runDoctor({
      config: CONFIG,
      socketPath: join(dir, 'c.sock'),
      pidPath: join(dir, 'c.pid'),
      stateDir: dir,
      probe: PROBE,
      api: api(async () => {
        throw apiError(403);
      }),
      readStatus: NO_DAEMON as never,
    });

    expect(find(report.checks, 'api-permission')?.detail).toContain('nodes:read');
  });

  it('names an old server for a 404', async () => {
    const report = await runDoctor({
      config: CONFIG,
      socketPath: join(dir, 'd.sock'),
      pidPath: join(dir, 'd.pid'),
      stateDir: dir,
      probe: PROBE,
      api: api(async () => {
        throw apiError(404);
      }),
      readStatus: NO_DAEMON as never,
    });

    expect(find(report.checks, 'api-support')?.action).toBe('Upgrade the server.');
  });

  it('passes cleanly when everything is healthy', async () => {
    const report = await runDoctor({
      config: CONFIG,
      socketPath: join(dir, 'e.sock'),
      pidPath: join(dir, 'e.pid'),
      stateDir: dir,
      probe: PROBE,
      api: api(async () => []),
      readStatus: (async () => ({
        live: true,
        pid: 42,
        snapshot: {
          nodeId: 'node-1',
          status: 'idle',
          concurrency: 2,
          eligibleTypes: [],
          activeJobs: [],
          history: [],
          counters: { claimed: 0, succeeded: 0, failed: 0, rateLimited: 0 },
          startedAt: '2026-01-01T00:00:00.000Z',
          lastHeartbeatAt: null,
          heartbeatAgeMs: null,
        },
      })) as never,
    });

    expect(report.ok).toBe(true);
    expect(find(report.checks, 'daemon')?.status).toBe('pass');
    expect(formatDoctorReport(report)).toContain('No blocking problems found.');
  });

  it('warns rather than failing when no worker is running', async () => {
    const report = await runDoctor({
      config: CONFIG,
      socketPath: join(dir, 'f.sock'),
      pidPath: join(dir, 'f.pid'),
      stateDir: dir,
      probe: PROBE,
      api: api(async () => []),
      readStatus: NO_DAEMON as never,
    });

    // Not having started the worker yet is not a broken machine.
    expect(find(report.checks, 'daemon')?.status).toBe('warn');
    expect(report.ok).toBe(true);
  });

  it('renders every group in the table', async () => {
    const report = await runDoctor({
      config: CONFIG,
      socketPath: join(dir, 'g.sock'),
      pidPath: join(dir, 'g.pid'),
      stateDir: dir,
      probe: PROBE,
      api: api(async () => []),
      readStatus: NO_DAEMON as never,
    });

    const rendered = formatDoctorReport(report);
    expect(rendered).toContain('This machine');
    expect(rendered).toContain('The server');
    expect(rendered).toContain('The worker');
  });
});

// =============================================================================
// The database-backup dependencies (#352, epic #345)
// =============================================================================
//
// ⚠ BOTH CHECKS ARE WARNINGS, AND THAT IS THE PROPERTY UNDER TEST. Most nodes
// in a fleet will never run `db.backup.run`; failing `doctor` because a node
// has no `pg_dump`, or no route to a database it is not supposed to reach,
// would tell every one of them it is broken. A node that cannot do this work
// must simply not declare the type.

describe('the db.backup.run dependencies', () => {
  const base = () => ({
    config: CONFIG,
    socketPath: join(dir, 'b.sock'),
    pidPath: join(dir, 'b.pid'),
    stateDir: dir,
    api: api(async () => []),
    readStatus: NO_DAEMON as never,
  });

  it('warns — never fails — when `pg_dump` is missing', async () => {
    const report = await runDoctor({
      ...base(),
      probe: { ...PROBE, binaries: { pg_dump: false } },
    });

    expect(find(report.checks, 'pg-dump')?.status).toBe('warn');
    expect(report.ok).toBe(true);
  });

  it('reports the client version when it is there', async () => {
    const report = await runDoctor({
      ...base(),
      probe: { ...PROBE, binaries: { pg_dump: true }, capabilities: ['binary:pg_dump'] },
      readPgDumpVersion: async () => 'pg_dump (PostgreSQL) 17.2',
    });

    const check = find(report.checks, 'pg-dump');
    expect(check?.status).toBe('pass');
    expect(check?.detail).toContain('17.2');
  });

  it('tells a node that DECLARES the type how to fix a missing client', async () => {
    const report = await runDoctor({
      ...base(),
      config: {
        ...CONFIG,
        node: { ...CONFIG.node, eligibleTypes: ['db.backup.run'] },
      },
      probe: { ...PROBE, binaries: { pg_dump: false } },
    });

    const check = find(report.checks, 'pg-dump');
    expect(check?.detail).toContain('db.backup.run');
    expect(check?.action).toContain('postgresql-client');
    // ⚠ THIS check is still only a warning — it is the pre-existing
    // capability self-test that fails, and the distinction is the whole
    // design: "this machine has no pg_dump" is a fact about the machine,
    // "this node DECLARES a type it cannot run" is a fault. A node that
    // declares the type without the binary would claim the nightly backup and
    // permanently fail it (`maxAttempts: 1`), which is why that one is fatal.
    expect(check?.status).toBe('warn');
    expect(find(report.checks, 'job-capabilities')?.status).toBe('fail');
    expect(report.ok).toBe(false);
  });

  it('SKIPS the reachability probe when no --db-host is given — a node stores no database connection', async () => {
    const report = await runDoctor({ ...base(), probe: PROBE });

    const check = find(report.checks, 'database-reachable');
    expect(check?.status).toBe('skip');
    expect(check?.action).toContain('--db-host');
  });

  it('passes when the host answers, and only warns when it does not', async () => {
    const reachable = await runDoctor({
      ...base(),
      probe: PROBE,
      databaseHost: 'db.internal:6543',
      probeTcp: async (host, port) => {
        expect(host).toBe('db.internal');
        expect(port).toBe(6543);
        return true;
      },
    });
    expect(find(reachable.checks, 'database-reachable')?.status).toBe('pass');

    const unreachable = await runDoctor({
      ...base(),
      probe: PROBE,
      databaseHost: 'db.internal',
      probeTcp: async (_host, port) => {
        // The default port, since none was named.
        expect(port).toBe(5432);
        return 'connect ECONNREFUSED';
      },
    });

    const check = find(unreachable.checks, 'database-reachable');
    expect(check?.status).toBe('warn');
    expect(check?.detail).toContain('ECONNREFUSED');
    // There is deliberately no tunnelling: a node needs a real route, which
    // for most deployments means the same private network.
    expect(check?.action).toContain('node offload off');
    expect(unreachable.ok).toBe(true);
  });
});

describe('splitHostPort', () => {
  it('reads `host`, `host:port` and a bracketed IPv6 literal', () => {
    expect(splitHostPort('db.internal')).toEqual({ host: 'db.internal', port: 5432 });
    expect(splitHostPort('db.internal:6543')).toEqual({ host: 'db.internal', port: 6543 });
    expect(splitHostPort('[2001:db8::1]:6543')).toEqual({ host: '2001:db8::1', port: 6543 });
    expect(splitHostPort('[2001:db8::1]')).toEqual({ host: '2001:db8::1', port: 5432 });
  });

  it('does not mistake a bare IPv6 address for a host and a port', () => {
    // The bug this exists to not have: `2001:db8::1` split on the last colon
    // is a probe of host `2001:db8:` on port NaN.
    expect(splitHostPort('2001:db8::1')).toEqual({ host: '2001:db8::1', port: 5432 });
  });

  it('falls back to the default port rather than probing port NaN', () => {
    expect(splitHostPort('db.internal:not-a-port')).toEqual({
      host: 'db.internal:not-a-port',
      port: 5432,
    });
  });
});
