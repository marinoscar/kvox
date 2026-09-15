import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PreconditionError, UsageError } from '../errors.js';
import { CommandFailedError, runCommand, type CommandResult, type RunCommandOptions } from './executor.js';
import {
  compareRevisions,
  displayRepoUrl,
  ensureCheckout,
  ensureGitHubAuth,
  fetchRemote,
  findGitRoot,
  githubSlug,
  hasEmbeddedCredentials,
  normaliseRepoUrl,
  resolveRepoTarget,
} from './repo.js';

// =============================================================================
// Real git, not a mock.
//
// Everything worth getting wrong here - what the default branch of a fork is,
// whether a tag resolves, what a dirty tree looks like - is git's behaviour,
// and a stubbed `git` would only assert that the stub was called.
// =============================================================================

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.test',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.test',
    },
  }).trim();
}

/** A repository whose default branch is deliberately NOT `main`. */
function makeOrigin(defaultBranch = 'develop'): string {
  const dir = mkdtempSync(join(tmpdir(), 'appctl-origin-'));
  git(dir, 'init', '--quiet', `--initial-branch=${defaultBranch}`);
  writeFileSync(join(dir, 'README.md'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '--quiet', '-m', 'first');
  git(dir, 'tag', 'v1.0.0');
  writeFileSync(join(dir, 'README.md'), 'two\n');
  git(dir, 'commit', '--quiet', '-am', 'second');
  return dir;
}

function makeClone(origin: string, defaultBranch = 'develop'): string {
  const dir = mkdtempSync(join(tmpdir(), 'appctl-clone-'));
  const path = join(dir, 'checkout');
  git(dir, 'clone', '--quiet', '--branch', defaultBranch, origin, path);
  return path;
}

function deployRoot(): string {
  return mkdtempSync(join(tmpdir(), 'appctl-deploy-'));
}

describe('normaliseRepoUrl', () => {
  it('strips a trailing .git', () => {
    expect(normaliseRepoUrl('https://example.test/o/r.git')).toBe('https://example.test/o/r');
  });

  it('preserves the ssh scheme', () => {
    // Rewriting ssh to https breaks a server whose access is a deploy key.
    expect(normaliseRepoUrl('git@example.test:o/r.git')).toBe('git@example.test:o/r');
  });

  it('preserves the https scheme', () => {
    // And rewriting https to ssh breaks one that has no key at all.
    expect(normaliseRepoUrl('https://example.test/o/r')).toBe('https://example.test/o/r');
  });

  it('removes embedded credentials', () => {
    expect(normaliseRepoUrl('https://user:token@example.test/o/r.git')).toBe(
      'https://example.test/o/r',
    );
  });

  // A GitHub remote is the exception (#123, epic #118 decision 1): on the
  // server the credential is `gh`, whose helper only answers for https, so
  // every scheme the operator might have copied from a laptop becomes the one
  // canonical clone URL. Spelled with a variable so this file's own template
  // guard below, which forbids naming a repository, keeps passing.
  const canonical = 'https://github.com/acme/widgets.git';

  it.each([
    ['scp-style ssh', 'git@github.com:acme/widgets.git'],
    ['scp-style ssh without .git', 'git@github.com:acme/widgets'],
    ['ssh://', 'ssh://git@github.com/acme/widgets'],
    ['ssh:// with .git', 'ssh://git@github.com/acme/widgets.git'],
    ['https with .git', 'https://github.com/acme/widgets.git'],
    ['https without .git', 'https://github.com/acme/widgets'],
    ['https with a token', 'https://x-access-token:ghp_secret@github.com/acme/widgets.git'],
    ['a trailing slash', 'https://github.com/acme/widgets/'],
  ])('rewrites a GitHub remote to https (%s)', (_label, url) => {
    expect(normaliseRepoUrl(url)).toBe(canonical);
  });

  it('leaves a non-GitHub ssh remote on its own scheme', () => {
    // Another forge reached through a deploy key keeps working; only GitHub
    // is known to be reachable through gh.
    expect(normaliseRepoUrl('git@gitlab.example.test:o/r.git')).toBe('git@gitlab.example.test:o/r');
    expect(normaliseRepoUrl('ssh://git@gitlab.example.test/o/r.git')).toBe(
      'ssh://git@gitlab.example.test/o/r',
    );
  });
});

describe('githubSlug', () => {
  it('is owner/repo for any GitHub scheme', () => {
    for (const url of [
      'git@github.com:acme/widgets.git',
      'ssh://git@github.com/acme/widgets',
      'https://github.com/acme/widgets.git',
      'https://token@github.com/acme/widgets',
    ]) {
      expect(githubSlug(url)).toBe('acme/widgets');
    }
  });

  it('is null for another forge, a local remote and nonsense', () => {
    expect(githubSlug('https://gitlab.example.test/o/r.git')).toBeNull();
    expect(githubSlug('file:///srv/git/r.git')).toBeNull();
    expect(githubSlug('/srv/git/r')).toBeNull();
    expect(githubSlug('')).toBeNull();
  });
});

/** A `runCommand` that answers from a table and records every argv. */
function cannedRunCommand(
  answer: (argv: readonly string[]) => { exitCode: number; stdout?: string; stderr?: string },
  seen: string[][] = [],
) {
  return (async (argv: readonly string[], options: RunCommandOptions): Promise<CommandResult> => {
    seen.push([...argv]);
    const canned = answer(argv);
    const result: CommandResult = {
      argv: [...argv],
      cwd: options.cwd,
      exitCode: canned.exitCode,
      stdout: canned.stdout ?? '',
      stderr: canned.stderr ?? '',
      durationMs: 1,
      timedOut: false,
    };
    if (result.exitCode !== 0) throw new CommandFailedError(result.stderr, result);
    return result;
  }) as typeof runCommand;
}

describe('ensureGitHubAuth', () => {
  it('checks the login, then hands git the token, for a GitHub remote', async () => {
    const seen: string[][] = [];
    const progress: string[] = [];

    const result = await ensureGitHubAuth({
      runCommand: cannedRunCommand(() => ({ exitCode: 0 }), seen),
      repoUrl: 'git@github.com:acme/widgets.git',
      cwd: tmpdir(),
      hooks: { onProgress: (message) => progress.push(message) },
    });

    expect(result).toEqual({ slug: 'acme/widgets' });
    expect(seen).toEqual([
      ['gh', 'auth', 'status'],
      ['gh', 'auth', 'setup-git', '--hostname', 'github.com'],
    ]);
    expect(progress.some((line) => line.includes('gh'))).toBe(true);
  });

  it('does nothing at all for a remote that is not on GitHub', async () => {
    const seen: string[][] = [];

    const result = await ensureGitHubAuth({
      runCommand: cannedRunCommand(() => ({ exitCode: 0 }), seen),
      repoUrl: 'https://gitlab.example.test/o/r.git',
      cwd: tmpdir(),
    });

    expect(result).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it('stops with the login command, before setup-git, when gh is logged out', async () => {
    const seen: string[][] = [];

    const error = await ensureGitHubAuth({
      runCommand: cannedRunCommand(
        (argv) =>
          argv[2] === 'status'
            ? { exitCode: 1, stderr: 'You are not logged in to any GitHub hosts.' }
            : { exitCode: 0 },
        seen,
      ),
      repoUrl: 'https://github.com/acme/widgets',
      cwd: tmpdir(),
    }).catch((caught: unknown) => caught);

    // A precondition, so install exits 6 with nothing cloned - not a generic
    // failure halfway through.
    expect(error).toBeInstanceOf(PreconditionError);
    expect((error as Error).message).toContain('gh auth login --hostname github.com --git-protocol https');
    expect((error as Error).message).toContain('acme/widgets');
    expect(seen).toEqual([['gh', 'auth', 'status']]);
  });

  it('names setup-git when that is the step that failed', async () => {
    const error = await ensureGitHubAuth({
      runCommand: cannedRunCommand((argv) =>
        argv[2] === 'setup-git' ? { exitCode: 1, stderr: 'unknown command' } : { exitCode: 0 },
      ),
      repoUrl: 'https://github.com/acme/widgets',
      cwd: tmpdir(),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PreconditionError);
    expect((error as Error).message).toContain('gh auth setup-git --hostname github.com');
  });
});

describe('credential handling', () => {
  it('recognises an embedded credential', () => {
    expect(hasEmbeddedCredentials('https://u:t@example.test/o/r')).toBe(true);
    expect(hasEmbeddedCredentials('https://example.test/o/r')).toBe(false);
  });

  it('redacts a token for display', () => {
    expect(displayRepoUrl('https://user:ghp_secret@example.test/o/r')).toBe(
      'https://***@example.test/o/r',
    );
  });
});

describe('findGitRoot', () => {
  it('finds the root from a nested subdirectory', () => {
    const origin = makeOrigin();
    const nested = join(origin, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });

    expect(findGitRoot(nested)).toBe(resolve(origin));
  });

  it('is undefined outside a checkout', () => {
    expect(findGitRoot(mkdtempSync(join(tmpdir(), 'appctl-nogit-')))).toBeUndefined();
  });
});

describe('resolveRepoTarget', () => {
  it('reads the origin and current branch from the checkout', async () => {
    const origin = makeOrigin();
    const clone = makeClone(origin);

    const target = await resolveRepoTarget({ cwd: clone, runCommand });

    expect(target.source).toBe('git-remote');
    expect(target.url).toBe(normaliseRepoUrl(origin));
    // NOT assumed to be main. Deploying the wrong branch on a fork that uses
    // develop is a mistake that looks like a successful deployment.
    expect(target.ref).toBe('develop');
  });

  it('works from a nested directory inside the checkout', async () => {
    const clone = makeClone(makeOrigin());
    const nested = join(clone, 'deep', 'path');
    mkdirSync(nested, { recursive: true });

    const target = await resolveRepoTarget({ cwd: nested, runCommand });
    expect(target.ref).toBe('develop');
  });

  it('lets --repo win over everything', async () => {
    const clone = makeClone(makeOrigin());

    const target = await resolveRepoTarget({
      cwd: clone,
      runCommand,
      repoFlag: 'https://example.test/other/repo.git',
      refFlag: 'v2',
      state: { repoUrl: 'https://example.test/state/repo', ref: 'stateref' },
    });

    expect(target).toMatchObject({
      url: 'https://example.test/other/repo',
      ref: 'v2',
      source: 'flag',
    });
  });

  it('lets recorded state win over the checkout', async () => {
    const clone = makeClone(makeOrigin());

    const target = await resolveRepoTarget({
      cwd: clone,
      runCommand,
      state: { repoUrl: 'https://example.test/state/repo', ref: 'v1.0.0' },
    });

    // An install pinned to a tag must not be quietly moved to whatever branch
    // the operator's shell happens to be on.
    expect(target).toMatchObject({ ref: 'v1.0.0', source: 'state' });
  });

  it('lets --ref override the recorded state', async () => {
    const clone = makeClone(makeOrigin());

    const target = await resolveRepoTarget({
      cwd: clone,
      runCommand,
      refFlag: 'hotfix',
      state: { repoUrl: 'https://example.test/state/repo', ref: 'v1.0.0' },
    });

    expect(target.ref).toBe('hotfix');
  });

  it('names --repo when there is no checkout to read', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'appctl-nogit-'));

    const error = await resolveRepoTarget({ cwd: outside, runCommand }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain('--repo');
  });

  it('names --repo when the checkout has no origin', async () => {
    const orphan = mkdtempSync(join(tmpdir(), 'appctl-orphan-'));
    git(orphan, 'init', '--quiet');

    const error = await resolveRepoTarget({ cwd: orphan, runCommand }).catch(
      (caught: unknown) => caught,
    );

    expect((error as Error).message).toContain('--repo');
  });
});

describe('the template property', () => {
  it('names no repository anywhere in the module', () => {
    // If a repository owner or name were hardcoded, every fork of this
    // template would have to patch the CLI before it could deploy itself -
    // which is the exact problem this issue exists to prevent.
    const source = readFileSync(new URL('./repo.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('EnterpriseAppBase');
    expect(source).not.toContain('marinoscar');
    expect(source).not.toMatch(/github\.com\/[a-z]/i);
  });
});

describe('ensureCheckout', () => {
  it('clones when nothing is there, and reports the commit', async () => {
    const origin = makeOrigin();
    const root = deployRoot();

    const result = await ensureCheckout(
      { url: origin, ref: 'develop', source: 'flag' },
      { deployRoot: root, runCommand },
    );

    expect(result.previousSha).toBeUndefined();
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.changed).toBe(true);
    expect(readFileSync(join(result.path, 'README.md'), 'utf8')).toBe('two\n');
  });

  it('reports changed: false when the ref has not moved', async () => {
    const origin = makeOrigin();
    const root = deployRoot();
    const target = { url: origin, ref: 'develop', source: 'flag' as const };

    const first = await ensureCheckout(target, { deployRoot: root, runCommand });
    const second = await ensureCheckout(target, { deployRoot: root, runCommand });

    // This is what lets `update` exit early instead of rebuilding for nothing.
    expect(second.changed).toBe(false);
    expect(second.previousSha).toBe(first.sha);
  });

  it('moves to a new commit and reports the previous one', async () => {
    const origin = makeOrigin();
    const root = deployRoot();
    const target = { url: origin, ref: 'develop', source: 'flag' as const };

    const first = await ensureCheckout(target, { deployRoot: root, runCommand });
    writeFileSync(join(origin, 'README.md'), 'three\n');
    git(origin, 'commit', '--quiet', '-am', 'third');

    const second = await ensureCheckout(target, { deployRoot: root, runCommand });

    expect(second.changed).toBe(true);
    expect(second.previousSha).toBe(first.sha);
    expect(second.sha).not.toBe(first.sha);
  });

  it('checks out a tag', async () => {
    const origin = makeOrigin();
    const root = deployRoot();

    const result = await ensureCheckout(
      { url: origin, ref: 'v1.0.0', source: 'flag' },
      { deployRoot: root, runCommand },
    );

    expect(readFileSync(join(result.path, 'README.md'), 'utf8')).toBe('one\n');
  });

  it('checks out an explicit commit', async () => {
    const origin = makeOrigin();
    const root = deployRoot();
    const sha = git(origin, 'rev-parse', 'HEAD~1');

    const result = await ensureCheckout(
      { url: origin, ref: sha, source: 'flag' },
      { deployRoot: root, runCommand },
    );

    expect(result.sha).toBe(sha);
  });

  it('rejects a ref that does not exist, naming it', async () => {
    const origin = makeOrigin();
    const root = deployRoot();

    const error = await ensureCheckout(
      { url: origin, ref: 'no-such-branch', source: 'flag' },
      { deployRoot: root, runCommand },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain('no-such-branch');
  });

  it('refuses to discard uncommitted changes, listing them', async () => {
    const origin = makeOrigin();
    const root = deployRoot();
    const target = { url: origin, ref: 'develop', source: 'flag' as const };

    const first = await ensureCheckout(target, { deployRoot: root, runCommand });
    writeFileSync(join(first.path, 'README.md'), 'hand-patched on the server\n');

    const error = await ensureCheckout(target, { deployRoot: root, runCommand }).catch(
      (caught: unknown) => caught,
    );

    // Someone hand-patched a file on the server; resetting over it silently is
    // how a fix disappears and nobody knows why the bug came back.
    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain('README.md');
    expect((error as Error).message).toContain('--force');
  });

  it('discards them with --force', async () => {
    const origin = makeOrigin();
    const root = deployRoot();
    const target = { url: origin, ref: 'develop', source: 'flag' as const };

    const first = await ensureCheckout(target, { deployRoot: root, runCommand });
    writeFileSync(join(first.path, 'README.md'), 'hand-patched\n');

    const result = await ensureCheckout(target, {
      deployRoot: root,
      runCommand,
      force: true,
    });

    expect(readFileSync(join(result.path, 'README.md'), 'utf8')).toBe('two\n');
  });

  it('reports git output through the hooks', async () => {
    const origin = makeOrigin();
    const root = deployRoot();
    const progress: string[] = [];

    await ensureCheckout(
      { url: origin, ref: 'develop', source: 'flag' },
      {
        deployRoot: root,
        runCommand,
        hooks: { onProgress: (message) => progress.push(message) },
      },
    );

    expect(progress.some((line) => line.startsWith('Cloning'))).toBe(true);
  });

  it('explains an authentication failure instead of surfacing raw git output', async () => {
    const root = deployRoot();

    const error = await ensureCheckout(
      { url: 'https://example.invalid/nope/nope', ref: 'main', source: 'flag' },
      { deployRoot: root, runCommand },
    ).catch((caught: unknown) => caught);

    // Whatever git said, the operator gets something they can act on.
    expect(error).toBeInstanceOf(Error);
  });

  it('points an authentication failure at gh, and says the CLI reruns setup-git', async () => {
    const error = await ensureCheckout(
      { url: 'https://example.test/private/repo', ref: 'main', source: 'flag' },
      {
        deployRoot: deployRoot(),
        runCommand: cannedRunCommand(() => ({
          exitCode: 128,
          stderr: "remote: Invalid username or password.\nfatal: Authentication failed for 'https://example.test/private/repo'",
        })),
      },
    ).catch((caught: unknown) => caught);

    // The credential on the server is the GitHub CLI (#123): the remedy names
    // the two commands, in order, and which one the next run repeats itself.
    expect(error).toBeInstanceOf(UsageError);
    const message = (error as Error).message;
    expect(message).toContain('gh auth login');
    expect(message).toContain('gh auth setup-git');
    expect(message.indexOf('gh auth login')).toBeLessThan(message.indexOf('gh auth setup-git'));
    expect(message).toMatch(/next install or update/);
  });

  it('never spawns gh itself', async () => {
    // ensureGitHubAuth is its own pipeline step precisely so that these tests
    // can run the real runCommand against local repositories.
    const origin = makeOrigin();
    const root = deployRoot();
    const seen: string[][] = [];
    const recording = (async (argv: readonly string[], options: RunCommandOptions) => {
      seen.push([...argv]);
      return runCommand(argv, options);
    }) as typeof runCommand;

    await ensureCheckout({ url: origin, ref: 'develop', source: 'flag' }, { deployRoot: root, runCommand: recording });
    await ensureCheckout({ url: origin, ref: 'develop', source: 'flag' }, { deployRoot: root, runCommand: recording });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((argv) => argv[0] === 'git')).toBe(true);
  });
});

describe('fetchRemote and compareRevisions', () => {
  it('resolves the ref without moving the checkout', async () => {
    const origin = makeOrigin();
    const root = deployRoot();
    const target = { url: origin, ref: 'develop', source: 'flag' as const };

    const first = await ensureCheckout(target, { deployRoot: root, runCommand });
    writeFileSync(join(origin, 'README.md'), 'three\n');
    git(origin, 'commit', '--quiet', '-am', 'third');
    writeFileSync(join(origin, 'README.md'), 'four\n');
    git(origin, 'commit', '--quiet', '-am', 'fourth');

    const fetched = await fetchRemote(target, { deployRoot: root, runCommand });

    // The remote moved and the fetch saw it - but HEAD is where it was: an
    // `update --check` must leave the deployed clone exactly as it found it.
    expect(fetched.cloned).toBe(false);
    expect(fetched.previousSha).toBe(first.sha);
    expect(fetched.resolved).toBe(git(origin, 'rev-parse', 'HEAD'));
    expect(git(fetched.path, 'rev-parse', 'HEAD')).toBe(first.sha);
    expect(readFileSync(join(fetched.path, 'README.md'), 'utf8')).toBe('two\n');

    const comparison = await compareRevisions(
      { cwd: fetched.path, runCommand },
      first.sha,
      fetched.resolved,
    );
    expect(comparison.commitsBehind).toBe(2);
    expect(comparison.commits.map((commit) => commit.subject)).toEqual(['fourth', 'third']);
    expect(comparison.commits.every((commit) => /^[0-9a-f]{7,}$/.test(commit.sha))).toBe(true);

    // And the checkout can then be completed from what was already fetched.
    const second = await ensureCheckout(target, { deployRoot: root, runCommand, fetched });
    expect(second.changed).toBe(true);
    expect(second.sha).toBe(fetched.resolved);
  });

  it('is zero commits behind, with no log, when nothing moved', async () => {
    const origin = makeOrigin();
    const root = deployRoot();
    const target = { url: origin, ref: 'develop', source: 'flag' as const };

    const first = await ensureCheckout(target, { deployRoot: root, runCommand });
    const fetched = await fetchRemote(target, { deployRoot: root, runCommand });

    expect(fetched.resolved).toBe(first.sha);
    await expect(
      compareRevisions({ cwd: fetched.path, runCommand }, first.sha, fetched.resolved),
    ).resolves.toEqual({ commitsBehind: 0, commits: [] });
  });

  it('refuses to clone when asked only to compare', async () => {
    const root = deployRoot();

    const error = await fetchRemote(
      { url: makeOrigin(), ref: 'develop', source: 'flag' },
      { deployRoot: root, runCommand, requireExisting: true },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UsageError);
    expect(existsSync(join(root, 'repo'))).toBe(false);
  });
});
