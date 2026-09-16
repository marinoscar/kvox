import { describe, expect, it } from 'vitest';

import { fetchRemoteTemplate } from './remote-template.js';
import type { CommandResult, RunCommandOptions } from './executor.js';

// =============================================================================
// fetchRemoteTemplate  (issue #230, empty-ref handling fixed by #234)
// =============================================================================
//
// Every failure path answers `undefined` and never throws — that is the whole
// point of the function, per its own doc comment: this is an optimisation of
// correctness, never a precondition, so nothing here may block an install.
// These tests pin each failure path individually, plus the exact argv a
// GitHub remote produces, using the same canned-responder shape
// `checks/github.test.ts` uses for `runCommand`.
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

describe('fetchRemoteTemplate', () => {
  it('invokes gh api with the raw Accept header and a URL-encoded ref', async () => {
    let seenArgv: readonly string[] | undefined;
    const runCommand = fakeRunCommand((argv) => {
      seenArgv = argv;
      return result({ stdout: 'KEY=value\n' });
    });

    const contents = await fetchRemoteTemplate({
      repoUrl: 'https://github.com/example-owner/example-repo',
      ref: 'feature/my branch',
      runCommand,
    });

    expect(contents).toBe('KEY=value\n');
    expect(seenArgv).toEqual([
      'gh',
      'api',
      '-H',
      'Accept: application/vnd.github.raw',
      'repos/example-owner/example-repo/contents/infra/compose/.env.example?ref=feature%2Fmy%20branch',
    ]);
  });

  it('is undefined for a non-GitHub remote, and never calls runCommand', async () => {
    let called = false;
    const runCommand = fakeRunCommand(() => {
      called = true;
      return result();
    });

    const contents = await fetchRemoteTemplate({
      repoUrl: 'https://gitlab.example.test/example-owner/example-repo',
      ref: 'main',
      runCommand,
    });

    expect(contents).toBeUndefined();
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

    const contents = await fetchRemoteTemplate({
      repoUrl: 'https://github.com/example-owner/example-repo',
      ref: '',
      runCommand,
    });

    expect(contents).toBe('KEY=value\n');
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

    const contents = await fetchRemoteTemplate({
      repoUrl: 'https://github.com/example-owner/example-repo',
      runCommand,
    });

    expect(contents).toBe('KEY=value\n');
    expect(seenArgv).toEqual([
      'gh',
      'api',
      '-H',
      'Accept: application/vnd.github.raw',
      'repos/example-owner/example-repo/contents/infra/compose/.env.example',
    ]);
  });

  it('is undefined on a non-zero exit code', async () => {
    const runCommand = fakeRunCommand(() =>
      result({ exitCode: 1, stderr: 'HTTP 404: Not Found' }),
    );

    const contents = await fetchRemoteTemplate({
      repoUrl: 'https://github.com/example-owner/example-repo',
      ref: 'main',
      runCommand,
    });

    expect(contents).toBeUndefined();
  });

  it('is undefined, never propagating, when runCommand throws', async () => {
    const runCommand: RunCommandFn = async () => {
      throw new Error('gh: command not found');
    };

    const contents = await fetchRemoteTemplate({
      repoUrl: 'https://github.com/example-owner/example-repo',
      ref: 'main',
      runCommand,
    });

    expect(contents).toBeUndefined();
  });

  it('is undefined for whitespace-only stdout', async () => {
    const runCommand = fakeRunCommand(() => result({ stdout: '   \n  ' }));

    const contents = await fetchRemoteTemplate({
      repoUrl: 'https://github.com/example-owner/example-repo',
      ref: 'main',
      runCommand,
    });

    expect(contents).toBeUndefined();
  });

  it('returns the contents verbatim on success', async () => {
    const body = '# comment\nKEY=value\nOTHER=1\n';
    const runCommand = fakeRunCommand(() => result({ stdout: body }));

    const contents = await fetchRemoteTemplate({
      repoUrl: 'https://github.com/example-owner/example-repo',
      ref: 'main',
      runCommand,
    });

    expect(contents).toBe(body);
  });
});
