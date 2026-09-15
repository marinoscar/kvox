import { describe, expect, it } from 'vitest';

import type { HealthReport } from '../../../deploy/health.js';
import { describeAge, statusHints, statusModel } from './status-model.js';

// =============================================================================
// The status screen  (issue #132, epic #118)
// =============================================================================
//
// `ink-testing-library` is not a dependency (see ../status.test.ts), so the
// screen is asserted as data — and the thing worth asserting is the OMISSION
// this issue fixes: the screen it replaces never passed `state` into
// `collectHealth`, so `deployed` was always undefined and the revision and
// last-deployed lines the subcommand prints first were simply missing.
// =============================================================================

const DEPLOYED_AT = '2026-09-15T12:00:00.000Z';
const NOW = Date.parse('2026-09-15T15:00:00.000Z');
const SHA = 'abcdef0123456789abcdef0123456789abcdef01';

function report(overrides: Partial<HealthReport> = {}): HealthReport {
  return {
    containers: [
      { name: 'demo-api-1', service: 'api', state: 'running', health: 'healthy', image: 'demo-api' },
      { name: 'demo-web-1', service: 'web', state: 'running', image: 'demo-web' },
    ],
    local: {
      live: { ok: true, status: 200, durationMs: 4 },
      ready: { ok: true, status: 200, durationMs: 11 },
      frontend: { ok: true, status: 200, durationMs: 6 },
    },
    migrations: { known: true, pending: [], applied: 42 },
    deployed: {
      commitSha: SHA,
      ref: 'main',
      lastDeployedAt: DEPLOYED_AT,
      lastCommand: 'update',
    },
    ...overrides,
  };
}

function rowFor(rows: ReadonlyArray<{ key: string; value: string; note?: string | undefined }>, key: string) {
  return rows.find((row) => row.key === key);
}

describe('statusModel', () => {
  it('shows the revision and last-deployed lines the command already prints', () => {
    const model = statusModel({ report: report(), now: NOW });

    const revision = rowFor(model.deployment, 'Revision');
    expect(revision?.value).toBe('abcdef012345');
    expect(revision?.note).toBe('(main)');

    const deployedAt = rowFor(model.deployment, 'Last deployed');
    expect(deployedAt?.value).toBe('2026-09-15 12:00:00 UTC');
    expect(deployedAt?.value.endsWith(' UTC')).toBe(true);
    expect(deployedAt?.note).toBe('(3 h ago)');
  });

  it('says so loudly when no deployment state was read, rather than dropping the rows', () => {
    const model = statusModel({ report: report({ deployed: undefined }), now: NOW });

    // The exact regression this issue fixes: the block must not just be
    // shorter, it must say the state was missing.
    expect(rowFor(model.deployment, 'Revision')?.value).toContain('no deployment state');
  });

  it('shows a later attempt than the last success, because that means a failure', () => {
    const model = statusModel({
      report: report({
        deployed: {
          commitSha: SHA,
          ref: 'main',
          lastDeployedAt: DEPLOYED_AT,
          lastAttemptAt: '2026-09-15T14:00:00.000Z',
          lastCommand: 'update',
        },
      }),
      now: NOW,
    });

    expect(rowFor(model.deployment, 'Last attempt')?.note).toContain('did not complete');
  });

  it('hides the attempt row when it is the successful deploy itself', () => {
    const model = statusModel({
      report: report({
        deployed: {
          commitSha: SHA,
          ref: 'main',
          lastDeployedAt: DEPLOYED_AT,
          lastAttemptAt: DEPLOYED_AT,
          lastCommand: 'update',
        },
      }),
      now: NOW,
    });

    expect(rowFor(model.deployment, 'Last attempt')).toBeUndefined();
  });

  it('carries the Update line in its three shapes', () => {
    const never = statusModel({ report: report(), now: NOW });
    expect(rowFor(never.deployment, 'Update')?.value).toBe('never checked');

    const current = statusModel({
      report: report(),
      remote: { sha: SHA, commitsBehind: 0, checkedAt: '2026-09-15T14:55:00.000Z' },
      now: NOW,
    });
    expect(rowFor(current.deployment, 'Update')?.value).toContain('up to date');
    expect(rowFor(current.deployment, 'Update')?.note).toBe('(checked 5 min ago)');

    const behind = statusModel({
      report: report(),
      remote: { sha: SHA, commitsBehind: 1, checkedAt: '2026-09-15T14:55:00.000Z' },
      now: NOW,
    });
    expect(rowFor(behind.deployment, 'Update')?.value).toContain('1 commit behind');

    const broken = statusModel({ report: report(), remoteError: 'no network', now: NOW });
    expect(rowFor(broken.deployment, 'Update')?.value).toBe('unavailable (no network)');
  });

  it('never lets a failed remote check change the health verdict', () => {
    expect(statusModel({ report: report(), remoteError: 'no network', now: NOW }).healthy).toBe(
      true,
    );
  });

  it('lists the containers, and says so plainly when there are none', () => {
    expect(statusModel({ report: report(), now: NOW }).containers.map((row) => row.key)).toEqual([
      'api',
      'web',
    ]);
    expect(statusModel({ report: report({ containers: [] }), now: NOW }).containers).toEqual([
      { key: 'Containers', value: 'none reported' },
    ]);
  });

  it('keeps the schema beside the probes, because a green readiness is weak evidence', () => {
    const model = statusModel({ report: report(), now: NOW });

    expect(model.probes.map((row) => row.key)).toEqual([
      'Liveness',
      'Readiness',
      'Frontend',
      'Migrations',
    ]);
    expect(rowFor(model.probes, 'Migrations')?.value).toBe('up to date');
  });

  it('reports pending migrations even while every probe is green', () => {
    const model = statusModel({
      report: report({ migrations: { known: true, pending: ['20260101_add_thing'] } }),
      now: NOW,
    });

    expect(rowFor(model.probes, 'Migrations')?.value).toBe('1 pending');
    expect(rowFor(model.probes, 'Migrations')?.note).toContain('20260101_add_thing');
    // `isHealthy`'s rule: a pending migration is not healthy, whatever
    // /api/health/ready answered.
    expect(model.healthy).toBe(false);
  });

  it('adds the external probe only when a domain was given', () => {
    const published = statusModel({
      report: report({
        external: {
          url: 'https://app.example.com/api/health/ready',
          probe: { ok: false, durationMs: 9_000, error: 'timeout' },
        },
      }),
      now: NOW,
    });

    expect(rowFor(published.probes, 'External HTTPS')?.value).toBe('timeout');
    expect(published.healthy).toBe(false);
  });

  it('marks a failing probe with its reason rather than a status code it never got', () => {
    const model = statusModel({
      report: report({
        local: {
          live: { ok: true, status: 200, durationMs: 4 },
          ready: { ok: false, durationMs: 30, error: 'ECONNREFUSED' },
          frontend: { ok: true, status: 200, durationMs: 6 },
        },
      }),
      now: NOW,
    });

    expect(rowFor(model.probes, 'Readiness')?.value).toBe('ECONNREFUSED');
    expect(rowFor(model.probes, 'Readiness')?.note).toBeUndefined();
    expect(model.healthy).toBe(false);
  });
});

describe('describeAge', () => {
  it('matches the wording the command uses', () => {
    const base = Date.parse('2026-09-15T12:00:00.000Z');

    expect(describeAge('2026-09-15T12:00:00.000Z', base)).toBe('just now');
    expect(describeAge('2026-09-15T11:55:00.000Z', base)).toBe('5 min ago');
    expect(describeAge('2026-09-15T09:00:00.000Z', base)).toBe('3 h ago');
    expect(describeAge('2026-09-13T12:00:00.000Z', base)).toBe('2 d ago');
    expect(describeAge('not a date', base)).toBe('at an unknown time');
  });
});

describe('statusHints', () => {
  it('binds a bare r, because this screen has no field to type into', () => {
    expect(statusHints(false)).toEqual(['r refresh', 'esc back']);
    expect(statusHints(true)[0]).toBe('refreshing…');
  });
});
