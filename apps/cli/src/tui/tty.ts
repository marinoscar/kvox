import { CLI_NAME, envVar } from '../branding.js';

// =============================================================================
// The TTY gate  (issue #145, epic #110 success criterion 7)
// =============================================================================
//
// THIS IS THE MOST IMPORTANT FILE IN THE TUI, and it contains no UI at all.
//
// A full-screen renderer is a program that writes cursor-movement escape
// sequences and reads keystrokes. Both halves fail catastrophically and
// SILENTLY when the other end is not a terminal:
//
//   - WRITING. ink redraws its whole frame on every state change. Into a
//     terminal that is a repaint; into a pipe or a CI log file it is the entire
//     frame appended AGAIN, escape sequences and all, several times a second
//     for as long as the app runs. A device-flow login polls for up to fifteen
//     minutes. The result is a multi-megabyte log of ESC-bracket noise wrapped
//     around output nobody can read, and some log viewers refuse to render it
//     at all.
//
//   - READING. The menu waits for a keypress. A non-TTY stdin never produces
//     one, so the app waits forever: the CI job hangs until the runner's own
//     timeout kills it, tens of minutes later, with a log that says nothing
//     about why. That is the single worst failure mode a CLI can have, because
//     the symptom (a timeout) points nowhere near the cause.
//
// Neither failure raises an error. Neither is visible in a passing local test.
// Both are certain the first time somebody runs the bare command from a script.
// So the gate is a hard precondition evaluated BEFORE anything is rendered, and
// it is deliberately kept in a module that imports NEITHER react NOR ink — see
// `program.ts`, which consults it and only then `await import()`s the renderer.
// A top-level ink import here would drag the reconciler, yoga (a WASM module)
// and two dozen transitive packages into the startup path of every
// `appctl api GET ...` in every pipeline, which is both slow and exactly the
// coupling this gate exists to prevent.
//
// -----------------------------------------------------------------------------
// WHY THE GATE IS ON "NO ARGUMENTS", NOT ON A `--tui` FLAG OR A MODE
// -----------------------------------------------------------------------------
// The TUI is the no-argument experience and nothing else. `appctl api GET
// /api/auth/me` must behave identically whether it runs in a terminal, in a
// cron job, or under `set -e` in a pipeline — so an explicit subcommand NEVER
// consults this file, TTY or not. The check lives at the one branch in `run()`
// where argv is empty, which is the only invocation that has no scripted
// meaning to capture.
// =============================================================================

/** `APPCTL_NO_TUI` — an escape hatch for a terminal we wrongly believe is one. */
export const NO_TUI_ENV_VAR = envVar('NO_TUI');

/** The one property this gate needs from a stream. Structural, so a test can fake it. */
interface TtyLike {
  isTTY?: boolean | undefined;
}

/**
 * Injection seam, matching `ConfigContext` in config.ts.
 *
 * Every field defaults to the real process. A test that had to mutate
 * `process.stdout.isTTY` to exercise this would be mutating a global that the
 * test runner itself reads, and the failure would depend on file execution
 * order.
 */
export interface TtyContext {
  stdout?: TtyLike | undefined;
  stdin?: TtyLike | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

/** Why the TUI was refused. Distinct values so a test asserts the cause, not the prose. */
export type TuiRefusal =
  | 'disabled'
  | 'stdout-not-a-tty'
  | 'stdin-not-a-tty'
  | 'dumb-terminal'
  | 'ci';

export type TuiGateDecision =
  | { engage: true }
  | {
      engage: false;
      refusal: TuiRefusal;
      /** One sentence naming the cause AND the thing to do instead. */
      reason: string;
    };

/**
 * Decide whether a full-screen UI may be mounted.
 *
 * FIVE CHECKS, ORDERED BY HOW SPECIFIC THE RESULTING ADVICE IS — the first one
 * that fires produces the message, so the most actionable diagnosis must come
 * first. "You set APPCTL_NO_TUI" is a better answer than "stdout is not a
 * terminal" even when both are true.
 */
export function evaluateTuiGate(ctx?: TtyContext): TuiGateDecision {
  const env = ctx?.env ?? process.env;
  const stdout = ctx?.stdout ?? process.stdout;
  const stdin = ctx?.stdin ?? process.stdin;

  // 1. The user said no. Honoured unconditionally and reported plainly, so
  //    "why do I get usage instead of the menu?" has a one-line answer instead
  //    of sending somebody to check their terminal emulator.
  if (isEnvFlagSet(env[NO_TUI_ENV_VAR])) {
    return refuse(
      'disabled',
      `${NO_TUI_ENV_VAR} is set, so the interactive interface is disabled. Run a subcommand, or unset it.`,
    );
  }

  // 2. WHERE THE FRAME WOULD GO. `isTTY` is `undefined` — not `false` — on a
  //    pipe, which is why every comparison in this file is `!== true` rather
  //    than `=== false`. A `=== false` test would pass on a pipe and mount the
  //    TUI into it, which is the exact failure this module exists to prevent.
  if (stdout.isTTY !== true) {
    return refuse(
      'stdout-not-a-tty',
      `stdout is not a terminal, so the interactive interface was not started (it would write escape sequences into your log). Run \`${CLI_NAME} --help\` to see the commands.`,
    );
  }

  // 3. WHERE THE KEYSTROKES WOULD COME FROM. Checked SEPARATELY from stdout
  //    because the two are independently redirectable and the interesting case
  //    is real: `echo | appctl` and `appctl < /dev/null` both leave stdout a
  //    terminal while stdin is not. ink cannot put a non-TTY stdin into raw
  //    mode (`setRawMode` does not exist on it), so it would draw a menu that
  //    can never be answered and never exited — a hang in front of a user who
  //    can SEE the UI, which is worse than not drawing it.
  if (stdin.isTTY !== true) {
    return refuse(
      'stdin-not-a-tty',
      `stdin is not a terminal, so there is no way to answer the interactive interface. Run \`${CLI_NAME} --help\` to see the commands.`,
    );
  }

  // 4. `TERM=dumb` is a terminal that has TOLD US it cannot do cursor
  //    addressing — Emacs' shell-mode, some editors' embedded terminals, a few
  //    CI shells. It IS a TTY, so checks 2 and 3 pass, and every redraw would
  //    append instead of overwriting: the same unbounded-scrollback failure as
  //    a pipe, on a device that reports itself as interactive.
  //
  //    An ABSENT or EMPTY TERM is treated the same way, and absent is the case
  //    that actually occurs: `env.TERM` is `undefined` when nothing exported
  //    it, so this must test falsiness, NOT `=== ''`. (`undefined === ''` is
  //    false — an earlier version of this check compared against the empty
  //    string alone and let every no-TERM process straight through.) Some
  //    service managers and minimal init systems hand a process two real
  //    pseudo-terminals and no TERM at all; with no terminfo resolved there is
  //    no capability to assume, so we decline rather than guess. Declining is
  //    the recoverable direction — the user still gets usage and every
  //    subcommand, and the message below names TERM as the thing to set.
  const term = env.TERM?.trim().toLowerCase();
  if (term === 'dumb' || !term) {
    const cause =
      term === 'dumb'
        ? `TERM is "${env.TERM}", which cannot redraw a full-screen interface`
        : `TERM is ${env.TERM === undefined ? 'not set' : 'empty'}, so this terminal's capabilities are unknown`;
    return refuse(
      'dumb-terminal',
      `${cause}. Run \`${CLI_NAME} --help\` to see the commands, or set TERM if this terminal can redraw.`,
    );
  }

  // 5. CI, LAST AND STILL NECESSARY. Most CI systems give a process no TTY at
  //    all and are caught above — but a step running under `docker run -t`, a
  //    Jenkins job with the pty plugin, or a runner using `script(1)` to force
  //    colour has a REAL pseudo-terminal on both descriptors and passes every
  //    check so far. There is no human at that terminal, so the menu would
  //    still wait for a keypress that never comes. Declining here converts a
  //    job that hangs until its timeout into one that fails in a second with
  //    printed usage.
  if (isEnvFlagSet(env.CI) || isEnvFlagSet(env.CONTINUOUS_INTEGRATION)) {
    return refuse(
      'ci',
      `CI is set, so the interactive interface was not started — nothing would answer it. Run a subcommand, or unset CI if this is a developer machine.`,
    );
  }

  return { engage: true };
}

function refuse(refusal: TuiRefusal, reason: string): TuiGateDecision {
  return { engage: false, refusal, reason };
}

/**
 * Is an environment variable set to something meaning "yes"?
 *
 * `CI=false` and `CI=0` are set by people trying to turn CI mode OFF, and a
 * bare `!== undefined` test would read both as "yes, this is CI" — refusing
 * the TUI to a developer who explicitly asked not to be treated as one. An
 * empty value is likewise an unset variable that a shell happens to export,
 * the same reading config.ts gives `APPCTL_TOKEN=`.
 */
function isEnvFlagSet(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalised = value.trim().toLowerCase();
  return (
    normalised.length > 0 && normalised !== '0' && normalised !== 'false' && normalised !== 'no'
  );
}
