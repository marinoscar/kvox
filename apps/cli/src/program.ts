import { Command, CommanderError } from 'commander';

import { CLI_DISPLAY_NAME, CLI_NAME } from './branding.js';
import { registerApiCommand } from './commands/api.js';
import { registerConfigCommand } from './commands/config.js';
import { registerDeployCommand } from './commands/deploy.js';
import { registerInitCommand } from './commands/init.js';
import { registerLoginCommand } from './commands/login.js';
import { registerNodeCommand } from './commands/node.js';
import { EXIT, exitCodeFor, formatError } from './errors.js';
import { CLI_VERSION } from './package-info.js';
import { evaluateTuiGate, type TtyContext } from './tui/tty.js';

// =============================================================================
// Command wiring  (issue #140, epic #110)
// =============================================================================
//
// Commands: `login` (#142/#143), `config` (#143) and `api` (#144), plus the
// no-argument ink TUI (#145). `--help` and `--version` remain the proof that
// the bin resolves, that the ESM build runs, and — the part that is easy to get
// wrong and expensive to discover later — that a failed invocation exits
// non-zero.
//
// SEPARATE FROM cli.ts, which is the executable. This module only ever RETURNS
// an exit code; it never calls `process.exit`, and it runs nothing on import.
// That is what lets a test call `run([...])` and assert on the number, instead
// of having to spawn a child process to find out whether the CLI would have
// failed.
//
// Two rules this file exists to enforce for every command added after it:
//
//   1. NOTHING BUT COMMAND OUTPUT GOES TO STDOUT. Errors, progress and prompts
//      go to stderr, because #144 promises that `--raw` output pipes into `jq`
//      unchanged, and one stray status line on stdout breaks that for every
//      consumer at once.
//
//   2. FAILURE IS NON-ZERO, ALWAYS. A CLI that prints an error and exits 0
//      passes CI, and the pipeline stays green while nothing works.
// =============================================================================

export function buildProgram(): Command {
  const program = new Command();

  program
    .name(CLI_NAME)
    .description(`${CLI_DISPLAY_NAME} — command-line client for the API.`)
    .version(CLI_VERSION, '-v, --version', 'Print the version and exit')
    // Commander's default is to exit the process itself. We take that over so
    // every exit in this package goes through one place with one set of codes
    // — otherwise an unknown-command error would exit with commander's 1 while
    // a failed request exits 3, and only one of the two would be documented.
    .exitOverride()
    // A bad flag should show what the right flags are. Without this, commander
    // prints a single line and leaves the user to run `--help` themselves.
    .showHelpAfterError(true)
    .showSuggestionAfterError(true)
    // Help the user ASKED for goes to stdout; a usage dump caused by a mistake
    // goes to stderr. The distinction is what keeps `--raw | jq` clean once
    // #144 lands.
    .configureOutput({
      writeErr: (str) => process.stderr.write(str),
      writeOut: (str) => process.stdout.write(str),
    });

  // Registered here rather than in each command's own module so there is one
  // list of what this CLI can do, in the order it is shown in `--help`.
  // `init` first: it is the only command that works before the application
  // this CLI talks to can be started at all (#344), which puts it one step
  // earlier than `login`.
  registerInitCommand(program);
  // `login` next: it is the only command that works before you have run it.
  // `api` second: it is the one people actually came for.
  registerLoginCommand(program);
  registerApiCommand(program);
  registerConfigCommand(program);
  // `node` before `deploy`: it acts on THIS machine (turning it into a worker),
  // which puts it with `login`/`config` rather than with the group that acts on
  // a remote server.
  registerNodeCommand(program);
  // `deploy` last: it is the only group that acts on a SERVER rather than on
  // this machine's session, and it reads as a separate concern in --help.
  registerDeployCommand(program);

  return program;
}

/**
 * Injection seams for `run`. Both default to the real process.
 *
 * `startTui` exists so a test can assert THE PROPERTY THAT MATTERS — that the
 * TUI does not mount — without ink ever being loaded, let alone rendered into
 * the test runner's own stdout. Asserting "it did not mount" by mounting it is
 * not an option.
 */
export interface RunOptions {
  /** Streams and environment the TTY gate reads. */
  tty?: TtyContext | undefined;
  /** Replaces the dynamic import of the ink app. */
  startTui?: (() => Promise<number>) | undefined;
}

/**
 * Parse `argv` (arguments only — no node binary, no script path) and return
 * the exit code the process should use.
 */
export async function run(argv: string[], options?: RunOptions): Promise<number> {
  const program = buildProgram();

  // ---------------------------------------------------------------------------
  // NO ARGUMENTS: the ONLY invocation that can open the ink TUI (#145).
  // ---------------------------------------------------------------------------
  // The check is HERE, before `parseAsync`, and that placement is the whole
  // guarantee: an explicit subcommand never reaches this branch, so `appctl api
  // GET /api/auth/me` behaves identically in a terminal, in cron and in a
  // pipeline. The TUI is the no-argument experience, not a mode that could
  // capture a scripted invocation (epic #110, success criterion 7).
  //
  // Refusing prints help AND a sentence naming the reason, then exits NON-ZERO.
  // Non-zero because nothing was done: help was displayed, the requested action
  // was not performed, and a CLI that exits 0 having done nothing turns a broken
  // pipeline step into a green one. Both go to STDERR — help the user asked for
  // goes to stdout, a usage dump caused by a mistake does not, or `--raw | jq`
  // breaks for every consumer.
  if (argv.length === 0) {
    const gate = evaluateTuiGate(options?.tty);

    if (!gate.engage) {
      program.outputHelp({ error: true });
      process.stderr.write(`\n${gate.reason}\n`);
      return EXIT.USAGE;
    }

    try {
      // DYNAMIC, not a top-level import. ink, React, the reconciler and yoga's
      // WASM are loaded only once the gate has said yes — so the CI and pipeline
      // paths, and every subcommand, never pay for them and can never
      // accidentally start them. Making this a static import would silently undo
      // the containment `tui/tty.ts` exists to provide.
      const start = options?.startTui ?? (await import('./tui/index.js')).startTui;
      return await start();
    } catch (error) {
      // A failure to LOAD or MOUNT the UI, not a failure inside it —
      // `startTui` handles its own. Most likely a broken install (ink absent
      // from node_modules), which must not look like a successful run.
      process.stderr.write(`${formatError(error)}\n`);
      return exitCodeFor(error);
    }
  }

  try {
    await program.parseAsync(argv, { from: 'user' });
    return EXIT.OK;
  } catch (error) {
    if (error instanceof CommanderError) {
      // `--help` and `--version` arrive here as thrown "errors" purely because
      // of `exitOverride` above. They are successful invocations and must exit
      // 0; treating them as failures would break every script that checks the
      // version before doing anything else.
      if (
        error.code === 'commander.helpDisplayed' ||
        error.code === 'commander.help' ||
        error.code === 'commander.version'
      ) {
        return EXIT.OK;
      }
      // Anything else from commander is a malformed invocation, and commander
      // has already written its own message — printing ours too would show the
      // same problem twice.
      return EXIT.USAGE;
    }

    process.stderr.write(`${formatError(error)}\n`);
    return exitCodeFor(error);
  }
}
