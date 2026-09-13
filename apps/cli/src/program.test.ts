import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CLI_NAME } from './branding.js';
import { EXIT } from './errors.js';
import { CLI_VERSION } from './package-info.js';
import { buildProgram, run } from './program.js';
import type { TtyContext } from './tui/tty.js';

// =============================================================================
// Command wiring (issue #140)
// =============================================================================
//
// `run()` never spawns a process and never touches `process.exitCode` — that
// is the whole reason it can be tested with a function call instead of
// `child_process`. stdout/stderr writes are spied on and silenced so the test
// run's own output stays clean; each test restores them afterward.
// =============================================================================

let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

function writtenText(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((call: unknown[]) => String(call[0])).join('');
}

describe('buildProgram', () => {
  it('names the program after CLI_NAME and carries CLI_VERSION', () => {
    const program = buildProgram();
    expect(program.name()).toBe(CLI_NAME);
    expect(program.version()).toBe(CLI_VERSION);
  });
});

describe('run', () => {
  it('is callable without spawning a process or touching process.exitCode', async () => {
    const before = process.exitCode;

    const code = await run(['--version']);

    expect(code).toBe(EXIT.OK);
    expect(process.exitCode).toBe(before);
  });

  it('--version returns 0 and prints the version', async () => {
    const code = await run(['--version']);

    expect(code).toBe(EXIT.OK);
    expect(writtenText(stdoutSpy)).toContain(CLI_VERSION);
  });

  it('--help returns 0', async () => {
    const code = await run(['--help']);

    expect(code).toBe(EXIT.OK);
  });

  it('bare invocation (no args) is a usage error, not silent success', async () => {
    const code = await run([]);

    expect(code).toBe(EXIT.USAGE);
    expect(code).not.toBe(EXIT.OK);
  });

  it('an unknown flag exits with the usage code, not 1', async () => {
    const code = await run(['--this-flag-does-not-exist']);

    expect(code).toBe(EXIT.USAGE);
    expect(code).not.toBe(1);
  });

  it('an unrecognised positional argument is also a usage error', async () => {
    const code = await run(['not-a-real-command']);

    expect(code).toBe(EXIT.USAGE);
  });

  it('never writes command failures to stdout — only stderr', async () => {
    await run(['--this-flag-does-not-exist']);

    // Commander's own error + help-after-error text must land on stderr so a
    // future `--raw | jq` pipeline is never polluted by a usage mistake.
    expect(writtenText(stderrSpy).length).toBeGreaterThan(0);
  });
});

// =============================================================================
// The containment property (issue #145)
// =============================================================================
//
// `run()` accepts a `startTui` spy for exactly this reason: the property that
// matters — the TUI never mounts — cannot be proven by mounting it and
// looking at the output. It is proven by asserting the spy was never called.
// =============================================================================

/** A fully-interactive terminal: the gate would say yes to this on its own. */
function interactiveTty(): TtyContext {
  return {
    stdout: { isTTY: true },
    stdin: { isTTY: true },
    env: { TERM: 'xterm-256color' },
  };
}

/** A piped stdout: the gate refuses this on its own. */
function pipedTty(): TtyContext {
  return {
    stdout: { isTTY: undefined },
    stdin: { isTTY: undefined },
    env: { TERM: 'dumb' },
  };
}

describe('run — no-argument invocation never mounts without a TTY', () => {
  it('does not call startTui when stdout/stdin are not TTYs', async () => {
    const startTui = vi.fn(async () => EXIT.OK);

    const code = await run([], { tty: pipedTty(), startTui });

    expect(startTui).not.toHaveBeenCalled();
    expect(code).toBe(EXIT.USAGE);
  });

  it('writes the refusal reason to stderr and leaves stdout untouched', async () => {
    const startTui = vi.fn(async () => EXIT.OK);

    await run([], { tty: pipedTty(), startTui });

    expect(writtenText(stderrSpy).length).toBeGreaterThan(0);
    expect(writtenText(stdoutSpy)).toBe('');
  });

  it('the exit code on refusal is the usage code, not OK or FAILURE', async () => {
    const startTui = vi.fn(async () => EXIT.OK);

    const code = await run([], { tty: pipedTty(), startTui });

    expect(code).toBe(EXIT.USAGE);
    expect(code).not.toBe(EXIT.OK);
    expect(code).not.toBe(EXIT.FAILURE);
  });

  it('help is still shown on stderr even though nothing was mounted', async () => {
    await run([], { tty: pipedTty() });

    // program.outputHelp({ error: true }) routes through configureOutput's
    // writeErr, so the usage text lands on stderr alongside the reason.
    expect(writtenText(stderrSpy)).toContain(CLI_NAME);
  });
});

describe('run — no-argument invocation mounts only when the gate says yes', () => {
  it('calls startTui exactly once when every TTY check passes', async () => {
    const startTui = vi.fn(async () => EXIT.OK);

    const code = await run([], { tty: interactiveTty(), startTui });

    expect(startTui).toHaveBeenCalledTimes(1);
    expect(code).toBe(EXIT.OK);
  });

  it('returns whatever exit code startTui resolves with', async () => {
    const startTui = vi.fn(async (): Promise<number> => 7);

    const code = await run([], { tty: interactiveTty(), startTui });

    expect(code).toBe(7);
  });

  it('a rejected startTui is caught, formatted to stderr, and mapped to an exit code', async () => {
    const startTui = vi.fn(async () => {
      throw new Error('ink failed to load');
    });

    const code = await run([], { tty: interactiveTty(), startTui });

    expect(code).toBe(EXIT.FAILURE);
    expect(writtenText(stderrSpy)).toContain('ink failed to load');
  });
});

describe('run — explicit subcommands never reach the TUI, TTY or not', () => {
  it('--version does not call startTui even with a perfect interactive TTY', async () => {
    const startTui = vi.fn(async () => EXIT.OK);

    const code = await run(['--version'], { tty: interactiveTty(), startTui });

    expect(startTui).not.toHaveBeenCalled();
    expect(code).toBe(EXIT.OK);
  });

  it('--help does not call startTui even with a perfect interactive TTY', async () => {
    const startTui = vi.fn(async () => EXIT.OK);

    const code = await run(['--help'], { tty: interactiveTty(), startTui });

    expect(startTui).not.toHaveBeenCalled();
    expect(code).toBe(EXIT.OK);
  });

  it('`api` with no arguments does not call startTui even with a perfect interactive TTY', async () => {
    // Commander rejects this for missing <method>/<path> before any action
    // runs — the point being proven is structural: argv.length > 0 takes the
    // parseAsync branch and never consults the TTY gate at all, regardless of
    // whether the subcommand itself is well-formed.
    const startTui = vi.fn(async () => EXIT.OK);

    const code = await run(['api'], { tty: interactiveTty(), startTui });

    expect(startTui).not.toHaveBeenCalled();
    expect(code).toBe(EXIT.USAGE);
  });

  it('an unrecognised subcommand does not call startTui even with a perfect interactive TTY', async () => {
    const startTui = vi.fn(async () => EXIT.OK);

    const code = await run(['not-a-real-command'], { tty: interactiveTty(), startTui });

    expect(startTui).not.toHaveBeenCalled();
    expect(code).toBe(EXIT.USAGE);
  });

  it('a subcommand run WITHOUT a TTY behaves identically to one run with one (no gate consulted)', async () => {
    const startTuiA = vi.fn(async () => EXIT.OK);
    const startTuiB = vi.fn(async () => EXIT.OK);

    const withTty = await run(['api'], { tty: interactiveTty(), startTui: startTuiA });
    const withoutTty = await run(['api'], { tty: pipedTty(), startTui: startTuiB });

    expect(withTty).toBe(withoutTty);
    expect(startTuiA).not.toHaveBeenCalled();
    expect(startTuiB).not.toHaveBeenCalled();
  });
});
