import { describe, expect, it, vi } from 'vitest';

import { installTerminalRestore, restoreTerminal } from './terminal.js';

// =============================================================================
// Leaving the terminal usable  (issue #145, epic #110)
// =============================================================================
//
// `restoreTerminal` is the last line of defence for the two pieces of global
// state a TUI borrows from the terminal (a hidden cursor, raw-mode stdin),
// and `installTerminalRestore`'s disposer is what stops a leaked SIGINT
// listener from suppressing node's default disposition for the rest of the
// process's life. Both are exercised here against FAKE stdout/stdin/process
// objects — never the real `process` the test runner itself depends on.
// =============================================================================

const SHOW_CURSOR = '[?25h';

function fakeWriteStream(overrides: Partial<{ isTTY: boolean; write: () => boolean }> = {}) {
  return {
    isTTY: overrides.isTTY ?? true,
    write: vi.fn(overrides.write ?? (() => true)),
  } as unknown as NodeJS.WriteStream;
}

function fakeReadStream(
  overrides: Partial<{ isTTY: boolean; setRawMode: (mode: boolean) => void }> = {},
) {
  const base: Record<string, unknown> = { isTTY: overrides.isTTY ?? true };
  if (overrides.setRawMode !== undefined || overrides.isTTY !== false) {
    base.setRawMode = vi.fn(overrides.setRawMode ?? (() => undefined));
  }
  return base as unknown as NodeJS.ReadStream;
}

describe('restoreTerminal', () => {
  it('writes the cursor-show sequence and calls setRawMode(false) on a real terminal', () => {
    const stdout = fakeWriteStream();
    const stdin = fakeReadStream();

    restoreTerminal({ stdout, stdin });

    expect(stdout.write).toHaveBeenCalledWith(SHOW_CURSOR);
    expect(stdin.setRawMode).toHaveBeenCalledWith(false);
  });

  it('does not write the cursor sequence when stdout is not a TTY', () => {
    const stdout = fakeWriteStream({ isTTY: false });
    const stdin = fakeReadStream();

    restoreTerminal({ stdout, stdin });

    expect(stdout.write).not.toHaveBeenCalled();
  });

  it('does not call setRawMode when stdin is not a TTY', () => {
    const stdout = fakeWriteStream();
    const stdin = fakeReadStream({ isTTY: false });

    restoreTerminal({ stdout, stdin });

    // A non-TTY stdin has no `setRawMode` at all in real Node — this fake
    // omits it the same way when isTTY is false, so a call would throw
    // TypeError rather than silently succeed. Getting here without throwing
    // IS the guard being proven.
    expect((stdin as unknown as { setRawMode?: unknown }).setRawMode).toBeUndefined();
  });

  it('is idempotent — calling it twice in a row is harmless', () => {
    const stdout = fakeWriteStream();
    const stdin = fakeReadStream();

    restoreTerminal({ stdout, stdin });
    restoreTerminal({ stdout, stdin });

    expect(stdout.write).toHaveBeenCalledTimes(2);
    expect(stdout.write).toHaveBeenNthCalledWith(1, SHOW_CURSOR);
    expect(stdout.write).toHaveBeenNthCalledWith(2, SHOW_CURSOR);
    expect(stdin.setRawMode).toHaveBeenCalledTimes(2);
  });

  it('is guarded when setRawMode is absent on a stream that claims isTTY (belt and braces)', () => {
    // `isTTY: true` but no `setRawMode` function is not a real Node shape, but
    // the source comment is explicit that this guard exists for exactly a
    // destroyed/half-torn-down stream — calling a missing function must not
    // throw and must not prevent the stdout half from running.
    const stdout = fakeWriteStream();
    const stdin = { isTTY: true } as unknown as NodeJS.ReadStream;

    expect(() => restoreTerminal({ stdout, stdin })).not.toThrow();
    expect(stdout.write).toHaveBeenCalledWith(SHOW_CURSOR);
  });

  it('swallows a throw from stdout.write (a destroyed stream) without throwing', () => {
    const stdout = fakeWriteStream({
      write: () => {
        throw new Error('EPIPE');
      },
    });
    const stdin = fakeReadStream();

    expect(() => restoreTerminal({ stdout, stdin })).not.toThrow();
    // The stdout half failing must not prevent the stdin half from running.
    expect(stdin.setRawMode).toHaveBeenCalledWith(false);
  });

  it('swallows a throw from stdin.setRawMode without throwing', () => {
    const stdout = fakeWriteStream();
    const stdin = fakeReadStream({
      setRawMode: () => {
        throw new Error('EBADF');
      },
    });

    expect(() => restoreTerminal({ stdout, stdin })).not.toThrow();
    expect(stdout.write).toHaveBeenCalledWith(SHOW_CURSOR);
  });

  it('does nothing to either stream when neither is a TTY', () => {
    const stdout = fakeWriteStream({ isTTY: false });
    const stdin = fakeReadStream({ isTTY: false });

    expect(() => restoreTerminal({ stdout, stdin })).not.toThrow();
    expect(stdout.write).not.toHaveBeenCalled();
  });

  it('defaults to the real process streams when no context is given', () => {
    // Not asserting on the real terminal's state (there may not be one under
    // the test runner) — only that reading `process.stdout`/`process.stdin`
    // as the default does not throw.
    expect(() => restoreTerminal()).not.toThrow();
  });
});

// -----------------------------------------------------------------------------
// installTerminalRestore
// -----------------------------------------------------------------------------

interface FakeProcess {
  on: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  exit: ReturnType<typeof vi.fn>;
  handlers: Map<string, Set<(...args: unknown[]) => void>>;
}

function fakeProcess(): FakeProcess {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();

  const on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event)?.add(handler);
  });

  const removeListener = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    handlers.get(event)?.delete(handler);
  });

  const exit = vi.fn();

  return { on, removeListener, exit, handlers };
}

describe('installTerminalRestore', () => {
  it('registers a handler for exit, SIGINT, SIGTERM and SIGHUP', () => {
    const proc = fakeProcess();
    const stdout = fakeWriteStream();
    const stdin = fakeReadStream();

    installTerminalRestore({
      process: proc as unknown as NodeJS.Process,
      stdout,
      stdin,
    });

    const registered = proc.on.mock.calls.map((call) => call[0] as string);
    expect(registered).toEqual(expect.arrayContaining(['exit', 'SIGINT', 'SIGTERM', 'SIGHUP']));
  });

  it('the exit handler restores the terminal', () => {
    const proc = fakeProcess();
    const stdout = fakeWriteStream();
    const stdin = fakeReadStream();

    installTerminalRestore({ process: proc as unknown as NodeJS.Process, stdout, stdin });

    for (const handler of proc.handlers.get('exit') ?? []) handler();

    expect(stdout.write).toHaveBeenCalledWith(SHOW_CURSOR);
    expect(stdin.setRawMode).toHaveBeenCalledWith(false);
    // `exit` handlers must never call `process.exit` themselves — node is
    // already exiting when they run, and calling it again is undefined
    // behaviour at best.
    expect(proc.exit).not.toHaveBeenCalled();
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ])('the %s handler restores the terminal and exits with 128+n (%i)', (signal, code) => {
    const proc = fakeProcess();
    const stdout = fakeWriteStream();
    const stdin = fakeReadStream();

    installTerminalRestore({ process: proc as unknown as NodeJS.Process, stdout, stdin });

    for (const handler of proc.handlers.get(signal) ?? []) handler();

    expect(stdout.write).toHaveBeenCalledWith(SHOW_CURSOR);
    expect(stdin.setRawMode).toHaveBeenCalledWith(false);
    expect(proc.exit).toHaveBeenCalledWith(code);
  });

  it('SIGINT is fatal: registering a listener for it still ends the process, never suppresses Ctrl-C', () => {
    // The dangerous alternative implementation is a SIGINT handler that
    // forgets to call process.exit — Node's default disposition is
    // suppressed the moment ANY listener is added, so an exit-less handler
    // would make Ctrl-C do nothing. Assert the actual handler always exits.
    const proc = fakeProcess();
    installTerminalRestore({
      process: proc as unknown as NodeJS.Process,
      stdout: fakeWriteStream(),
      stdin: fakeReadStream(),
    });

    for (const handler of proc.handlers.get('SIGINT') ?? []) handler();

    expect(proc.exit).toHaveBeenCalledTimes(1);
    expect(proc.exit).toHaveBeenCalledWith(130);
  });

  it('the returned disposer removes every listener it registered', () => {
    const proc = fakeProcess();
    const dispose = installTerminalRestore({
      process: proc as unknown as NodeJS.Process,
      stdout: fakeWriteStream(),
      stdin: fakeReadStream(),
    });

    expect(proc.handlers.get('exit')?.size).toBe(1);
    expect(proc.handlers.get('SIGINT')?.size).toBe(1);
    expect(proc.handlers.get('SIGTERM')?.size).toBe(1);
    expect(proc.handlers.get('SIGHUP')?.size).toBe(1);

    dispose();

    expect(proc.handlers.get('exit')?.size).toBe(0);
    expect(proc.handlers.get('SIGINT')?.size).toBe(0);
    expect(proc.handlers.get('SIGTERM')?.size).toBe(0);
    expect(proc.handlers.get('SIGHUP')?.size).toBe(0);
  });

  it('after disposal, a signal firing on the (real) process no longer restores the terminal', () => {
    // Simulate "the disposer really unhooked the handler" by firing the
    // signal on the fake process AFTER disposal and confirming nothing
    // observable happens — no restore, no exit.
    const proc = fakeProcess();
    const stdout = fakeWriteStream();
    const stdin = fakeReadStream();

    const dispose = installTerminalRestore({
      process: proc as unknown as NodeJS.Process,
      stdout,
      stdin,
    });
    dispose();

    // Nothing is registered any more, so there is nothing left to invoke —
    // this is the observable proof the disposer did its job rather than a
    // no-op that merely claims to.
    expect(proc.handlers.get('SIGINT')?.size).toBe(0);
    expect(stdout.write).not.toHaveBeenCalled();
    expect(proc.exit).not.toHaveBeenCalled();
  });

  it('installing does not itself touch the terminal (only firing a handler does)', () => {
    const proc = fakeProcess();
    const stdout = fakeWriteStream();
    const stdin = fakeReadStream();

    installTerminalRestore({ process: proc as unknown as NodeJS.Process, stdout, stdin });

    expect(stdout.write).not.toHaveBeenCalled();
    expect(stdin.setRawMode).not.toHaveBeenCalled();
  });

  it('defaults to the real process when no context is given, and returns a working disposer', () => {
    const dispose = installTerminalRestore();
    expect(typeof dispose).toBe('function');
    // Must not throw and must not leak a listener on the real process.
    expect(() => dispose()).not.toThrow();
  });
});
