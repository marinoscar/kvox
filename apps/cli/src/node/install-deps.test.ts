import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { detectDistro, runInstallDeps, type InstallStep } from './install-deps.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'appctl-deps-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('detectDistro (issue #276)', () => {
  it('reads /etc/os-release content', () => {
    const distro = detectDistro({
      platform: 'linux',
      osRelease: 'ID=ubuntu\nVERSION_ID="24.04"\nID_LIKE=debian\n',
    });
    expect(distro).toEqual({ id: 'ubuntu', versionId: '24.04', family: 'debian' });
  });

  it('classifies alpine and rhel families', () => {
    expect(detectDistro({ platform: 'linux', osRelease: 'ID=alpine\n' }).family).toBe('alpine');
    expect(detectDistro({ platform: 'linux', osRelease: 'ID=rocky\nID_LIKE="rhel centos fedora"\n' }).family).toBe('rhel');
  });

  it('falls back to unknown rather than guessing a package manager', () => {
    expect(detectDistro({ platform: 'linux', osRelease: 'ID=plan9\n' }).family).toBe('unknown');
  });

  it('handles the non-Linux platforms without reading a file', () => {
    expect(detectDistro({ platform: 'win32' }).family).toBe('windows');
    expect(detectDistro({ platform: 'darwin' }).family).toBe('darwin');
  });
});

describe('runInstallDeps', () => {
  function step(overrides: Partial<InstallStep> & Pick<InstallStep, 'id'>): InstallStep {
    return {
      label: overrides.id,
      supported: () => true,
      detect: () => false,
      install: () => {},
      ...overrides,
    } as InstallStep;
  }

  it('--dry-run performs no mutation and reports the plan', () => {
    const install = vi.fn();
    const stateDir = join(dir, 'state');

    const report = runInstallDeps({
      stateDir,
      dryRun: true,
      steps: [step({ id: 'thing', install })],
      distro: detectDistro({ platform: 'linux', osRelease: 'ID=ubuntu\n' }),
    });

    expect(install).not.toHaveBeenCalled();
    expect(report.results[0]).toMatchObject({ outcome: 'installed', detail: 'Would install (dry run)' });
    expect(existsSync(stateDir)).toBe(false);
  });

  it('records the four outcomes independently', () => {
    const report = runInstallDeps({
      stateDir: dir,
      steps: [
        step({ id: 'already', detect: () => true }),
        step({ id: 'fresh' }),
        step({ id: 'elsewhere', supported: () => false }),
        step({
          id: 'broken',
          install: () => {
            throw new Error('apt exploded');
          },
        }),
      ],
      distro: detectDistro({ platform: 'linux', osRelease: 'ID=ubuntu\n' }),
    });

    expect(report.results.map((result) => result.outcome)).toEqual(['skipped', 'installed', 'unsupported', 'failed']);
    // `unsupported` is not a failure; `failed` is.
    expect(report.ok).toBe(false);
  });

  it('announces sudo before running anything', () => {
    const messages: string[] = [];
    runInstallDeps({
      stateDir: dir,
      steps: [step({ id: 'privileged', requiresSudo: true, detect: () => true })],
      log: (message) => messages.push(message),
      distro: detectDistro({ platform: 'linux', osRelease: 'ID=ubuntu\n' }),
    });

    // A command that quietly escalates is a command people stop trusting.
    expect(messages.join('\n')).toContain('sudo');
    expect(messages.join('\n')).toContain('privileged');
  });

  it('turns a throwing detect into a failed step rather than an exception', () => {
    const report = runInstallDeps({
      stateDir: dir,
      steps: [
        step({
          id: 'weird',
          detect: () => {
            throw new Error('probe blew up');
          },
        }),
      ],
      distro: detectDistro({ platform: 'linux', osRelease: 'ID=ubuntu\n' }),
    });

    expect(report.results[0]).toMatchObject({ outcome: 'failed', detail: 'probe blew up' });
  });

  it('creates the state directory with the shipped default steps', () => {
    const stateDir = join(dir, 'created');
    const report = runInstallDeps({ stateDir, distro: detectDistro({ platform: 'linux', osRelease: 'ID=ubuntu\n' }) });

    expect(existsSync(stateDir)).toBe(true);
    expect(report.ok).toBe(true);
  });
});
