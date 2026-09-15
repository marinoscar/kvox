import { describe, expect, it } from 'vitest';

import { CommandFailedError, type CommandResult, type RunCommandOptions } from '../executor.js';
import { GITHUB_CHECKS, parseGithubRepo } from './github.js';
import { runChecks, type Check, type CheckContext } from './types.js';

// =============================================================================
// The gh checks are driven through canned `gh` output, exactly like host.test.ts
// drives docker: what matters is what a check CONCLUDES from the tool.
// =============================================================================

type Responder = (argv: readonly string[]) => { exitCode: number; stdout?: string; stderr?: string } | undefined;

function fakeRunCommand(respond: Responder): typeof import('../executor.js').runCommand {
  return (async (argv: readonly string[], options: RunCommandOptions): Promise<CommandResult> => {
    const canned = respond(argv) ?? { exitCode: 127, stderr: `${argv[0]}: command not found` };
    const result: CommandResult = {
      argv: [...argv],
      cwd: options.cwd,
      exitCode: canned.exitCode,
      stdout: canned.stdout ?? '',
      stderr: canned.stderr ?? '',
      durationMs: 1,
      timedOut: false,
    };
    if (result.exitCode !== 0) throw new CommandFailedError(result.stderr || 'failed', result);
    return result;
  }) as typeof import('../executor.js').runCommand;
}

/** A server where gh is installed, logged in, and can see the repository. */
const HEALTHY: Responder = (argv) => {
  const line = argv.join(' ');
  if (line.startsWith('gh --version')) return { exitCode: 0, stdout: 'gh version 2.40.1 (2023-12-13)\nhttps://github.com/cli/cli/releases/tag/v2.40.1' };
  if (line.startsWith('gh auth status')) {
    return { exitCode: 0, stdout: 'github.com\n  ✓ Logged in to github.com account octocat (keyring)\n  - Git operations protocol: https' };
  }
  if (line.startsWith('gh repo view')) return { exitCode: 0, stdout: '{"name":"kvox"}' };
  return undefined;
};

function context(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    runCommand: fakeRunCommand(HEALTHY),
    deployRoot: '/opt/infra/apps/demo',
    bindPort: 3535,
    proxyRoot: '/opt/infra/proxy',
    repoUrl: 'https://github.com/example-owner/kvox',
    ...overrides,
  };
}

function find(id: string): Check {
  const check = GITHUB_CHECKS.find((candidate) => candidate.id === id);
  if (check === undefined) throw new Error(`no check ${id}`);
  return check;
}

describe('parseGithubRepo', () => {
  it('reads owner and name from every scheme git accepts', () => {
    expect(parseGithubRepo('https://github.com/o/r.git')).toEqual({ owner: 'o', name: 'r' });
    expect(parseGithubRepo('https://github.com/o/r')).toEqual({ owner: 'o', name: 'r' });
    expect(parseGithubRepo('https://token@github.com/o/r.git')).toEqual({ owner: 'o', name: 'r' });
    expect(parseGithubRepo('git@github.com:o/r.git')).toEqual({ owner: 'o', name: 'r' });
    expect(parseGithubRepo('ssh://git@github.com/o/r.git')).toEqual({ owner: 'o', name: 'r' });
  });

  it('is undefined for another forge or a local remote', () => {
    expect(parseGithubRepo('https://gitlab.example.test/o/r.git')).toBeUndefined();
    expect(parseGithubRepo('file:///srv/git/r.git')).toBeUndefined();
    expect(parseGithubRepo('/srv/git/r')).toBeUndefined();
    expect(parseGithubRepo('https://github.com/only-owner')).toBeUndefined();
  });
});

describe('the gh checks together', () => {
  it('pass on a healthy server', async () => {
    const results = await runChecks(GITHUB_CHECKS, context());

    expect(results.map((result) => result.status)).toEqual(['pass', 'pass', 'pass']);
  });

  it('run in the order installed -> authenticated -> repo access', () => {
    expect(GITHUB_CHECKS.map((check) => check.id)).toEqual([
      'gh-installed',
      'gh-authenticated',
      'gh-repo-access',
    ]);
    expect(find('gh-authenticated').requires).toEqual(['gh-installed']);
    expect(find('gh-repo-access').requires).toEqual(['gh-authenticated']);
  });

  it('are all required: the clone cannot happen without them', () => {
    expect(GITHUB_CHECKS.every((check) => check.severity === 'required')).toBe(true);
  });

  it('all skip under --skip-github, naming the flag', async () => {
    // CI deploys from a file:// remote and has no gh at all.
    const results = await runChecks(GITHUB_CHECKS, context({ skipGithub: true }));

    expect(results.every((result) => result.status === 'skip')).toBe(true);
    expect(results[0]?.detail).toBe('--skip-github');
  });

  it('give every failure a remedy naming a command', async () => {
    const results = await runChecks(
      GITHUB_CHECKS,
      context({ runCommand: fakeRunCommand(() => undefined) }),
    );

    for (const result of results.filter((entry) => entry.status === 'fail')) {
      expect(result.remedy ?? '').not.toBe('');
    }
  });
});

describe('gh-installed', () => {
  it('reports the version', async () => {
    const result = await find('gh-installed').run(context());

    expect(result.status).toBe('pass');
    expect(result.detail).toBe('2.40.1 (2023-12-13)');
  });

  it('fails with the apt install lines when the binary is missing', async () => {
    const result = await find('gh-installed').run(
      context({ runCommand: fakeRunCommand(() => undefined) }),
    );

    expect(result.status).toBe('fail');
    expect(result.remedy).toContain('githubcli-archive-keyring.gpg');
    expect(result.remedy).toContain('apt install gh');
  });
});

describe('gh-authenticated', () => {
  it('names the logged-in account', async () => {
    const result = await find('gh-authenticated').run(context());

    expect(result.status).toBe('pass');
    expect(result.detail).toContain('octocat');
  });

  it('still passes when the report arrives on stderr, as older gh versions do', async () => {
    const result = await find('gh-authenticated').run(
      context({
        runCommand: fakeRunCommand((argv) =>
          argv.join(' ').startsWith('gh auth status')
            ? { exitCode: 0, stderr: 'github.com\n  ✓ Logged in to github.com as octocat (oauth_token)' }
            : HEALTHY(argv),
        ),
      }),
    );

    expect(result.status).toBe('pass');
    expect(result.detail).toContain('octocat');
  });

  it('fails with the exact login command when logged out', async () => {
    const result = await find('gh-authenticated').run(
      context({
        runCommand: fakeRunCommand((argv) =>
          argv.join(' ').startsWith('gh auth status')
            ? { exitCode: 1, stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login' }
            : HEALTHY(argv),
        ),
      }),
    );

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('not logged');
    expect(result.remedy).toContain('gh auth login --hostname github.com --git-protocol https');
    expect(result.remedy).toContain('--with-token');
  });

  it('is skipped by the runner when gh is not installed at all', async () => {
    const results = await runChecks(
      GITHUB_CHECKS,
      context({ runCommand: fakeRunCommand(() => undefined) }),
    );

    expect(results[0]?.status).toBe('fail');
    expect(results[1]?.status).toBe('skip');
    expect(results[1]?.detail).toContain('gh-installed');
  });
});

describe('gh-repo-access', () => {
  it('asks gh for the repository named by the resolved URL', async () => {
    const seen: string[][] = [];
    const result = await find('gh-repo-access').run(
      context({
        repoUrl: 'git@github.com:example-owner/kvox.git',
        runCommand: fakeRunCommand((argv) => {
          seen.push([...argv]);
          return HEALTHY(argv);
        }),
      }),
    );

    expect(result.status).toBe('pass');
    expect(result.detail).toBe('example-owner/kvox');
    expect(seen[0]).toEqual(['gh', 'repo', 'view', 'example-owner/kvox', '--json', 'name']);
  });

  it('fails naming the repository the account cannot see', async () => {
    const result = await find('gh-repo-access').run(
      context({
        runCommand: fakeRunCommand((argv) =>
          argv.join(' ').startsWith('gh repo view')
            ? { exitCode: 1, stderr: 'GraphQL: Could not resolve to a Repository with the name' }
            : HEALTHY(argv),
        ),
      }),
    );

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('example-owner/kvox');
    expect(result.remedy).toContain('example-owner/kvox');
    expect(result.remedy).toContain('gh auth login');
  });

  it('skips when the repository is not on github.com', async () => {
    // A fork on another forge deploys with plain git; gh is never consulted.
    const seen: string[][] = [];
    const result = await find('gh-repo-access').run(
      context({
        repoUrl: 'https://gitlab.example.test/o/r.git',
        runCommand: fakeRunCommand((argv) => {
          seen.push([...argv]);
          return HEALTHY(argv);
        }),
      }),
    );

    expect(result.status).toBe('skip');
    expect(result.detail).toContain('not on github.com');
    expect(seen).toEqual([]);
  });

  it('skips when no repository has been resolved, as doctor outside a checkout', async () => {
    const result = await find('gh-repo-access').run(context({ repoUrl: undefined }));

    expect(result.status).toBe('skip');
    expect(result.detail).toContain('no repository');
  });
});
