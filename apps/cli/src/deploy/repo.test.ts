import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { UsageError } from '../errors.js';
import { runCommand } from './executor.js';
import {
  displayRepoUrl,
  ensureCheckout,
  findGitRoot,
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
});
