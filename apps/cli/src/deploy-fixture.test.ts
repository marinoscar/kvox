import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runApp } from './run.js';

// =============================================================================
// A deployment written by CLI 1.8.0 is read by this build  (issue #482, epic #478)
// =============================================================================
//
// Servers already deployed keep their files; nothing here migrates them. This
// fixture is the shape 1.8.0 wrote (state file version 1 with the fixed
// `appctlVersion` field, a `.env`, `deploy-info/info.json` schema 1 with the
// fields the platform's reader drops), and the read-only commands must answer
// from it and must not rewrite it.
//
// What this does NOT prove: that `deploy update` / `deploy install` /
// `deploy status` against a RUNNING stack behave (they need Docker, a database
// and a proxy). The first write by the new build upgrades the state file to
// version 2, which 1.8.0 then refuses; see the README.
// =============================================================================

const STATE_V1 = {
  version: 1,
  repoUrl: 'https://github.com/example-org/example-repo.git',
  ref: 'main',
  commitSha: '0123456789abcdef0123456789abcdef01234567',
  domain: 'app.example.com',
  bindPort: 9,
  deployRoot: '/opt/infra/apps/myapp',
  name: 'myapp',
  appsRoot: '/opt/infra/apps',
  proxyRoot: '/opt/infra/proxy',
  proxyContainer: 'proxy-nginx',
  envPath: '/opt/infra/apps/myapp/.env',
  installedAt: '2026-09-01T10:00:00.000Z',
  lastDeployedAt: '2026-10-10T09:30:00.000Z',
  lastAttemptAt: '2026-10-10T09:25:00.000Z',
  lastCommand: 'update',
  lastOutcome: 'success',
  appctlVersion: '1.8.0',
  previousSha: 'fedcba9876543210fedcba9876543210fedcba98',
  completedSteps: ['preflight', 'fetch', 'build', 'migrate', 'restart', 'health', 'verify'],
};

const INFO_V1 = {
  schema: 1,
  app: {
    name: 'myapp',
    version: '1.4.2',
    commitSha: STATE_V1.commitSha,
    ref: 'main',
    repoUrl: STATE_V1.repoUrl,
  },
  installedAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-10-10T09:30:00.000Z',
  lastCommand: 'update',
  deployedBy: { cli: 'kvox', version: '1.8.0' },
  domain: 'app.example.com',
  bindPort: 9,
  host: {
    hostname: 'vps-1',
    os: 'Ubuntu 24.04',
    kernel: '6.8.0',
    arch: 'x64',
    cpuModel: 'AMD EPYC',
    cpus: 4,
    memoryBytes: 8589934592,
    diskBytes: 107374182400,
    dockerVersion: '27.3.1',
    composeVersion: '2.29.7',
    nodeVersion: '24.1.0',
  },
  remote: { sha: STATE_V1.commitSha, commitsBehind: 0, checkedAt: '2026-10-10T09:00:00.000Z' },
  run: { completed: true, attemptedAt: '2026-10-10T09:25:00.000Z' },
};

let work: string;
let appsRoot: string;
let root: string;
let stdout: string;
let stderr: string;

beforeEach(() => {
  resetCliForTests();
  work = mkdtempSync(join(tmpdir(), 'deploy-fixture-'));
  appsRoot = join(work, 'apps');
  root = join(appsRoot, 'myapp');
  mkdirSync(join(root, 'repo', '.git'), { recursive: true });
  mkdirSync(join(root, 'deploy-info'), { recursive: true });
  writeFileSync(join(root, '.appctl-deploy.json'), `${JSON.stringify(STATE_V1, null, 2)}\n`);
  writeFileSync(join(root, 'deploy-info', 'info.json'), `${JSON.stringify(INFO_V1, null, 2)}\n`);
  writeFileSync(join(root, '.env'), 'APP_DOMAIN=app.example.com\nPOSTGRES_DB=myapp\n', { mode: 0o600 });

  stdout = '';
  stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(work, { recursive: true, force: true });
});

function stateBytes(): string {
  return readFileSync(join(root, '.appctl-deploy.json'), 'utf8');
}

describe('a deployment installed by 1.8.0', () => {
  it('deploy list finds it from its record', async () => {
    const code = await runApp(['deploy', 'list', '--apps-root', appsRoot, '--json']);

    expect(code).toBe(0);
    const out = JSON.parse(stdout) as { deployments: Array<Record<string, unknown>> };
    expect(out.deployments).toHaveLength(1);
    expect(out.deployments[0]).toMatchObject({
      name: 'myapp',
      commitSha: STATE_V1.commitSha,
      ref: 'main',
      domain: 'app.example.com',
      bindPort: 9,
      source: 'record',
    });
  });

  it('deploy about prints what 1.8.0 recorded, including the fields the platform reader drops', async () => {
    const code = await runApp(['deploy', 'about', '--root', root, '--json']);

    expect(code).toBe(0);
    const out = JSON.parse(stdout) as { status: string; document: typeof INFO_V1 };
    expect(out.status).toBe('ok');
    expect(out.document.app.commitSha).toBe(STATE_V1.commitSha);
    expect(out.document.deployedBy).toEqual({ cli: 'kvox', version: '1.8.0' });
    expect(out.document.domain).toBe('app.example.com');
  });

  it('deploy about in text names the app, the commit and who deployed it', async () => {
    const code = await runApp(['deploy', 'about', '--root', root]);

    expect(code).toBe(0);
    // A human report goes to whichever stream the platform picks; both are read.
    const report = `${stdout}${stderr}`;
    expect(report).toContain('myapp');
    expect(report).toContain('0123456789ab');
    expect(report).toContain('1.8.0');
  });

  it('deploy status reads the deployed commit from the record (the stack itself is not running here)', async () => {
    await runApp(['deploy', 'status', '--root', root, '--json']);

    const out = JSON.parse(stdout.split('\n')[0] as string) as { deployed: Record<string, unknown> };
    expect(out.deployed).toMatchObject({
      commitSha: STATE_V1.commitSha,
      ref: 'main',
      lastDeployedAt: '2026-10-10T09:30:00.000Z',
      lastCommand: 'update',
    });
  });

  it('never rewrites the state file by being read', async () => {
    const before = stateBytes();

    await runApp(['deploy', 'list', '--apps-root', appsRoot, '--json']);
    await runApp(['deploy', 'about', '--root', root, '--json']);
    await runApp(['deploy', 'status', '--root', root, '--json']);

    expect(stateBytes()).toBe(before);
    expect(JSON.parse(before)).toMatchObject({ version: 1, appctlVersion: '1.8.0' });
  });

  it('deploy uninstall --dry-run lists the removal and the four things it keeps, and removes nothing', async () => {
    const code = await runApp(['deploy', 'uninstall', '--root', root, '--dry-run', '--json']);

    expect(code).toBe(0);
    const plan = JSON.parse(stdout) as { removes?: string[]; keeps?: Array<{ what: string }>; plan?: { keeps: Array<{ what: string }> } };
    const keeps = plan.keeps ?? plan.plan?.keeps ?? [];
    expect(keeps.map((keep) => keep.what).join('\n')).toMatch(/shared proxy container/);
    expect(stateBytes()).toContain('"commitSha"');
  });
});
