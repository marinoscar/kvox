import { describe, expect, it } from 'vitest';

import { EXIT, exitCodeFor } from '../errors.js';
import {
  CommandFailedError,
  describeFailure,
  runCommand,
  stripAnsi,
  type OutputStream,
} from './executor.js';

// Real child processes, not a mocked `spawn`. Everything worth getting wrong
// here - chunk boundaries, exit codes, a killed process, ENOENT - is behaviour
// of the runtime, and a mock would only assert that the mock was called.
const NODE = process.execPath;

function node(script: string): string[] {
  return [NODE, '-e', script];
}

const CWD = process.cwd();
const ESC = String.fromCharCode(27);

describe('stripAnsi', () => {
  it('removes colour sequences and keeps the text', () => {
    expect(stripAnsi(`${ESC}[32mgreen${ESC}[0m`)).toBe('green');
  });

  it('removes cursor movement', () => {
    expect(stripAnsi(`a${ESC}[2Kb`)).toBe('ab');
  });

  it('removes an OSC window-title sequence', () => {
    expect(stripAnsi(`${ESC}]0;title${String.fromCharCode(7)}text`)).toBe('text');
  });

  it('leaves plain text untouched', () => {
    expect(stripAnsi('nothing to do')).toBe('nothing to do');
  });
});

describe('runCommand', () => {
  it('resolves with stdout for a successful command', async () => {
    const result = await runCommand(node('process.stdout.write("hello")'), {
      cwd: CWD,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello');
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('captures stderr separately from stdout', async () => {
    const result = await runCommand(
      node('process.stdout.write("out\\n");process.stderr.write("err\\n")'),
      { cwd: CWD },
    );

    expect(result.stdout).toBe('out');
    expect(result.stderr).toBe('err');
  });

  it('rejects with the exit code and the stderr tail', async () => {
    const error = await runCommand(
      node('process.stderr.write("boom\\n");process.exit(3)'),
      { cwd: CWD },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CommandFailedError);
    const failure = error as CommandFailedError;
    expect(failure.result.exitCode).toBe(3);
    expect(failure.message).toContain('exited 3');
    expect(failure.message).toContain('boom');
    // A failed command is an ordinary failure of this CLI's work.
    expect(exitCodeFor(failure)).toBe(EXIT.FAILURE);
  });

  it('treats a listed non-zero code as success', async () => {
    const result = await runCommand(node('process.exit(1)'), {
      cwd: CWD,
      allowExitCodes: [1],
    });

    expect(result.exitCode).toBe(1);
  });

  it('streams whole lines in order, across chunk boundaries', async () => {
    const seen: Array<[string, OutputStream]> = [];

    await runCommand(
      node(
        'process.stdout.write("one\\ntw");' +
          'setTimeout(()=>process.stdout.write("o\\nthree\\n"),10)',
      ),
      { cwd: CWD, onLine: (line, stream) => seen.push([line, stream]) },
    );

    // "two" arrives split across two writes and must not be reported as "tw".
    expect(seen).toEqual([
      ['one', 'stdout'],
      ['two', 'stdout'],
      ['three', 'stdout'],
    ]);
  });

  it('emits a trailing line that has no newline', async () => {
    const seen: string[] = [];

    await runCommand(node('process.stdout.write("no trailing newline")'), {
      cwd: CWD,
      onLine: (line) => seen.push(line),
    });

    expect(seen).toEqual(['no trailing newline']);
  });

  it('strips ANSI from streamed lines and from the result', async () => {
    const seen: string[] = [];

    const result = await runCommand(
      node('process.stdout.write("\\u001b[32mgreen\\u001b[0m\\n")'),
      { cwd: CWD, onLine: (line) => seen.push(line) },
    );

    expect(seen).toEqual(['green']);
    expect(result.stdout).toBe('green');
  });

  it('strips a carriage return from CRLF output', async () => {
    const result = await runCommand(node('process.stdout.write("a\\r\\nb\\r\\n")'), {
      cwd: CWD,
    });

    expect(result.stdout).toBe('a\nb');
  });

  it('kills a command that exceeds its timeout and says so', async () => {
    const error = await runCommand(node('setTimeout(()=>{}, 60000)'), {
      cwd: CWD,
      timeoutMs: 50,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CommandFailedError);
    const failure = error as CommandFailedError;
    expect(failure.result.timedOut).toBe(true);
    expect(failure.message).toContain('timed out');
  });

  it('aborts when the caller signals, as the TUI does on unmount', async () => {
    const controller = new AbortController();
    const pending = runCommand(node('setTimeout(()=>{}, 60000)'), {
      cwd: CWD,
      signal: controller.signal,
    }).catch((caught: unknown) => caught);

    controller.abort();
    const error = await pending;

    expect(error).toBeInstanceOf(CommandFailedError);
  });

  it('reports a missing program as "command not found"', async () => {
    const error = await runCommand(['definitely-not-a-real-binary-xyz'], {
      cwd: CWD,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CommandFailedError);
    // "spawn ... ENOENT" is the single most common first-install failure and
    // must not be what the operator is shown.
    expect((error as Error).message).toContain('command not found');
  });

  it('applies the redactor to the message, stdout and stderr', async () => {
    const secret = 'hunter2-hunter2';
    const error = await runCommand(
      node(`process.stderr.write("connect ${secret}\\n");process.exit(1)`),
      {
        cwd: CWD,
        redact: (value) => value.split(secret).join('***'),
      },
    ).catch((caught: unknown) => caught);

    const failure = error as CommandFailedError;
    expect(failure.message).not.toContain(secret);
    expect(failure.result.stderr).not.toContain(secret);
    expect(failure.message).toContain('***');
  });

  it('passes a replacement environment through to the child', async () => {
    const result = await runCommand(
      node('process.stdout.write(String(process.env.DEPLOY_PROBE))'),
      { cwd: CWD, env: { ...process.env, DEPLOY_PROBE: 'set' } },
    );

    expect(result.stdout).toBe('set');
  });

  it('runs in the requested working directory', async () => {
    const result = await runCommand(node('process.stdout.write(process.cwd())'), {
      cwd: CWD,
    });

    expect(result.stdout).toBe(CWD);
  });

  it('does not interpret its arguments as a shell command', async () => {
    // With `shell: true` this would run `echo` and then `touch`. Without it,
    // the whole string is one argument to node, which prints it back.
    const payload = 'safe; touch /tmp/appctl-should-not-exist';
    const result = await runCommand(
      [NODE, '-e', 'process.stdout.write(process.argv[1])', payload],
      { cwd: CWD },
    );

    expect(result.stdout).toBe(payload);
  });

  it('rejects an empty argv rather than spawning something ambiguous', async () => {
    await expect(runCommand([], { cwd: CWD })).rejects.toBeInstanceOf(TypeError);
  });
});

describe('describeFailure', () => {
  const base = {
    argv: ['git', 'clone', 'url'],
    cwd: '/srv',
    exitCode: 128,
    stdout: '',
    stderr: '',
    durationMs: 12,
    timedOut: false,
  };

  it('names the command and the exit code', () => {
    expect(describeFailure(base, [])).toBe('`git clone url` exited 128');
  });

  it('quotes the stderr tail, indented', () => {
    expect(describeFailure(base, ['fatal: repository not found'])).toBe(
      '`git clone url` exited 128\n    fatal: repository not found',
    );
  });

  it('drops blank lines from the tail', () => {
    expect(describeFailure(base, ['', '   ', 'real'])).toBe(
      '`git clone url` exited 128\n    real',
    );
  });

  it('reports a timeout as a timeout, not as an exit code', () => {
    expect(describeFailure({ ...base, timedOut: true }, [])).toContain(
      'timed out after 12ms',
    );
  });
});
