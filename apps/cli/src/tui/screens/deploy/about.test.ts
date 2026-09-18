import { describe, expect, it } from 'vitest';

import type { AboutReport } from '../../../deploy/about.js';
import type { ServerFacts } from '../../../deploy/server-facts.js';
import { aboutHints, aboutModel, instantRow } from './about-model.js';

// =============================================================================
// The about screen  (issue #132, epic #118)
// =============================================================================
//
// `ink-testing-library` is not a dependency (see ../status.test.ts), so this
// asserts the data. The two properties the issue names are exactly what a
// pure model can pin: EVERY timestamp value ends in ` UTC` (the relative age
// is a separate dim note, which is what `KeyValueRow` has one for), and the
// API block carries the REASON it is unavailable rather than collapsing "not
// logged in" and "unreachable" into one word.
//
// Hostnames here are `.example.com` placeholders, never a real domain.
// =============================================================================

const GENERATED = '2026-09-15T21:00:00.000Z';
const NOW = Date.parse(GENERATED);
const SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const PREVIOUS = '9876543210fedcba9876543210fedcba98765432';

function facts(overrides: Partial<ServerFacts> = {}): ServerFacts {
  return {
    hostname: 'vps.example.com',
    os: 'Ubuntu 24.04.1 LTS',
    kernel: '6.8.0-45-generic',
    arch: 'x64',
    cpuModel: 'A CPU',
    cpus: 4,
    memoryBytes: 8 * 1024 * 1024 * 1024,
    diskBytes: 160 * 1024 * 1024 * 1024,
    dockerVersion: '27.3.1',
    composeVersion: '2.29.7',
    nodeVersion: '22.11.0',
    ...overrides,
  } as ServerFacts;
}

function report(overrides: Partial<AboutReport> = {}): AboutReport {
  return {
    generatedAt: GENERATED,
    deployRoot: '/opt/infra/apps/demo',
    name: 'demo',
    deployment: {
      name: 'demo',
      version: '1.4.0',
      commitSha: SHA,
      ref: 'main',
      repoUrl: 'https://github.example.com/acme/demo.git',
      domain: 'app.example.com',
      bindPort: 3535,
      installedAt: '2026-09-01T09:00:00.000Z',
      updatedAt: '2026-09-15T18:00:00.000Z',
      lastCommand: 'update',
      deployedBy: { cli: 'cli', version: '1.0.0' },
      deployRoot: '/opt/infra/apps/demo',
      adoptedAt: null,
      lastAttemptAt: null,
      envPath: '/opt/infra/apps/demo/.env',
      proxyContainer: 'proxy',
      previousSha: PREVIOUS,
      completedSteps: null,
    },
    deploymentReason: null,
    host: { deployed: facts(), now: {}, probed: true },
    remote: { sha: SHA, commitsBehind: 0, checkedAt: '2026-09-15T20:30:00.000Z' },
    remoteError: null,
    updateAvailable: false,
    api: {
      serverUrl: 'https://app.example.com',
      runtime: {
        apiVersion: '1.4.0',
        nodeVersion: '22.11.0',
        processStartedAt: '2026-09-15T18:02:11.000Z',
        uptimeSeconds: 10_669,
        serverTimeUtc: '2026-09-15T21:00:00.000Z',
        environment: 'production',
      },
      database: {
        serverVersion: 'PostgreSQL 16.4 on x86_64',
        appliedMigrations: 42,
        lastMigrationName: '20260901_add_thing',
        lastMigrationAt: '2026-09-01T09:00:00.000Z',
      },
      databaseError: null,
    },
    apiReason: null,
    ...overrides,
  };
}

function allRows(model: ReturnType<typeof aboutModel>) {
  return [...model.application, ...model.deployment, ...model.server];
}

const TIMESTAMP_KEYS = new Set([
  'Installed',
  'Last updated',
  'Last attempt',
  'Checked',
  'Process started',
  'Server time',
]);

describe('aboutModel', () => {
  it('ends every timestamp value in " UTC", with the age beside it', () => {
    const model = aboutModel(report(), { now: NOW });
    const stamps = allRows(model).filter((row) => TIMESTAMP_KEYS.has(row.key));

    expect(stamps.length).toBeGreaterThan(0);
    for (const row of stamps) {
      expect(row.value.endsWith(' UTC'), row.key).toBe(true);
    }
  });

  it('shows Installed, Last updated and Checked with a relative age', () => {
    const model = aboutModel(report(), { now: NOW });
    const byKey = new Map(model.deployment.map((row) => [row.key, row]));

    expect(byKey.get('Installed')?.value).toBe('2026-09-01 09:00:00 UTC');
    expect(byKey.get('Installed')?.note).toBe('(14 days ago)');
    expect(byKey.get('Last updated')?.value).toBe('2026-09-15 18:00:00 UTC');
    expect(byKey.get('Last updated')?.note).toBe('(3 hours ago)');
    expect(byKey.get('Checked')?.note).toBe('(30 minutes ago)');
  });

  it('measures the ages against the report itself when no clock is given', () => {
    const byKey = new Map(aboutModel(report()).deployment.map((row) => [row.key, row]));

    // `generatedAt` is the report's own clock; using Date.now() here would
    // make every age drift as the screen sat open.
    expect(byKey.get('Last updated')?.note).toBe('(3 hours ago)');
  });

  it('names the reason the API block is missing, rather than one word for both', () => {
    const out = aboutModel(report({ api: null, apiReason: 'not logged in' }), { now: NOW });
    const unreachable = aboutModel(
      report({ api: null, apiReason: 'fetch failed: ECONNREFUSED' }),
      { now: NOW },
    );

    expect(out.apiUnavailable).toBe(true);
    expect(out.application.find((row) => row.key === 'API')?.value).toBe(
      'unavailable (not logged in)',
    );
    expect(unreachable.application.find((row) => row.key === 'API')?.value).toContain(
      'ECONNREFUSED',
    );
  });

  it('still reports the deployment and the server with the API down', () => {
    const model = aboutModel(report({ api: null, apiReason: 'not logged in' }), { now: NOW });

    expect(model.deployment.find((row) => row.key === 'Revision')?.value).toBe('abcdef012345');
    expect(model.server.find((row) => row.key === 'Hostname')?.value).toBe('vps.example.com');
  });

  it('reports a database the API could not reach as a row, not an absence', () => {
    const model = aboutModel(
      report({
        api: {
          ...(report().api as NonNullable<AboutReport['api']>),
          database: null,
          databaseError: 'connection refused',
        },
      }),
      { now: NOW },
    );

    expect(model.application.find((row) => row.key === 'Database')?.value).toBe(
      'unavailable (connection refused)',
    );
  });

  it('carries the Update line in its three shapes', () => {
    const current = aboutModel(report(), { now: NOW });
    expect(current.deployment.find((row) => row.key === 'Update')?.value).toContain('up to date');

    const behind = aboutModel(
      report({
        remote: { sha: SHA, commitsBehind: 2, checkedAt: '2026-09-15T20:30:00.000Z' },
        updateAvailable: true,
      }),
      { now: NOW },
    );
    expect(behind.deployment.find((row) => row.key === 'Update')?.value).toBe('2 commits behind');
    expect(behind.updateAvailable).toBe(true);

    const broken = aboutModel(
      report({ remote: null, remoteError: 'could not reach the remote', updateAvailable: null }),
      { now: NOW },
    );
    expect(broken.deployment.find((row) => row.key === 'Update')?.value).toContain('unavailable');
  });

  it('says "never checked" rather than "up to date" when nothing ever asked', () => {
    const model = aboutModel(report({ remote: null, updateAvailable: null }), { now: NOW });

    expect(model.deployment.find((row) => row.key === 'Update')?.value).toBe('never checked');
    expect(model.updateAvailable).toBeNull();
    expect(model.deployment.some((row) => row.key === 'Checked')).toBe(false);
  });

  it('renders without a deployment record, naming why', () => {
    const model = aboutModel(
      report({ deployment: null, deploymentReason: 'no deploy-info/info.json' }),
      { now: NOW },
    );

    expect(model.deployment[0]?.value).toContain('no deploy-info/info.json');
    expect(model.deployment.find((row) => row.key === 'Root')?.value).toBe(
      '/opt/infra/apps/demo',
    );
  });

  it('shows a live host fact that moved beside the recorded one', () => {
    const model = aboutModel(
      report({
        host: { deployed: facts(), now: { dockerVersion: '27.4.0' }, probed: true },
      }),
      { now: NOW },
    );
    const docker = model.server.find((row) => row.key === 'Docker');

    expect(docker?.value).toBe('27.3.1');
    expect(docker?.note).toBe('(now 27.4.0)');
  });

  it('formats byte facts in binary units', () => {
    const model = aboutModel(report(), { now: NOW });

    expect(model.server.find((row) => row.key === 'Memory')?.value).toBe('8.0 GiB');
  });

  it('says "unavailable" when the host could not be read at all', () => {
    const model = aboutModel(
      report({ host: { deployed: null, now: {}, probed: false } }),
      { now: NOW },
    );

    expect(model.server).toEqual([{ key: 'Facts', value: 'unavailable' }]);
  });

  it('shows a later attempt than the last update, because that means a failure', () => {
    const model = aboutModel(
      report({
        deployment: {
          ...(report().deployment as NonNullable<AboutReport['deployment']>),
          lastAttemptAt: '2026-09-15T19:00:00.000Z',
        },
      }),
      { now: NOW },
    );
    const attempt = model.deployment.find((row) => row.key === 'Last attempt');

    expect(attempt?.value.endsWith(' UTC')).toBe(true);
    expect(attempt?.note).toContain('did not complete');
  });
});

describe('instantRow', () => {
  it('puts the UTC stamp in the value and the age in the note', () => {
    const row = instantRow('Checked', '2026-09-15T18:02:11.000Z', NOW);

    expect(row.value).toBe('2026-09-15 18:02:11 UTC');
    expect(row.note).toBe('(2 hours ago)');
  });
});

describe('aboutHints', () => {
  it('keeps refresh and the network check on separate keys', () => {
    const hints = aboutHints(false, false);

    expect(hints).toContain('r refresh');
    expect(hints).toContain('c check for an update');
  });

  it('says which of the two is in flight', () => {
    expect(aboutHints(true, false)[0]).toBe('reading…');
    expect(aboutHints(true, true)[0]).toBe('checking for an update…');
  });
});
