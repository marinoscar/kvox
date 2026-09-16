import { describe, expect, it } from 'vitest';

import { CommandFailedError } from './executor.js';
import { describeRemoteTemplateFailure, fetchRemoteTemplate } from './remote-template.js';
import type { CommandResult, RunCommandOptions } from './executor.js';
import type { RemoteTemplateResult } from './remote-template.js';

// =============================================================================
// fetchRemoteTemplate  (issue #230, empty-ref handling fixed by #234,
// the string | undefined -> RemoteTemplateResult reason taxonomy added by #236)
// =============================================================================
//
// Before #236 every failure path answered a bare `undefined`, and that was the
// defect: an operator staring at a wizard with no questions could not tell a
// non-GitHub remote from an uninstalled `gh`, a logged-out `gh`, a timeout or
// an empty file. Now every failure path answers a REASON (plus, where `gh`
// produced one, the first line of its stderr as `detail`), and these tests pin
// each reason individually, plus the exact argv a GitHub remote produces,
// using the same canned-responder shape `checks/github.test.ts` uses for
// `runCommand`.
//
// An EMPTY ref is deliberately not a failure path (#234): it is the ORDINARY
// case — no pinned ref means "the repository's default branch" — and is
// pinned separately below, alongside the non-empty case, rather than lumped
// in with the genuine failures above it.
// =============================================================================

type RunCommandFn = (argv: readonly string[], options: RunCommandOptions) => Promise<CommandResult>;

function fakeRunCommand(
  handler: (argv: readonly string[]) => CommandResult | Promise<CommandResult>,
): RunCommandFn {
  return async (argv, options) => {
    const result = await handler(argv);
    return { ...result, argv: [...argv], cwd: options.cwd };
  };
}

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    argv: [],
    cwd: '/tmp',
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 1,
    timedOut: false,
    ...overrides,
  };
}

/** A `runCommand` that always rejects with a pre-built `CommandFailedError`. */
function rejectingRunCommand(error: CommandFailedError): RunCommandFn {
  return async () => {
    throw error;
  };
}

describe('fetchRemoteTemplate', () => {
  it('invokes gh api with the raw Accept header and a URL-encoded ref', async () => {
    let seenArgv: readonly string[] | undefined;
    const runCommand = fakeRunCommand((argv) => {
      seenArgv = argv;
      return result({ stdout: 'KEY=value\n' });
    });

    const outcome = await fetchRemoteTemplate({
      repoUrl: 'https://github.com/example-owner/example-repo',
      ref: 'feature/my branch',
      runCommand,
    });

    expect(outcome).toEqual({ ok: true, contents: 'KEY=value\n' });
    expect(seenArgv).toEqual([
      'gh',
      'api',
      '-H',
      'Accept: application/vnd.github.raw',
      'repos/example-owner/example-repo/contents/infra/compose/.env.example?ref=feature%2Fmy%20branch',
    ]);
  });

  it('is not-github for a non-GitHub remote, and never calls runCommand', async () => {
    let called = false;
    const runCommand = fakeRunCommand(() => {
      called = true;
      return result();
    });

    const outcome = await fetchRemoteTemplate({
      repoUrl: 'https://gitlab.example.test/example-owner/example-repo',
      ref: 'main',
      runCommand,
    });

    expect(outcome).toEqual({ ok: false, reason: 'not-github' });
    expect(called).toBe(false);
  });

  it('fetches the default branch for an empty ref, omitting `?ref=` entirely (#234)', async () => {
    // An empty ref is the ORDINARY case, not a missing value: an operator who
    // does not pin a ref is deploying the repository's default branch, and
    // the Review screen renders exactly that as "(default branch)". Before
    // #234 this bailed out with `undefined` and never called `runCommand` at
    // all — the most common first install was the one case that never read
    // the template. Assert the real fetch happens (call B) with the exact
    // argv (no `?ref=` suffix) GitHub's contents API needs to serve the
    // default branch, not merely that the return value looks plausible.
    let seenArgv: readonly string[] | undefined;
    const runCommand = fakeRunCommand((argv) => {
      seenArgv = argv;
      return result({ stdout: 'KEY=value\n' });
    });

    const outcome = await fetchRemoteTemplate({
      repoUrl: 'https://github.com/example-owner/example-repo',
      ref: '',
      runCommand,
    });

    expect(outcome).toEqual({ ok: true, contents: 'KEY=value\n' });
    expect(seenArgv).toEqual([
      'gh',
      'api',
      '-H',
      'Accept: application/vnd.github.raw',
      'repos/example-owner/example-repo/contents/infra/compose/.env.example',
    ]);
  });

  it('fetches the default branch when `ref` is absent entirely, same as an empty string', async () => {
    // `RemoteTemplateRequest.ref` is `string | undefined` since #234 — an
    // absent property must behave identically to an empty one, not throw on
    // `request.ref.trim()`.
    let seenArgv: readonly string[] | undefined;
    const runCommand = fakeRunCommand((argv) => {
      seenArgv = argv;
      return result({ stdout: 'KEY=value\n' });
    });

    const outcome = await fetchRemoteTemplate({
      repoUrl: 'https://github.com/example-owner/example-repo',
      runCommand,
    });

    expect(outcome).toEqual({ ok: true, contents: 'KEY=value\n' });
    expect(seenArgv).toEqual([
      'gh',
      'api',
      '-H',
      'Accept: application/vnd.github.raw',
      'repos/example-owner/example-repo/contents/infra/compose/.env.example',
    ]);
  });

  it('is gh-failed, with the first stderr line as detail, on a non-zero exit code returned as a value', async () => {
    const runCommand = fakeRunCommand(() =>
      result({ exitCode: 1, stderr: 'HTTP 404: Not Found' }),
    );

    const outcome = await fetchRemoteTemplate({
      repoUrl: 'https://github.com/example-owner/example-repo',
      ref: 'main',
      runCommand,
    });

    expect(outcome).toEqual({ ok: false, reason: 'gh-failed', detail: 'HTTP 404: Not Found' });
  });

  it('is gh-failed with no detail when a generic (non-CommandFailedError) throw propagates', async () => {
    const runCommand: RunCommandFn = async () => {
      throw new Error('gh: command not found');
    };

    const outcome = await fetchRemoteTemplate({
      repoUrl: 'https://github.com/example-owner/example-repo',
      ref: 'main',
      runCommand,
    });

    expect(outcome).toEqual({ ok: false, reason: 'gh-failed' });
  });

  it('is empty for whitespace-only stdout', async () => {
    const runCommand = fakeRunCommand(() => result({ stdout: '   \n  ' }));

    const outcome = await fetchRemoteTemplate({
      repoUrl: 'https://github.com/example-owner/example-repo',
      ref: 'main',
      runCommand,
    });

    expect(outcome).toEqual({ ok: false, reason: 'empty' });
  });

  it('returns the contents verbatim on success', async () => {
    const body = '# comment\nKEY=value\nOTHER=1\n';
    const runCommand = fakeRunCommand(() => result({ stdout: body }));

    const outcome = await fetchRemoteTemplate({
      repoUrl: 'https://github.com/example-owner/example-repo',
      ref: 'main',
      runCommand,
    });

    expect(outcome).toEqual({ ok: true, contents: body });
  });

  // ---------------------------------------------------------------------------
  // The new taxonomy (#236): `runCommand` REJECTS on a non-zero exit, and
  // this is where a real `gh` invocation actually lands.
  // ---------------------------------------------------------------------------

  it('is timed-out when runCommand rejects with a CommandFailedError whose result.timedOut is true', async () => {
    const error = new CommandFailedError(
      '`gh api ...` timed out after 15000ms',
      result({ exitCode: -1, timedOut: true, stderr: '' }),
    );
    const runCommand = rejectingRunCommand(error);

    const outcome = await fetchRemoteTemplate({
      repoUrl: 'https://github.com/example-owner/example-repo',
      ref: 'main',
      runCommand,
    });

    expect(outcome).toEqual({ ok: false, reason: 'timed-out' });
  });

  it('is timed-out even when the rejecting error also carries stderr text', async () => {
    // `timedOut` is checked before the exitCode/stderr branches, so a timeout
    // is never misreported as gh-missing or gh-failed just because the killed
    // process had already written something.
    const error = new CommandFailedError(
      '`gh api ...` timed out after 15000ms',
      result({ exitCode: -1, timedOut: true, stderr: 'partial output\n' }),
    );
    const runCommand = rejectingRunCommand(error);

    const outcome = await fetchRemoteTemplate({
      repoUrl: 'https://github.com/example-owner/example-repo',
      ref: 'main',
      runCommand,
    });

    expect(outcome).toEqual({ ok: false, reason: 'timed-out' });
  });

  it('is gh-missing, with the error message as detail, for a spawn that never started (ENOENT / not on PATH)', async () => {
    // executor.ts's own `error` handler reports a spawn failure as exitCode -1
    // with NO stderr — there is nothing to quote, because the child process
    // never ran — and folds the reason into the error's own message instead.
    const error = new CommandFailedError(
      'gh: command not found',
      result({ exitCode: -1, timedOut: false, stderr: '' }),
    );
    const runCommand = rejectingRunCommand(error);

    const outcome = await fetchRemoteTemplate({
      repoUrl: 'https://github.com/example-owner/example-repo',
      ref: 'main',
      runCommand,
    });

    expect(outcome).toEqual({
      ok: false,
      reason: 'gh-missing',
      detail: 'gh: command not found',
    });
  });

  it('is gh-missing even when the ENOENT stderr is whitespace-only, not just empty', async () => {
    const error = new CommandFailedError(
      'gh: command not found',
      result({ exitCode: -1, timedOut: false, stderr: '   \n  ' }),
    );
    const runCommand = rejectingRunCommand(error);

    const outcome = await fetchRemoteTemplate({
      repoUrl: 'https://github.com/example-owner/example-repo',
      ref: 'main',
      runCommand,
    });

    expect(outcome).toEqual({
      ok: false,
      reason: 'gh-missing',
      detail: 'gh: command not found',
    });
  });

  it('is gh-failed, with the FIRST non-blank stderr line as detail, for a logged-out gh', async () => {
    const error = new CommandFailedError(
      '`gh api ...` exited 1',
      result({
        exitCode: 1,
        timedOut: false,
        stderr: '\n  \nTo get started with GitHub CLI, please run: gh auth login\nmore detail on a later line\n',
      }),
    );
    const runCommand = rejectingRunCommand(error);

    const outcome = await fetchRemoteTemplate({
      repoUrl: 'https://github.com/example-owner/example-repo',
      ref: 'main',
      runCommand,
    });

    expect(outcome).toEqual({
      ok: false,
      reason: 'gh-failed',
      detail: 'To get started with GitHub CLI, please run: gh auth login',
    });
  });

  it('is gh-failed with no detail when the rejecting error carries a non-zero exit but no stderr at all', async () => {
    const error = new CommandFailedError(
      '`gh api ...` exited 1',
      result({ exitCode: 1, timedOut: false, stderr: '' }),
    );
    const runCommand = rejectingRunCommand(error);

    const outcome = await fetchRemoteTemplate({
      repoUrl: 'https://github.com/example-owner/example-repo',
      ref: 'main',
      runCommand,
    });

    expect(outcome).toEqual({ ok: false, reason: 'gh-failed' });
  });
});

describe('describeRemoteTemplateFailure', () => {
  function failure(
    reason: Extract<RemoteTemplateResult, { ok: false }>['reason'],
    detail?: string,
  ): Extract<RemoteTemplateResult, { ok: false }> {
    return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
  }

  it('describes not-github', () => {
    expect(describeRemoteTemplateFailure(failure('not-github'))).toBe(
      'the repository is not hosted on GitHub, so its template cannot be read remotely',
    );
  });

  it('describes gh-missing, with no detail', () => {
    expect(describeRemoteTemplateFailure(failure('gh-missing'))).toBe(
      "the GitHub CLI is not installed or not on this user's PATH",
    );
  });

  it('describes gh-missing, interpolating detail when present', () => {
    expect(describeRemoteTemplateFailure(failure('gh-missing', 'gh: command not found'))).toBe(
      "the GitHub CLI is not installed or not on this user's PATH (gh: command not found)",
    );
  });

  it('describes gh-failed, with no detail', () => {
    expect(describeRemoteTemplateFailure(failure('gh-failed'))).toBe(
      'the GitHub CLI could not read it — it is per-user, so check `gh auth status` as the user running this',
    );
  });

  it('describes gh-failed, interpolating detail when present', () => {
    expect(
      describeRemoteTemplateFailure(
        failure('gh-failed', 'To get started with GitHub CLI, please run: gh auth login'),
      ),
    ).toBe(
      'the GitHub CLI could not read it — it is per-user, so check `gh auth status` as the user running this (To get started with GitHub CLI, please run: gh auth login)',
    );
  });

  it('describes timed-out', () => {
    expect(describeRemoteTemplateFailure(failure('timed-out'))).toBe(
      'the GitHub CLI did not answer in time',
    );
  });

  it('describes empty', () => {
    expect(describeRemoteTemplateFailure(failure('empty'))).toBe(
      'the repository’s template file is empty',
    );
  });

  it('produces five distinct, non-empty sentences, one per reason', () => {
    const reasons = ['not-github', 'gh-missing', 'gh-failed', 'timed-out', 'empty'] as const;
    const sentences = reasons.map((reason) => describeRemoteTemplateFailure(failure(reason)));

    for (const sentence of sentences) {
      expect(sentence.trim().length).toBeGreaterThan(0);
    }
    expect(new Set(sentences).size).toBe(reasons.length);
  });
});
