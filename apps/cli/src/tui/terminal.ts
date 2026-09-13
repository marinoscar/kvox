// =============================================================================
// Leaving the terminal usable  (issue #145, epic #110)
// =============================================================================
//
// A TUI borrows two pieces of global, PROCESS-OUTLIVING state from the user's
// terminal, and if it dies without giving them back the damage lands on the
// shell the user returns to — not on this process, which is already gone:
//
//   1. THE CURSOR IS HIDDEN. ink hides it while it draws, because a cursor
//      parked wherever the last write ended flickers across the frame on every
//      redraw. Left hidden, the user's next shell prompt has no visible cursor
//      at all. Typing works; nothing shows where. It survives every subsequent
//      command and is fixed only by `reset` or `tput cnorm`, which is knowledge
//      the person staring at the invisible cursor does not have.
//
//   2. STDIN IS IN RAW MODE. This is the serious one. Raw mode turns off line
//      buffering, local echo AND the terminal's own signal generation. A shell
//      inheriting a raw stdin does not echo what is typed and DOES NOT RESPOND
//      TO CTRL-C, because in raw mode the terminal no longer converts ^C into
//      SIGINT — it just hands the byte to whoever is reading, and nobody is.
//      The terminal looks hung. It is a `reset` away from working and looks
//      like a crashed machine.
//
// ink restores both on a clean unmount, and registers `signal-exit` to cover
// most of the rest. This module is the BELT-AND-BRACES layer under that, for
// the paths ink cannot see: a throw in our own async code between mounting and
// ink's own teardown, a SIGTERM from another terminal, a SIGHUP when the
// terminal window is closed.
//
// The restore itself is deliberately IDEMPOTENT and SYNCHRONOUS. Idempotent
// because ink will also do it and double-restoring must be harmless;
// synchronous because a `process.on('exit')` handler is the last code that
// runs and an async write there is simply dropped.
// =============================================================================

/**
 * DECTCEM show-cursor. Written as an escape literal rather than pulled from
 * `ansi-escapes` (an ink dependency, not one of ours) so this file has no
 * imports at all and can therefore run from an `exit` handler with no risk of
 * touching a half-initialised module graph.
 */
const SHOW_CURSOR = '\u001B[?25h';

/**
 * Signals that terminate the process WITHOUT running `exit` handlers.
 *
 * That is the whole reason they are listened for. Node's default disposition
 * for a signal is to die immediately; `process.on('exit')` never fires, so the
 * cursor stays hidden and stdin stays raw. Handling them lets us restore and
 * then exit with the conventional 128+n code, which preserves "this process
 * was killed by a signal" for any wrapping script.
 *
 * SIGINT IS ON THIS LIST, and it needs the caveat: adding a listener for it
 * SUPPRESSES NODE'S DEFAULT, so a handler that forgot to exit would make Ctrl-C
 * do nothing — a worse bug than the one being fixed. The handler below always
 * exits, so the observable behaviour is unchanged (the process still dies on
 * Ctrl-C, with the same code a shell reports) and the terminal is restored on
 * the way out. In practice this listener rarely fires at all: while ink holds
 * stdin in raw mode the terminal does not generate SIGINT, and ink reads the
 * literal ^C byte instead. It exists for the window after unmount and before
 * the process actually ends.
 */
const FATAL_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

type FatalSignal = (typeof FATAL_SIGNALS)[number];

const SIGNAL_NUMBERS: Record<FatalSignal, number> = {
  SIGINT: 2,
  SIGTERM: 15,
  SIGHUP: 1,
};

export interface TerminalRestoreContext {
  stdout?: NodeJS.WriteStream | undefined;
  stdin?: NodeJS.ReadStream | undefined;
  /** Injected so a test can assert the handlers without killing its own runner. */
  process?: NodeJS.Process | undefined;
}

/**
 * Register the safety net. Returns the function that removes it.
 *
 * THE DISPOSER IS NOT OPTIONAL HOUSEKEEPING. Node warns (and then leaks) past
 * ten listeners on an emitter, and `process` is a single long-lived emitter
 * shared with everything else in the runtime. More importantly, leaving a
 * SIGINT listener installed after the TUI has exited would keep suppressing
 * node's default disposition for the rest of the process's life — so a Ctrl-C
 * during whatever runs next would be handled by dead UI code.
 */
export function installTerminalRestore(ctx?: TerminalRestoreContext): () => void {
  const proc = ctx?.process ?? process;
  const stdout = ctx?.stdout ?? proc.stdout;
  const stdin = ctx?.stdin ?? proc.stdin;

  const restore = (): void => {
    restoreTerminal({ stdout, stdin });
  };

  const signalHandlers = new Map<FatalSignal, () => void>();

  for (const signal of FATAL_SIGNALS) {
    const handler = (): void => {
      restore();
      // 128+n is the convention every shell reports for "killed by signal n",
      // and scripts branch on it. Re-raising the signal after removing the
      // handler would be more faithful still, but it races with the exit we
      // are already committed to; the code is what callers actually observe.
      proc.exit(128 + SIGNAL_NUMBERS[signal]);
    };
    signalHandlers.set(signal, handler);
    proc.on(signal, handler);
  }

  // Covers the ordinary paths: a returned exit code, an explicit
  // `process.exit()`, and an uncaught exception (node runs `exit` handlers
  // after printing the stack). Synchronous by necessity — see the header.
  proc.on('exit', restore);

  return () => {
    proc.removeListener('exit', restore);
    for (const [signal, handler] of signalHandlers) {
      proc.removeListener(signal, handler);
    }
  };
}

/**
 * Put the cursor back and take stdin out of raw mode. Safe to call any number
 * of times, and safe to call when neither was ever changed.
 *
 * Every step is wrapped, because this runs on the failure path by definition:
 * the stream may already be destroyed (a closed terminal, a killed parent), and
 * a throw from here would replace the error the user actually needs to see with
 * an EPIPE from the cleanup.
 */
export function restoreTerminal(ctx?: {
  stdout?: NodeJS.WriteStream | undefined;
  stdin?: NodeJS.ReadStream | undefined;
}): void {
  const stdout = ctx?.stdout ?? process.stdout;
  const stdin = ctx?.stdin ?? process.stdin;

  try {
    // Only on a real terminal. The sequence is meaningless in a file and would
    // be five stray bytes at the end of any redirected output — the gate in
    // tty.ts should have prevented us getting here at all, but this function is
    // the last line of defence and must not itself corrupt a stream.
    if (stdout.isTTY === true) stdout.write(SHOW_CURSOR);
  } catch {
    // The terminal is gone. Nothing left to restore it for.
  }

  try {
    // `setRawMode` exists ONLY on a TTY stdin, hence the guard rather than an
    // optional call: on a pipe the property is absent and `stdin.setRawMode` is
    // undefined, which would throw.
    if (stdin.isTTY === true) stdin.setRawMode(false);
  } catch {
    // Same.
  }
}
