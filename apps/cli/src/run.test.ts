import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { createCli } from '@marinoscar/platform-cli';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reconcileForArgv } from './extensions/compose-project.js';
import type { DockerRunner } from './extensions/docker-ports.check.js';
import { runApp } from './run.js';

// `runApp` has no Docker seam, so the reconcile step is replaced by a spy; a test that needs the
// real step drives it through the spy with a fake Docker (see "the compose project step").
vi.mock('./extensions/compose-project.js', () => ({
  reconcileForArgv: vi.fn(async () => undefined),
}));

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
let order: string[];

const io = (): { stdout: { write(t: string): void }; stderr: { write(t: string): void } } => ({
  stdout: { write: (t) => void (out += t) },
  stderr: { write: (t) => void (err += t) },
});

function fakeCreateCli(exitCode = 0): typeof createCli {
  return (() => ({
    program: {} as never,
    run: vi.fn(async (argv: string[]) => {
      order.push('cli.run');
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
  order = [];
  vi.mocked(reconcileForArgv).mockReset();
  vi.mocked(reconcileForArgv).mockResolvedValue(undefined);
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

describe('runApp: the compose project step (issue #736)', () => {
  const STATE = join('myapp', '.appctl-deploy.json');

  /** The real step, with a fake Docker in place of the `docker` on the PATH. */
  async function realReconcile(run: DockerRunner): Promise<void> {
    const actual = await vi.importActual<typeof import('./extensions/compose-project.js')>(
      './extensions/compose-project.js',
    );
    vi.mocked(reconcileForArgv).mockImplementation((argv, cwd) => actual.reconcileForArgv(argv, cwd, run));
  }

  const dockerWith = (project: string): DockerRunner => async (args) =>
    args[0] === 'ps' ? 'abc\n' : `${project}|${join(appsRoot, 'myapp', 'repo', 'infra', 'compose')}\n`;

  it('runs before the platform CLI, with the translated arguments and the working directory', async () => {
    vi.mocked(reconcileForArgv).mockImplementation(async () => {
      order.push('reconcile');
      return undefined;
    });

    await runApp(['deploy', 'update', '--apps-root', appsRoot, '--skip-github'], {
      ...io(),
      cwd: work,
      createCli: fakeCreateCli(),
    });

    expect(order).toEqual(['reconcile', 'cli.run']);
    expect(reconcileForArgv).toHaveBeenCalledTimes(1);
    expect(reconcileForArgv).toHaveBeenCalledWith(['deploy', 'update', '--apps-root', appsRoot], work);
  });

  it('writes its note to stderr, not stdout, and still hands the arguments over', async () => {
    vi.mocked(reconcileForArgv).mockResolvedValue('myapp: note: recorded compose project myapp');

    const code = await runApp(['deploy', 'status', '--apps-root', appsRoot], {
      ...io(),
      cwd: work,
      createCli: fakeCreateCli(),
    });

    expect(code).toBe(0);
    expect(err).toBe('myapp: note: recorded compose project myapp\n');
    expect(out).toBe('');
    expect(handed).toEqual([['deploy', 'status', '--apps-root', appsRoot]]);
  });

  it('prints nothing when the step has nothing to say', async () => {
    await runApp(['deploy', 'status', '--apps-root', appsRoot], { ...io(), cwd: work, createCli: fakeCreateCli() });

    expect(err).toBe('');
  });

  it('runs after the legacy translation notes', async () => {
    vi.mocked(reconcileForArgv).mockResolvedValue('after-notes');

    await runApp(['deploy', 'update', '--apps-root', appsRoot, '--skip-github'], {
      ...io(),
      cwd: work,
      createCli: fakeCreateCli(),
    });

    expect(err.indexOf('--skip-github is ignored')).toBeGreaterThanOrEqual(0);
    expect(err.indexOf('--skip-github is ignored')).toBeLessThan(err.indexOf('after-notes'));
  });

  it('does not run for a flag it refuses, for update --check, or when the CLI cannot be built', async () => {
    await runApp(['deploy', 'install', '--fresh'], { ...io(), cwd: work, createCli: fakeCreateCli() });
    await runApp(['deploy', 'update', '--apps-root', appsRoot, '--check'], {
      ...io(),
      cwd: work,
      runGit: async () => '',
    });
    await runApp(['deploy', 'update', '--apps-root', appsRoot], {
      ...io(),
      cwd: work,
      createCli: (() => {
        throw new Error('broken');
      }) as unknown as typeof createCli,
    });

    expect(reconcileForArgv).not.toHaveBeenCalled();
  });

  it('records the project Docker names before the platform reads the state file', async () => {
    await realReconcile(dockerWith('myapp'));
    let seenByPlatform: unknown;
    const reading = (() => ({
      program: {} as never,
      run: async () => {
        order.push('cli.run');
        seenByPlatform = JSON.parse(readFileSync(join(appsRoot, STATE), 'utf8')).composeProject;
        return 0;
      },
    })) as unknown as typeof createCli;

    const code = await runApp(['deploy', 'status', '--apps-root', appsRoot], { ...io(), cwd: work, createCli: reading });

    expect(code).toBe(0);
    expect(seenByPlatform).toBe('myapp');
    expect(err).toContain('recorded compose project myapp');
  });

  it('never changes the exit code when Docker throws', async () => {
    await realReconcile(async () => {
      throw new Error('Cannot connect to the Docker daemon');
    });
    const before = readFileSync(join(appsRoot, STATE), 'utf8');

    const code = await runApp(['deploy', 'status', '--apps-root', appsRoot], {
      ...io(),
      cwd: work,
      createCli: fakeCreateCli(3),
    });

    expect(code).toBe(3);
    expect(handed).toEqual([['deploy', 'status', '--apps-root', appsRoot]]);
    expect(err).toBe('');
    expect(readFileSync(join(appsRoot, STATE), 'utf8')).toBe(before);
  });
});
