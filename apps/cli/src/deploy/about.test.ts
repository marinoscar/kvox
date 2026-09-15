import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SERVER_URL_ENV_VAR, TOKEN_ENV_VAR, type ConfigContext } from '../config.js';
import { NetworkError } from '../errors.js';
import {
  collectAbout,
  describeRelative,
  formatBytes,
  formatInstant,
  formatUtc,
  renderAbout,
  type AboutReport,
} from './about.js';
import { writeDeployInfo, type DeployRemote } from './deploy-info.js';
import type { CommandResult, runCommand } from './executor.js';
import type { ServerFacts } from './server-facts.js';
import { DEPLOY_STATE_VERSION, deployStatePath, type DeployState } from './state.js';
import type { UpdateCheckOptions, UpdateCheckResult } from './update.js';

// =============================================================================
// `deploy about` - the report (issue #128, epic #118)
// =============================================================================
//
// Every source `collectAbout` merges is injected, so nothing here reads the
// developer's own machine, config file or network. The `configContext` in
// particular is NOT optional in these tests: without it a contributor who
// happens to be logged in would exercise a different code path from CI.
// =============================================================================

const DEPLOYED_FACTS: ServerFacts = {
  hostname: 'vps-1',
  os: 'Ubuntu 24.04.1 LTS',
  kernel: '6.8.0-45-generic',
  arch: 'x64',
  cpuModel: 'AMD EPYC 7B13',
  cpus: 2,
  memoryBytes: 4_096_000_000,
  diskBytes: 80_000_000_000,
  dockerVersion: '27.3.1',
  composeVersion: '2.29.7',
  nodeVersion: '22.11.0',
};

const DOMAIN = 'app.example.test';

/** A config with no credentials at all: the "not logged in" baseline. */
const NO_LOGIN: ConfigContext = { env: {}, home: mkdtempSync(join(tmpdir(), 'appctl-home-')) };

/** A config whose stored login is for `DOMAIN`, supplied through the env layer. */
function loggedIn(serverUrl = `https://${DOMAIN}`): ConfigContext {
  return {
    env: { [SERVER_URL_ENV_VAR]: serverUrl, [TOKEN_ENV_VAR]: 'pat_test' },
    home: mkdtempSync(join(tmpdir(), 'appctl-home-')),
  };
}

function sampleState(deployRoot: string, extra: Partial<DeployState> = {}): DeployState {
  return {
    version: DEPLOY_STATE_VERSION,
    repoUrl: 'https://example.test/o/demo',
    ref: 'main',
    commitSha: 'a'.repeat(40),
    domain: DOMAIN,
    bindPort: 3535,
    deployRoot,
    name: 'demo',
    installedAt: '2026-09-15T18:02:11.000Z',
    lastDeployedAt: '2026-09-15T18:02:11.000Z',
    lastCommand: 'install',
    appctlVersion: '1.0.0',
    ...extra,
  };
}

/** An installed deployment: the state file, and optionally the info document. */
function installed(options: { info?: boolean; state?: Partial<DeployState>; remote?: DeployRemote } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'appctl-about-'));
  const state = sampleState(root, options.state ?? {});
  writeFileSync(deployStatePath(root), JSON.stringify(state));
  if (options.info !== false) {
    writeDeployInfo(root, state, DEPLOYED_FACTS, {
      appVersion: '1.4.0',
      ...(options.remote === undefined ? {} : { remote: options.remote }),
    });
  }
  return root;
}

const NEVER_RUN = (async (): Promise<CommandResult> => {
  throw new Error('no subprocess should be spawned by this test');
}) as typeof runCommand;

function facts(overrides: Partial<ServerFacts> = {}): () => Promise<ServerFacts> {
  return async () => ({ ...DEPLOYED_FACTS, ...overrides });
}

type CollectExtras = Parameters<typeof collectAbout>[0];

async function collect(root: string, extra: Partial<CollectExtras> = {}): Promise<AboutReport> {
  return await collectAbout({
    appsRoot: mkdtempSync(join(tmpdir(), 'appctl-apps-')),
    root,
    runCommand: NEVER_RUN,
    collectFacts: facts() as CollectExtras['collectFacts'],
    configContext: NO_LOGIN,
    now: new Date('2026-09-15T21:02:11.000Z'),
    ...extra,
  });
}

describe('collectAbout: the deployment block', () => {
  it('merges the info document with the four fields only the state carries', async () => {
    const root = installed({
      state: {
        previousSha: 'b'.repeat(40),
        completedSteps: ['preflight', 'build'],
        proxyContainer: 'shared-proxy',
        envPath: '/opt/apps/demo/.env',
        lastAttemptAt: '2026-09-15T19:00:00.000Z',
      },
    });

    const report = await collect(root);

    expect(report.deploymentReason).toBeNull();
    expect(report.deployment).toMatchObject({
      name: 'demo',
      version: '1.4.0',
      commitSha: 'a'.repeat(40),
      ref: 'main',
      domain: DOMAIN,
      bindPort: 3535,
      // The info document is authoritative for the timestamps.
      installedAt: '2026-09-15T18:02:11.000Z',
      updatedAt: '2026-09-15T18:02:11.000Z',
      lastCommand: 'install',
      // ...and the state for these four, which it deliberately never carries.
      previousSha: 'b'.repeat(40),
      completedSteps: ['preflight', 'build'],
      proxyContainer: 'shared-proxy',
      envPath: '/opt/apps/demo/.env',
      lastAttemptAt: '2026-09-15T19:00:00.000Z',
    });
  });

  it('answers null with a reason when there is no info document', async () => {
    const report = await collect(installed({ info: false }));

    expect(report.deployment).toBeNull();
    expect(report.deploymentReason).toContain('deploy-info');
    // ...and the rest of the report still renders.
    expect(report.host.now.hostname).toBe('vps-1');
    expect(() => renderAbout(report)).not.toThrow();
  });

  it('refuses only when nothing is installed', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'appctl-empty-'));
    await expect(collect(empty)).rejects.toThrow(/No deployment found/);
  });

  it('carries every timestamp as the ISO UTC string the file holds', async () => {
    const report = await collect(installed());

    expect(report.deployment?.updatedAt).toBe('2026-09-15T18:02:11.000Z');
    expect(report.deployment?.updatedAt).toMatch(/Z$/);
    expect(report.generatedAt).toBe('2026-09-15T21:02:11.000Z');
  });
});

describe('collectAbout: the host block', () => {
  it('reports a live value that differs as `now`, keeping the recorded one', async () => {
    const report = await collect(installed(), {
      collectFacts: facts({ memoryBytes: 8_192_000_000 }) as CollectExtras['collectFacts'],
    });

    expect(report.host.deployed?.memoryBytes).toBe(4_096_000_000);
    expect(report.host.now).toEqual({ memoryBytes: 8_192_000_000 });
    expect(report.host.probed).toBe(true);

    const rendered = renderAbout(report);
    expect(rendered).toContain('(now 7.6 GiB)');
  });

  it('never treats an unanswerable probe as a change', async () => {
    // `df` missing, docker not on this PATH: unknown, not "the disk vanished".
    const report = await collect(installed(), {
      collectFacts: facts({ diskBytes: null, dockerVersion: null }) as CollectExtras['collectFacts'],
    });

    expect(report.host.now).toEqual({});
    expect(renderAbout(report)).not.toContain('(now');
  });

  it('holds every live value when there is no recorded set to compare against', async () => {
    const report = await collect(installed({ info: false }));

    expect(report.host.deployed).toBeNull();
    expect(report.host.now.os).toBe('Ubuntu 24.04.1 LTS');
  });
});

describe('collectAbout: the remote block', () => {
  it('reports the recorded remote without checking anything', async () => {
    const root = installed({
      remote: { sha: 'c'.repeat(40), commitsBehind: 2, checkedAt: '2026-09-15T06:00:00.000Z' },
    });

    const report = await collect(root);

    expect(report.remote?.commitsBehind).toBe(2);
    expect(report.updateAvailable).toBe(true);
    expect(report.remoteError).toBeNull();
    expect(renderAbout(report)).toContain('2 commits behind');
  });

  it('is `never checked` when nothing has ever recorded one', async () => {
    const report = await collect(installed());

    expect(report.remote).toBeNull();
    expect(report.updateAvailable).toBeNull();
    expect(renderAbout(report)).toContain('never checked');
  });

  it('--check refreshes it through the injected check and records it', async () => {
    const root = installed();
    let asked = 0;

    const report = await collect(root, {
      check: true,
      checkForUpdate: (async (options: UpdateCheckOptions): Promise<UpdateCheckResult> => {
        asked += 1;
        expect(options.deployRoot).toBe(root);
        // `status` and `about` both refuse to create a checkout to answer.
        expect(options.requireExisting).toBe(true);
        return {
          target: {} as UpdateCheckResult['target'],
          fetched: {} as UpdateCheckResult['fetched'],
          check: {
            current: 'a'.repeat(40),
            latest: 'd'.repeat(40),
            commitsBehind: 5,
            commits: [],
            checkedAt: '2026-09-15T20:00:00.000Z',
          },
        };
      }) as CollectExtras['checkForUpdate'],
    });

    expect(asked).toBe(1);
    expect(report.remote).toEqual({
      sha: 'd'.repeat(40),
      commitsBehind: 5,
      checkedAt: '2026-09-15T20:00:00.000Z',
    });
    expect(report.updateAvailable).toBe(true);

    // ...and it was written back, so the web card sees the same number.
    const again = await collect(root);
    expect(again.remote?.commitsBehind).toBe(5);
  });

  it('reports a failed check inline rather than failing', async () => {
    const report = await collect(installed(), {
      check: true,
      checkForUpdate: (async () => {
        throw new Error('could not reach the remote\nsecond line');
      }) as CollectExtras['checkForUpdate'],
    });

    expect(report.remoteError).toBe('could not reach the remote');
    expect(report.remote).toBeNull();
    expect(renderAbout(report)).toContain('unavailable (could not reach the remote)');
  });
});

describe('collectAbout: the API block', () => {
  function apiResponse(body: unknown): typeof globalThis.fetch {
    return (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof globalThis.fetch;
  }

  const ABOUT_BODY = {
    data: {
      runtime: {
        apiVersion: '1.4.0',
        nodeVersion: 'v22.11.0',
        processStartedAt: '2026-09-15T18:02:30.000Z',
        uptimeSeconds: 10_781,
        serverTimeUtc: '2026-09-15T21:02:11.000Z',
        environment: 'production',
      },
      database: {
        serverVersion: 'PostgreSQL 16.4 (Debian) on x86_64',
        appliedMigrations: 42,
        lastMigrationName: '20260901120000_add_note_exports',
        lastMigrationAt: '2026-09-14T22:41:12.000Z',
      },
      databaseError: null,
    },
  };

  it('asks the deployment its own domain resolves to, and unwraps the envelope', async () => {
    let asked: string | undefined;

    const report = await collect(installed(), {
      configContext: loggedIn(),
      fetch: (async (input: RequestInfo | URL) => {
        asked = String(input);
        return new Response(JSON.stringify(ABOUT_BODY), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof globalThis.fetch,
    });

    expect(asked).toBe(`https://${DOMAIN}/api/admin/about`);
    expect(report.apiReason).toBeNull();
    expect(report.api?.runtime.apiVersion).toBe('1.4.0');
    expect(report.api?.database?.appliedMigrations).toBe(42);
  });

  it('is null with `not logged in` when there is no token', async () => {
    const report = await collect(installed(), { fetch: apiResponse(ABOUT_BODY) });

    expect(report.api).toBeNull();
    expect(report.apiReason).toBe('not logged in');
    expect(renderAbout(report)).toContain('unavailable (not logged in)');
  });

  it('refuses to report a DIFFERENT deployment\'s API as this one\'s', async () => {
    const report = await collect(installed(), {
      configContext: loggedIn('https://other.example.test'),
      fetch: apiResponse(ABOUT_BODY),
    });

    expect(report.api).toBeNull();
    expect(report.apiReason).toContain('other.example.test');
    expect(report.apiReason).toContain('--server');
  });

  it('--server overrides the domain check', async () => {
    let asked: string | undefined;

    const report = await collect(installed(), {
      configContext: loggedIn('https://other.example.test'),
      serverUrl: 'http://127.0.0.1:3535',
      fetch: (async (input: RequestInfo | URL) => {
        asked = String(input);
        return new Response(JSON.stringify(ABOUT_BODY), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof globalThis.fetch,
    });

    expect(asked).toBe('http://127.0.0.1:3535/api/admin/about');
    expect(report.api?.serverUrl).toBe('http://127.0.0.1:3535');
  });

  it('reports an unreachable API inline, and the rest of the report survives', async () => {
    const report = await collect(installed(), {
      configContext: loggedIn(),
      fetch: (async () => {
        throw new NetworkError({
          kind: 'refused',
          method: 'GET',
          url: `https://${DOMAIN}/api/admin/about`,
          message: 'connection refused',
        });
      }) as typeof globalThis.fetch,
    });

    expect(report.api).toBeNull();
    expect(report.apiReason).toContain('Could not reach');
    // The point of the whole design: About works with the API container down.
    expect(report.deployment?.commitSha).toBe('a'.repeat(40));
    expect(renderAbout(report)).toContain('Deployment');
  });

  it('does not attempt a call for a deployment with no domain', async () => {
    const root = installed({ state: { domain: undefined } });
    // The info document takes `domain` from the state, so it is null there too.
    const report = await collect(root, {
      configContext: loggedIn(),
      fetch: (async () => {
        throw new Error('no call should have been made');
      }) as typeof globalThis.fetch,
    });

    expect(report.api).toBeNull();
    expect(report.apiReason).toContain('no domain');
  });
});

describe('rendering', () => {
  it('formats every timestamp as UTC with how long ago it was', async () => {
    const report = await collect(installed());
    const rendered = renderAbout(report);

    expect(rendered).toContain('2026-09-15 18:02:11 UTC (3 hours ago)');
    // Three blocks, mirroring the web card.
    expect(rendered).toContain('Application');
    expect(rendered).toContain('Deployment');
    expect(rendered).toContain('Server');
  });

  it('measures relative times against `generatedAt` unless told otherwise', () => {
    expect(formatUtc('2026-09-15T18:02:11.000Z')).toBe('2026-09-15 18:02:11 UTC');
    expect(formatUtc('not a date')).toBe('not a date');
    expect(formatInstant('2026-09-15T18:02:11.000Z', Date.parse('2026-09-15T21:02:11.000Z'))).toBe(
      '2026-09-15 18:02:11 UTC (3 hours ago)',
    );
  });

  it('describes an age in whole units, singular where it should be', () => {
    const now = Date.parse('2026-09-15T21:00:00.000Z');
    const ago = (iso: string): string => describeRelative(iso, now);

    expect(ago('2026-09-15T20:59:30.000Z')).toBe('just now');
    expect(ago('2026-09-15T20:59:00.000Z')).toBe('1 minute ago');
    expect(ago('2026-09-15T20:00:00.000Z')).toBe('1 hour ago');
    expect(ago('2026-09-15T18:00:00.000Z')).toBe('3 hours ago');
    expect(ago('2026-09-09T21:00:00.000Z')).toBe('6 days ago');
    expect(ago('2026-09-15T21:05:00.000Z')).toBe('in 5 minutes');
    expect(ago('nonsense')).toBe('at an unknown time');
  });

  it('renders bytes the way an operator reads them, and unknown as unknown', () => {
    expect(formatBytes(4_096_000_000)).toBe('3.8 GiB');
    expect(formatBytes(null)).toBe('unknown');
    expect(formatBytes(0)).toBe('unknown');
  });
});
