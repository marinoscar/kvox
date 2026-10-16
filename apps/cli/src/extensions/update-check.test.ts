import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkForUpdate, renderUpdateCheck, type GitRunner } from './update-check.js';

// =============================================================================
// `deploy update --check`  (issue #123, ported by #482)
// =============================================================================
//
// Two layers: the logic against a fake git (the seam), and the real `git` against
// two local repositories, so the arguments themselves are proven to mean what
// they say. No network anywhere.
// =============================================================================

const NOW = new Date('2026-10-16T12:00:00.000Z');

let work: string;
let deployRoot: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'update-check-'));
  deployRoot = join(work, 'myapp');
  mkdirSync(join(deployRoot, 'repo'), { recursive: true });
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function writeState(record: Record<string, unknown>): void {
  writeFileSync(join(deployRoot, '.appctl-deploy.json'), `${JSON.stringify(record)}\n`);
}

describe('checkForUpdate with a fake git', () => {
  const CURRENT = 'a'.repeat(40);
  const LATEST = 'b'.repeat(40);

  function fakeGit(answers: Record<string, string>): { git: GitRunner; calls: string[][] } {
    const calls: string[][] = [];
    const git: GitRunner = async (_cwd, args) => {
      calls.push([...args]);
      const key = args[0] ?? '';
      if (!(key in answers)) throw new Error(`unexpected git ${key}`);
      return answers[key] as string;
    };
    return { git, calls };
  }

  it('reports nothing behind when the ref resolves to the deployed commit', async () => {
    writeState({ version: 1, commitSha: CURRENT, ref: 'main' });
    const { git, calls } = fakeGit({ fetch: '', 'rev-parse': `${CURRENT}\n` });

    const check = await checkForUpdate({ deployRoot, runGit: git, now: () => NOW });

    expect(check).toEqual({
      current: CURRENT,
      latest: CURRENT,
      commitsBehind: 0,
      commits: [],
      checkedAt: '2026-10-16T12:00:00.000Z',
    });
    // Nothing past the fetch and the resolve: no rev-list, no log, no checkout.
    expect(calls.map((call) => call[0])).toEqual(['fetch', 'rev-parse']);
  });

  it('counts the commits behind and lists their subjects, newest first', async () => {
    writeState({ version: 1, commitSha: CURRENT, ref: 'main' });
    const { git } = fakeGit({
      fetch: '',
      'rev-parse': `${LATEST}\n`,
      'rev-list': '2\n',
      log: `${LATEST}\tfix(api): second\n${'c'.repeat(40)}\tfeat(web): first\n`,
    });

    const check = await checkForUpdate({ deployRoot, runGit: git, now: () => NOW });

    expect(check.commitsBehind).toBe(2);
    expect(check.latest).toBe(LATEST);
    expect(check.commits).toEqual([
      { sha: 'b'.repeat(12), subject: 'fix(api): second' },
      { sha: 'c'.repeat(12), subject: 'feat(web): first' },
    ]);
  });

  it('fetches the recorded ref, or the one --ref names', async () => {
    writeState({ version: 1, commitSha: CURRENT, ref: 'main' });
    const recorded = fakeGit({ fetch: '', 'rev-parse': `${CURRENT}\n` });
    await checkForUpdate({ deployRoot, runGit: recorded.git });
    expect(recorded.calls[0]).toEqual(['fetch', '--quiet', '--tags', 'origin', 'main']);

    const named = fakeGit({ fetch: '', 'rev-parse': `${CURRENT}\n` });
    await checkForUpdate({ deployRoot, runGit: named.git, ref: 'v2.0.0' });
    expect(named.calls[0]).toEqual(['fetch', '--quiet', '--tags', 'origin', 'v2.0.0']);
  });

  it('refuses a ref that could be read as an option', async () => {
    writeState({ version: 1, commitSha: CURRENT, ref: 'main' });
    const { git } = fakeGit({});

    await expect(checkForUpdate({ deployRoot, runGit: git, ref: '--upload-pack=x' })).rejects.toThrow(
      /not a usable ref/,
    );
  });

  it('names the clone and the ref when the fetch fails', async () => {
    writeState({ version: 1, commitSha: CURRENT, ref: 'main' });
    const git: GitRunner = async () => {
      throw new Error('git fetch failed: could not resolve host');
    };

    await expect(checkForUpdate({ deployRoot, runGit: git })).rejects.toThrow(/Could not fetch main.*could not resolve host/s);
  });

  it('says what to do when there is no deployment record', async () => {
    await expect(checkForUpdate({ deployRoot, runGit: async () => '' })).rejects.toThrow(/No deployment record/);
  });

  it('refuses a record with no deployed commit', async () => {
    writeState({ version: 1, ref: 'main' });

    await expect(checkForUpdate({ deployRoot, runGit: async () => '' })).rejects.toThrow(/no deployed commit/);
  });
});

describe('renderUpdateCheck', () => {
  it('prints one line when up to date', () => {
    const sha = 'a'.repeat(40);

    expect(renderUpdateCheck({ current: sha, latest: sha, commitsBehind: 0, commits: [], checkedAt: '' })).toEqual([
      `already up to date at ${'a'.repeat(12)}`,
    ]);
  });

  it('prints a headline and a line per commit, with the right noun', () => {
    const lines = renderUpdateCheck({
      current: 'a'.repeat(40),
      latest: 'b'.repeat(40),
      commitsBehind: 1,
      commits: [{ sha: 'b'.repeat(12), subject: 'fix: it' }],
      checkedAt: '',
    });

    expect(lines[0]).toBe(`current ${'a'.repeat(12)} → latest ${'b'.repeat(12)}, 1 commit behind`);
    expect(lines[1]).toBe(`${'b'.repeat(12)}  fix: it`);
  });
});

describe('checkForUpdate with real git', () => {
  function git(cwd: string, ...args: string[]): string {
    return execFileSync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args],
      { cwd, encoding: 'utf8' },
    ).trim();
  }

  it('reports zero, then one commit behind after the remote moves (the deploy end-to-end legs)', async () => {
    const remote = join(work, 'remote');
    mkdirSync(remote);
    git(remote, 'init', '--quiet', '-b', 'main');
    git(remote, 'commit', '--quiet', '--allow-empty', '-m', 'chore: first');
    const deployed = git(remote, 'rev-parse', 'HEAD');

    rmSync(join(deployRoot, 'repo'), { recursive: true });
    git(work, 'clone', '--quiet', remote, join(deployRoot, 'repo'));
    writeState({ version: 1, commitSha: deployed, ref: 'main' });

    const before = await checkForUpdate({ deployRoot, now: () => NOW });
    expect(before).toMatchObject({ current: deployed, latest: deployed, commitsBehind: 0 });

    git(remote, 'commit', '--quiet', '--allow-empty', '-m', 'chore(e2e): move HEAD');
    const moved = git(remote, 'rev-parse', 'HEAD');

    const after = await checkForUpdate({ deployRoot, now: () => NOW });
    expect(after.commitsBehind).toBe(1);
    expect(after.latest).toBe(moved);
    expect(after.current).toBe(deployed);
    expect(after.commits).toEqual([{ sha: moved.slice(0, 12), subject: 'chore(e2e): move HEAD' }]);

    // The check moved nothing: the clone is still on the deployed commit.
    expect(git(join(deployRoot, 'repo'), 'rev-parse', 'HEAD')).toBe(deployed);
  });
});
