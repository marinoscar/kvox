import { spawn } from 'node:child_process';

import { CliError, EXIT, type ExitCode } from '../errors.js';

// =============================================================================
// Running a command and knowing what happened  (issue #173, epic #168)
// =============================================================================
//
// A deployment is mostly other people's programs: git, docker, docker compose,
// certbot, nginx. This module is the only place this CLI starts one.
//
// THE EXISTING `spawn` CALL IS NOT A SUBSTITUTE. `browser.ts` launches a URL
// opener with `stdio: 'ignore'`, `detached: true` and `unref()`, and swallows
// every failure - deliberately, because opening a browser is best-effort. A
// deploy step is the opposite: the exit code IS the result, and the output is
// the only evidence when it goes wrong.
//
// Four rules this file exists to enforce:
//
//   1. ARGV, NEVER A SHELL STRING. No `shell: true`, no interpolation into a
//      command line. A domain or a password reaching a shell is an injection,
//      and both are values this deployment handles.
//   2. OUTPUT STREAMS AS IT ARRIVES. A `docker compose build` that reports
//      nothing for four minutes and then dumps 3000 lines is indistinguishable
//      from a hang, and the TUI (#184) renders these lines live.
//   3. ANSI IS STRIPPED. Docker and git colourise whenever they think they
//      have a terminal. `tui/scroll-box.tsx` requires plain text - a viewport
//      that starts mid-colour-run leaks that colour into the rest of the frame.
//   4. NOTHING IS UNBOUNDED. Retained output is capped, because a runaway
//      build must not exhaust memory on a small VPS.
// =============================================================================

/** Lines of stdout and stderr each kept in memory for `CommandResult`. */
const MAX_RETAINED_LINES = 5_000;

/** Stderr lines quoted in a failure message. Enough to diagnose, not a dump. */
const ERROR_TAIL_LINES = 20;

// Built with fromCharCode so no raw escape byte appears in this source file.
// A literal one is invisible in review, survives copy-paste badly, and is the
// kind of thing an editor silently normalises away.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/**
 * CSI sequences (colour, cursor movement) and OSC sequences (window titles).
 *
 * Hand-rolled rather than pulling in `strip-ansi`, for the reason the rest of
 * this package hand-rolls its small utilities; see the note in `output.ts`.
 */
const ANSI_PATTERN = new RegExp(
  ESC + '\\[[0-9;?]*[ -/]*[@-~]' +
    '|' +
    ESC + '\\][^' + BEL + ESC + ']*(?:' + BEL + '|' + ESC + '\\\\)',
  'g',
);

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

export type OutputStream = 'stdout' | 'stderr';

export interface RunCommandOptions {
  /** Working directory. Required - a deploy step's cwd is never incidental. */
  cwd: string;
  /** Replaces the child's environment entirely when given. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Kill the child after this long. */
  timeoutMs?: number | undefined;
  /** Called per output line, ANSI already stripped, as it arrives. */
  onLine?: ((line: string, stream: OutputStream) => void) | undefined;
  /** Non-zero codes that are an expected answer rather than a failure. */
  allowExitCodes?: readonly number[] | undefined;
  /** Aborts the run; the TUI passes its screen's controller. */
  signal?: AbortSignal | undefined;
  /**
   * Applied to every string that reaches a message or a result.
   *
   * The journal supplies its redactor here so a secret in an argv - a `psql`
   * connection string, most obviously - cannot reach a thrown error. Defaults
   * to identity so the module is usable without one.
   */
  redact?: ((value: string) => string) | undefined;
}

export interface CommandResult {
  argv: readonly string[];
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** True when the child was killed by `timeoutMs` rather than exiting. */
  timedOut: boolean;
}

/**
 * A command ran and failed.
 *
 * EXIT.FAILURE rather than a new code: from a script's point of view "docker
 * build failed" is an ordinary failure of this CLI's work, not a distinct
 * condition to branch on. The failed-precondition case is genuinely different
 * and gets its own code in #178.
 */
export class CommandFailedError extends CliError {
  readonly exitCode: ExitCode = EXIT.FAILURE;
  readonly result: CommandResult;

  constructor(message: string, result: CommandResult) {
    super(message);
    this.result = result;
  }
}

/** Turns a chunked byte stream into whole, ANSI-free lines. */
class LineAssembler {
  private pending = '';
  private readonly lines: string[] = [];
  private dropped = 0;

  constructor(
    private readonly stream: OutputStream,
    private readonly onLine:
      | ((line: string, stream: OutputStream) => void)
      | undefined,
  ) {}

  push(chunk: string): void {
    // A line can be split across chunk boundaries; emitting per chunk would
    // cut words in half in the middle of a build log.
    this.pending += chunk;
    let index = this.pending.indexOf('\n');
    while (index !== -1) {
      const raw = this.pending.slice(0, index);
      this.pending = this.pending.slice(index + 1);
      this.emit(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
      index = this.pending.indexOf('\n');
    }
  }

  /** Flushes a trailing line with no newline - a prompt, or a truncated log. */
  finish(): void {
    if (this.pending !== '') {
      this.emit(this.pending);
      this.pending = '';
    }
  }

  text(): string {
    const body = this.lines.join('\n');
    if (this.dropped === 0) {
      return body;
    }
    return `[... ${this.dropped} earlier lines dropped ...]\n${body}`;
  }

  tail(count: number): string[] {
    return this.lines.slice(-count);
  }

  private emit(raw: string): void {
    const line = stripAnsi(raw);
    this.lines.push(line);
    if (this.lines.length > MAX_RETAINED_LINES) {
      this.lines.shift();
      this.dropped += 1;
    }
    this.onLine?.(line, this.stream);
  }
}

/**
 * Runs a command to completion.
 *
 * Resolves when the exit code is 0 or listed in `allowExitCodes`; rejects with
 * `CommandFailedError` otherwise. The result is attached to the error, so a
 * caller that wants the output of a failure does not re-run anything to get it.
 */
export async function runCommand(
  argv: readonly string[],
  options: RunCommandOptions,
): Promise<CommandResult> {
  const [command, ...args] = argv;
  if (command === undefined) {
    throw new TypeError('runCommand requires at least the command name');
  }

  const redact = options.redact ?? ((value: string) => value);
  const startedAt = Date.now();

  const stdout = new LineAssembler('stdout', options.onLine);
  const stderr = new LineAssembler('stderr', options.onLine);

  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      // No `shell: true`. See rule 1 in the header.
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(options.env === undefined ? {} : { env: options.env }),
    });

    let timedOut = false;
    let settled = false;

    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            // SIGTERM, not SIGKILL: a `docker build` killed outright can leave
            // a dangling builder behind.
            child.kill('SIGTERM');
          }, options.timeoutMs);

    const onAbort = (): void => {
      child.kill('SIGTERM');
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: string) => stderr.push(chunk));

    child.once('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      cleanup();
      stdout.finish();
      stderr.finish();

      // ENOENT means the program is not installed, which is the most common
      // failure on a fresh server and deserves to say so rather than surface
      // as "spawn git ENOENT".
      const detail =
        error.code === 'ENOENT'
          ? `${command}: command not found`
          : `${command}: ${error.message}`;

      reject(
        new CommandFailedError(redact(detail), {
          argv: [...argv],
          cwd: options.cwd,
          exitCode: -1,
          stdout: redact(stdout.text()),
          stderr: redact(stderr.text()),
          durationMs: Date.now() - startedAt,
          timedOut: false,
        }),
      );
    });

    child.once('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      stdout.finish();
      stderr.finish();

      const result: CommandResult = {
        argv: [...argv],
        cwd: options.cwd,
        exitCode: code ?? -1,
        stdout: redact(stdout.text()),
        stderr: redact(stderr.text()),
        durationMs: Date.now() - startedAt,
        timedOut,
      };

      const allowed = options.allowExitCodes ?? [];
      if (result.exitCode === 0 || allowed.includes(result.exitCode)) {
        resolve(result);
        return;
      }

      reject(
        new CommandFailedError(
          redact(describeFailure(result, stderr.tail(ERROR_TAIL_LINES))),
          result,
        ),
      );
    });
  });
}

/** The message a failed command produces. Exported for its test. */
export function describeFailure(
  result: CommandResult,
  stderrTail: readonly string[],
): string {
  const rendered = result.argv.join(' ');
  const headline = result.timedOut
    ? `\`${rendered}\` timed out after ${result.durationMs}ms`
    : `\`${rendered}\` exited ${result.exitCode}`;

  const tail = stderrTail.filter((line) => line.trim() !== '');
  if (tail.length === 0) {
    return headline;
  }
  return `${headline}\n${tail.map((line) => `    ${line}`).join('\n')}`;
}
