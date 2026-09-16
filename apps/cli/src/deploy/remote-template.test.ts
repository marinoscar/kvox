import { describe, expect, it } from 'vitest';

import { fetchRemoteTemplate } from './remote-template.js';
import type { CommandResult, RunCommandOptions } from './executor.js';

// =============================================================================
// fetchRemoteTemplate  (issue #230)
// =============================================================================
//
// Every failure path answers `undefined` and never throws — that is the whole
// point of the function, per its own doc comment: this is an optimisation of
// correctness, never a precondition, so nothing here may block an install.
// These tests pin each failure path individually, plus the exact argv a
// GitHub remote produces, using the same canned-responder shape
// `checks/github.test.ts` uses for `runCommand`.
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

  it('is undefined for an empty ref', async () => {
    let called = false;
    const runCommand = fakeRunCommand(() => {
      called = true;
      return result();
    });

    const contents = await fetchRemoteTemplate({
      repoUrl: 'https://github.com/example-owner/example-repo',
      ref: '',
      runCommand,
    });

    expect(contents).toBeUndefined();
    expect(called).toBe(false);
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
