import { render } from 'ink';

import { EXIT, exitCodeFor, formatError } from '../errors.js';
import { App } from './app.js';
import { installTerminalRestore, restoreTerminal } from './terminal.js';

// =============================================================================
// Mounting the TUI  (issue #145, epic #110)
// =============================================================================
//
// THE ONLY MODULE IN THIS PACKAGE THAT CALLS `render`, and the only one whose
// import pulls in ink, React and the reconciler. `program.ts` reaches it through
// a dynamic `await import()` that runs ONLY after `evaluateTuiGate` has said
// yes, which is why that gate lives in a react-free module. The arrangement
// means a piped or CI invocation — and every explicit subcommand, TTY or not —
// never loads yoga's WASM or a reconciler at all: it is both the startup-latency
// argument and the containment argument for the failure tty.ts describes.
//
// This file is `.tsx` purely so the extension is consistent with the rest of
// `src/tui/`; it contains no JSX of its own beyond mounting `<App />`.
// =============================================================================

export interface StartTuiOptions {
  stdout?: NodeJS.WriteStream | undefined;
  stdin?: NodeJS.ReadStream | undefined;
}

/**
 * Mount the app and resolve with the process exit code once it unmounts.
 *
 * RESOLVES WITH A CODE RATHER THAN CALLING `process.exit`, matching every other
 * entry point in this package (see the header of cli.ts): `process.exit`
 * terminates without draining pending writes, and the final frame ink writes on
 * teardown would be truncated. Returning the code lets the event loop empty on
 * its own, which is also what flushes the cursor-restore sequence.
 *
 * A NORMAL EXIT IS 0 EVEN AFTER A FAILED LOGIN OR A 403. That is deliberate and
 * it is the opposite of the rule for subcommands: an exit code exists so a
 * SCRIPT can branch, and nothing scripts this — it only runs with no arguments
 * on a terminal, with a human who has already read the error on screen. The
 * non-zero codes here are for failures of the UI itself.
 */
export async function startTui(options?: StartTuiOptions): Promise<number> {
  const stdout = options?.stdout ?? process.stdout;
  const stdin = options?.stdin ?? process.stdin;

  // Installed BEFORE the first frame, removed in the `finally`. Between those
  // two points the process may die in ways ink cannot see — a SIGTERM from
  // another terminal, a SIGHUP when the window closes, a throw in our own async
  // code — and each of those would otherwise leave the cursor hidden and stdin
  // in raw mode for the shell the user returns to. See terminal.ts.
  const uninstallRestore = installTerminalRestore({ stdout, stdin });

  try {
    const instance = render(<App />, {
      stdout,
      stdin,
      // ON, and this is the Ctrl-C requirement from #145. With it, ink reads the
      // ^C byte itself (in raw mode the terminal does not generate SIGINT, so
      // nothing else would) and performs a real React unmount: every screen's
      // effect cleanups run, which is what aborts an in-flight device-login poll
      // loop. Without that, Ctrl-C would clear the UI and leave the process
      // alive on a pending `setTimeout` — a shell prompt that never returns.
      exitOnCtrlC: true,
      // ink's default. Named explicitly because it is load-bearing here: a
      // stray `console.log` from anywhere in the dependency tree would otherwise
      // be written straight into the middle of a frame ink is managing,
      // corrupting the layout until the next full redraw.
      patchConsole: true,
    });

    await instance.waitUntilExit();
    return EXIT.OK;
  } catch (error) {
    // `waitUntilExit()` rejects when the app is torn down with an error — a
    // throw during render, or `exit(error)`. The UI is gone by this point, so
    // the message has to go to stderr the way every other failure in this CLI
    // does, and it must be written AFTER the restore below so it is not printed
    // into a frame that is still being cleared.
    restoreTerminal({ stdout, stdin });
    process.stderr.write(`${formatError(error)}\n`);
    return exitCodeFor(error);
  } finally {
    // Belt and braces on the clean path too: ink restores the terminal on
    // unmount, and doing it again is a no-op by design (`restoreTerminal` is
    // idempotent). The listener removal is NOT optional — leaving a SIGINT
    // handler installed would keep suppressing node's default disposition for
    // the rest of the process's life.
    restoreTerminal({ stdout, stdin });
    uninstallRestore();
  }
}

export { evaluateTuiGate, NO_TUI_ENV_VAR } from './tty.js';
export type { TtyContext, TuiGateDecision, TuiRefusal } from './tty.js';
