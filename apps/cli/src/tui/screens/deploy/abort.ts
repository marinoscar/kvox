import { runCommand as defaultRunCommand } from '../../../deploy/executor.js';

// =============================================================================
// Threading the abort signal into the executor  (issue #132, epic #118)
// =============================================================================
//
// THE HAZARD THIS EXISTS FOR IS THE ONE #131's header describes: the screen
// that preceded the install wizard created an `AbortController`, aborted it on
// unmount, and passed it nowhere — so Esc "cancelled" a `docker compose build`
// that went on running on a production server. The only thing that makes an
// abort real is that every child process was spawned through a `runCommand`
// carrying the signal, which `executor.ts` turns into SIGTERM.
//
// #131 wrapped it inline because one screen needed it. Three screens here do
// (the update run, a certbot renewal, and the doctor's own probes), so the
// wrapper is named once rather than re-derived per screen — a screen that
// forgets the `...options` spread silently drops the cwd and the timeout, and
// that is not a mistake worth leaving three chances to make.
// =============================================================================

/**
 * `run`, with `signal` merged into every invocation's options.
 *
 * The signal is applied AFTER the caller's options so a call site cannot
 * accidentally override it with one of its own.
 */
export function withSignal(
  signal: AbortSignal,
  run: typeof defaultRunCommand = defaultRunCommand,
): typeof defaultRunCommand {
  return (argv, options) => run(argv, { ...options, signal });
}
