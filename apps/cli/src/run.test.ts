import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { createCli } from '@marinoscar/platform-cli';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runApp } from './run.js';

// =============================================================================
// One invocation  (issue #482, epic #478)
// =============================================================================
//
// What `runApp` adds around the platform CLI: it translates the legacy `deploy`
// flags, answers `update --check` itself, runs the uninstall backup before the
// platform's command, and otherwise hands the (translated) arguments to
// `createCli(...).run`. The platform CLI is replaced by a recorder, so these
// tests see exactly what it is handed.
// =============================================================================

let work: string;
let appsRoot: string;
let out: string;
let err: string;
let handed: string[][];

const io = (): { stdout: { write(t: string): void }; stderr: { write(t: string): void } } => ({
  stdout: { write: (t) => void (out += t) },
  stderr: { write: (t) => void (err += t) },
});

function fakeCreateCli(exitCode = 0): typeof createCli {
  return (() => ({
    program: {} as never,
    run: vi.fn(async (argv: string[]) => {
      handed.push(argv);
      return exitCode;
    }),
  })) as unknown as typeof createCli;
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'run-app-'));
  appsRoot = join(work, 'apps');
  mkdirSync(join(appsRoot, 'myapp', 'repo', '.git'), { recursive: true });
  writeFileSync(join(appsRoot, 'myapp', '.env'), 'K=v\n');
  writeFileSync(
    join(appsRoot, 'myapp', '.appctl-deploy.json'),
    JSON.stringify({ version: 1, commitSha: 'a'.repeat(40), ref: 'main' }),
  );
  out = '';
  err = '';
  handed = [];
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('runApp', () => {
  it('hands ordinary arguments to the platform CLI unchanged and returns its exit code', async () => {
    const code = await runApp(['api', 'GET', '/api/auth/me'], { ...io(), cwd: work, createCli: fakeCreateCli(3) });

    expect(code).toBe(3);
    expect(handed).toEqual([['api', 'GET', '/api/auth/me']]);
    expect(err).toBe('');
  });

  it('hands over the TRANSLATED arguments and prints the notes first', async () => {
    const code = await runApp(['deploy', 'install', '--skip-github', '--no-install-cron'], {
      ...io(),
      cwd: work,
      createCli: fakeCreateCli(),
    });

    expect(code).toBe(0);
    expect(handed).toEqual([['deploy', 'install', '--skip-renewal']]);
    expect(err).toContain('--skip-github is ignored');
    expect(err).toContain('--no-install-cron is now --skip-renewal');
  });

  it('exits 2 with the reason for a flag it cannot honour, and never builds the CLI', async () => {
    const create = vi.fn(fakeCreateCli());

    const code = await runApp(['deploy', 'install', '--fresh'], { ...io(), cwd: work, createCli: create as never });

    expect(code).toBe(2);
    expect(err).toContain('--fresh no longer exists');
    expect(create).not.toHaveBeenCalled();
  });

  it('answers update --check itself: JSON is the check object, exit 0, nothing handed to the platform', async () => {
    const runGit = vi.fn(async (_cwd: string, args: readonly string[]) => {
      if (args[0] === 'rev-parse') return `${'a'.repeat(40)}\n`;
      return '';
    });

    const code = await runApp(['deploy', 'update', '--apps-root', appsRoot, '--skip-github', '--check', '--json'], {
      ...io(),
      cwd: work,
      runGit,
      now: () => new Date('2026-10-16T12:00:00.000Z'),
      createCli: fakeCreateCli(),
    });

    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({
      current: 'a'.repeat(40),
      latest: 'a'.repeat(40),
      commitsBehind: 0,
      commits: [],
      checkedAt: '2026-10-16T12:00:00.000Z',
    });
    expect(handed).toEqual([]);
  });

  it('prints the human headline for update --check without --json', async () => {
    const runGit = async (_cwd: string, args: readonly string[]): Promise<string> =>
      args[0] === 'rev-parse' ? `${'a'.repeat(40)}\n` : '';

    await runApp(['deploy', 'update', '--apps-root', appsRoot, '--check'], { ...io(), cwd: work, runGit });

    expect(out).toBe(`already up to date at ${'a'.repeat(12)}\n`);
  });

  it('reports an update --check failure on stderr with exit 1, and an ambiguous deployment with exit 2', async () => {
    const failing = async (): Promise<string> => {
      throw new Error('git fetch failed: unreachable');
    };
    expect(await runApp(['deploy', 'update', '--apps-root', appsRoot, '--check'], { ...io(), cwd: work, runGit: failing })).toBe(1);
    expect(err).toContain('unreachable');

    err = '';
    mkdirSync(join(appsRoot, 'second', 'repo', '.git'), { recursive: true });
    writeFileSync(join(appsRoot, 'second', '.env'), 'K=v\n');
    expect(await runApp(['deploy', 'update', '--apps-root', appsRoot, '--check'], { ...io(), cwd: work })).toBe(2);
    expect(err).toContain('Pass --name');
  });

  it('copies the .env before the platform uninstall runs, and still hands it the arguments', async () => {
    const code = await runApp(['deploy', 'uninstall', '--apps-root', appsRoot, '--confirm', 'myapp'], {
      ...io(),
      cwd: work,
      now: () => new Date('2026-10-16T12:00:00.000Z'),
      createCli: fakeCreateCli(),
    });

    expect(code).toBe(0);
    expect(handed).toEqual([['deploy', 'uninstall', '--apps-root', appsRoot]]);
    expect(readdirSync(appsRoot)).toContain('myapp.env.2026-10-16T12-00-00-000Z.bak');
    expect(err).toContain('copied');
  });

  it('does not run the platform uninstall when the name is not typed', async () => {
    const code = await runApp(['deploy', 'uninstall', '--apps-root', appsRoot], {
      ...io(),
      cwd: work,
      createCli: fakeCreateCli(),
    });

    expect(code).toBe(2);
    expect(handed).toEqual([]);
    expect(readdirSync(appsRoot).filter((entry) => entry.endsWith('.bak'))).toEqual([]);
  });

  it('reports a CLI that cannot be built with the platform error format', async () => {
    const broken = (() => {
      throw new Error('Deploy step "x" is registered twice');
    }) as unknown as typeof createCli;

    const code = await runApp(['config'], { ...io(), cwd: work, createCli: broken });

    expect(code).not.toBe(0);
    expect(err).toContain('registered twice');
  });
});
