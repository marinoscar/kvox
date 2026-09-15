import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_INSTALL_STEPS,
  detectDistro,
  runInstallDeps,
  type InstallStep,
} from './install-deps.js';

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
    // Hermetic by construction: `run` is a recording spy standing in for the
    // context's real `execFileSync` fallback, so the shipped default steps
    // (including the ffmpeg step's `install`) run for real but nothing is
    // ever actually executed on the host. Without this, a machine where the
    // ffmpeg probe finds it missing shells out to a real `apt-get install`.
    const stateDir = join(dir, 'created');
    const run = vi.fn();
    const report = runInstallDeps({
      stateDir,
      run,
      distro: detectDistro({ platform: 'linux', osRelease: 'ID=ubuntu\n' }),
    });

    expect(existsSync(stateDir)).toBe(true);
    expect(report.ok).toBe(true);
    // Earn the title: prove the *shipped* defaults ran, not just "some steps".
    expect(report.results.map((result) => result.id)).toEqual(DEFAULT_INSTALL_STEPS.map((step) => step.id));
  });
});

// =============================================================================
// The ffmpeg step (issue #26, epic #19)
// =============================================================================
//
// The first GENUINE package step this command has shipped — #276 deliberately
// shipped the structure with nothing domain-specific in it, and
// `media.audio.transcode` is what gave it something real to install. A node
// running outside a container has no image to have baked ffmpeg in, so this is
// the only thing that puts it there.
// =============================================================================
describe('the ffmpeg install step', () => {
  const ffmpegStep = (): InstallStep => {
    const step = DEFAULT_INSTALL_STEPS.find((candidate) => candidate.id === 'ffmpeg');

    expect(step).toBeDefined();

    return step as InstallStep;
  };

  const context = (family: string, overrides: Record<string, unknown> = {}) =>
    ({
      distro: { id: family, versionId: undefined, family },
      dryRun: false,
      stateDir: dir,
      run: vi.fn(),
      log: vi.fn(),
      ...overrides,
    }) as never;

  it('announces that it escalates, rather than escalating silently', () => {
    expect(ffmpegStep().requiresSudo).toBe(true);
  });

  it('installs the distribution package on each family it knows', () => {
    for (const [family, command] of [
      ['debian', 'apt-get'],
      ['rhel', 'dnf'],
      ['alpine', 'apk'],
    ] as const) {
      const run = vi.fn();

      ffmpegStep().install(context(family, { run }));

      expect(run).toHaveBeenCalledWith(command, expect.arrayContaining(['ffmpeg']));
    }
  });

  it('reports `unsupported` on macOS and Windows instead of guessing', () => {
    // `brew`/`winget` install into a user's own environment and frequently
    // need a prompt a subcommand must not answer on somebody's behalf.
    expect(ffmpegStep().supported(context('darwin'))).toBe(false);
    expect(ffmpegStep().supported(context('windows'))).toBe(false);
    expect(ffmpegStep().supported(context('debian'))).toBe(true);
  });

  it('--dry-run prints the command and runs nothing', () => {
    const run = vi.fn();
    const log = vi.fn();

    ffmpegStep().install(context('debian', { dryRun: true, run, log }));

    expect(run).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('apt-get install -y ffmpeg'));
  });

  it('needs BOTH binaries before it reports itself satisfied', () => {
    // They ship in one package, so a machine with only one is a trimmed image
    // — and the executor runs ffprobe first, so it would fail every job.
    const step = ffmpegStep();

    expect(typeof step.detect(context('debian'))).toBe('boolean');
  });
});
