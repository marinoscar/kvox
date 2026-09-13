import { createInterface } from 'node:readline/promises';

import { CLI_NAME } from './branding.js';
import { UsageError } from './errors.js';

// =============================================================================
// Interactive prompting  (issues #142/#143, epic #110)
// =============================================================================
//
// `node:readline/promises`, no dependency. The prompt libraries (inquirer,
// prompts, enquirer) earn their weight when you need select lists, validation
// loops and multi-step forms; this CLI asks exactly one question — "which
// server?" — and the standard library answers it in fifteen lines. #145's TUI
// takes over the rich case with ink, so a second interaction library would be
// dead weight the moment it landed.
//
// TWO RULES, BOTH LOAD-BEARING:
//
//   1. THE PROMPT GOES TO STDERR. program.ts reserves stdout for command
//      output so that #144's `--raw` pipes into `jq` unchanged. A prompt on
//      stdout would be indistinguishable from data — and, worse, would be
//      swallowed by the pipe, leaving the user staring at a hung command with
//      no visible question.
//
//   2. NO TTY MEANS NO PROMPT — IT MEANS A CLEAR ERROR. Calling `question()`
//      on a redirected or closed stdin does not fail; it waits, or it returns
//      empty at EOF. In CI that is a job that hangs until the runner kills it,
//      and the log shows nothing about why. Failing immediately with "pass
//      --server" turns a ten-minute timeout into a one-line fix.
// =============================================================================

export interface PromptContext {
  input?: NodeJS.ReadStream | undefined;
  output?: NodeJS.WriteStream | undefined;
}

/** True when we can actually ask a question and expect an answer. */
export function canPrompt(ctx?: PromptContext): boolean {
  return (ctx?.input ?? process.stdin).isTTY === true;
}

/**
 * Ask a question on stderr and return the trimmed answer.
 *
 * Throws UsageError (exit 2 — the invocation was wrong, not the server)
 * when there is no TTY.
 */
export async function prompt(question: string, ctx?: PromptContext): Promise<string> {
  const input = ctx?.input ?? process.stdin;
  const output = ctx?.output ?? process.stderr;

  if (input.isTTY !== true) {
    throw new UsageError(
      `${CLI_NAME} needs an interactive terminal to ask "${question.trim()}". Supply the value on the command line instead.`,
    );
  }

  const rl = createInterface({ input, output, terminal: true });
  try {
    return (await rl.question(question)).trim();
  } finally {
    // Always closed, including when the promise rejects on Ctrl-C. A readline
    // interface left open holds stdin in raw mode: the shell the user returns
    // to stops echoing what they type, which looks like a broken terminal and
    // is fixed only by `reset`.
    rl.close();
  }
}

/**
 * Ask for the server URL.
 *
 * The default is shown in the prompt and returned on an empty answer, so a
 * repeat login is one keypress. Returning the default rather than re-asking
 * matters: an empty line at the end of piped input would otherwise loop
 * forever.
 */
export async function promptForServerUrl(
  defaultUrl?: string | undefined,
  ctx?: PromptContext,
): Promise<string> {
  const suffix = defaultUrl === undefined ? '' : ` [${defaultUrl}]`;
  const answer = await prompt(`Server URL${suffix}: `, ctx);

  if (answer.length > 0) return answer;
  if (defaultUrl !== undefined) return defaultUrl;

  throw new UsageError(
    `A server URL is required. Re-run with --server <url> (for example: --server https://app.example.com).`,
  );
}

// =============================================================================
// The three primitives the deployment wizard needs  (issue #175, epic #168)
// =============================================================================
//
// Still `node:readline/promises`, still no dependency. The header above argues
// that a prompt library earns its weight only when you need select lists and
// validation loops; the wizard does need those, but it needs THREE of them,
// and the ink TUI already owns the rich case. Three small functions is a
// better trade than a dependency the TUI would make redundant.
//
// All three keep the two rules above: stderr, and no TTY means a clear error.
// =============================================================================

/**
 * Opens ONE readline interface for a question that may be asked repeatedly.
 *
 * `confirm` and `select` both re-ask on a bad answer, and calling `prompt()` in
 * a loop would open and close an interface per iteration. That is wasteful with
 * a real terminal - raw mode toggled on and off each time - and outright wrong
 * with buffered input: closing an interface discards what readline has already
 * read ahead, so the answer to the second question disappears and the CLI hangs
 * waiting for input that was consumed and thrown away.
 */
async function withInterface<T>(
  ctx: PromptContext | undefined,
  body: (ask: (question: string) => Promise<string>) => Promise<T>,
): Promise<T> {
  const input = ctx?.input ?? process.stdin;
  const output = ctx?.output ?? process.stderr;

  if (input.isTTY !== true) {
    throw new UsageError(
      `${CLI_NAME} needs an interactive terminal to ask a question. Supply the value on the command line instead.`,
    );
  }

  const rl = createInterface({ input, output, terminal: true });
  try {
    return await body(async (question) => (await rl.question(question)).trim());
  } finally {
    // Same reason as `prompt`: an interface left open holds stdin in raw mode
    // and the shell the user returns to stops echoing.
    rl.close();
  }
}

/**
 * Ask a yes/no question.
 *
 * An unrecognised answer RE-ASKS rather than falling back to the default. The
 * default applies to an empty line only - somebody who typed "yeah" has an
 * opinion, and silently reading it as "no" is how a confirmation stops meaning
 * anything.
 *
 * Callers pass `defaultValue: false` for anything destructive. The TUI holds
 * the same convention for the same reason (see tui/screens/logout.tsx): a
 * destructive action defaulting to yes is one stray Enter away from happening
 * by accident.
 */
export async function confirm(
  question: string,
  options?: { defaultValue?: boolean | undefined },
  ctx?: PromptContext,
): Promise<boolean> {
  const defaultValue = options?.defaultValue;
  const hint =
    defaultValue === true ? '[Y/n]' : defaultValue === false ? '[y/N]' : '[y/n]';
  const output = ctx?.output ?? process.stderr;

  return await withInterface(ctx, async (ask) => {
    for (;;) {
      const answer = (await ask(`${question} ${hint} `)).toLowerCase();

      if (answer === '') {
        if (defaultValue !== undefined) return defaultValue;
        continue;
      }
      if (answer === 'y' || answer === 'yes') return true;
      if (answer === 'n' || answer === 'no') return false;

      output.write('  Please answer y or n.\n');
    }
  });
}

/**
 * Ask for a value without echoing it.
 *
 * NOT ECHOING IS NOT COSMETIC. These values reach scrollback, `script` logs,
 * and the screen behind whoever is standing near an operator on a laptop.
 *
 * THE MUTING IS DONE AT THE OUTPUT STREAM, not by patching readline. The usual
 * trick - replacing the interface's `_writeToOutput` - SILENTLY STOPPED
 * WORKING: Node's readline moved its internals behind symbols, so the property
 * is still assignable, the assignment still appears to succeed, and every
 * keystroke is echoed anyway. It fails open, which is the worst way for
 * something like this to fail, and nothing about the code looks wrong.
 *
 * Handing readline a gated view of the output stream cannot fail that way: if
 * writes stop going through `write`, nothing is displayed at all, which is
 * obvious the first time anyone runs it.
 */
export async function promptSecret(
  question: string,
  ctx?: PromptContext,
): Promise<string> {
  const input = ctx?.input ?? process.stdin;
  const output = ctx?.output ?? process.stderr;

  if (input.isTTY !== true) {
    throw new UsageError(
      `${CLI_NAME} needs an interactive terminal to ask "${question.trim()}". Supply the value in the environment file instead.`,
    );
  }

  let muted = false;

  // A proxy rather than a hand-built stub: readline reaches for `columns`,
  // `rows`, `cursorTo` and the event methods of a terminal output, and
  // enumerating them here would break the next time it reaches for one more.
  const gated = new Proxy(output, {
    get(target, property, receiver) {
      if (property === 'write') {
        return (chunk: unknown, ...rest: unknown[]): boolean => {
          if (muted) return true;
          return (target.write as (...args: unknown[]) => boolean)(chunk, ...rest);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as NodeJS.WriteStream;

  const rl = createInterface({ input, output: gated, terminal: true });

  try {
    // The prompt is written while unmuted; everything after it is the user's
    // own keystrokes being echoed back.
    const pending = rl.question(question);
    muted = true;
    const answer = await pending;
    // Readline's own newline was suppressed along with the echo.
    output.write('\n');
    return answer.trim();
  } finally {
    muted = false;
    // Same reason as `prompt`: an interface left open holds stdin in raw mode
    // and the shell the user returns to stops echoing what they type.
    rl.close();
  }
}

export interface SelectChoice<T extends string> {
  value: T;
  label: string;
}

/**
 * Ask the operator to pick one of a short list.
 *
 * Plain readline, not ink. This is the SUBCOMMAND path, which has to work over
 * a bare SSH session and must never load the TUI - tui/tty.ts is explicit that
 * an explicit subcommand never consults the TUI gate.
 */
export async function select<T extends string>(
  question: string,
  choices: readonly SelectChoice<T>[],
  ctx?: PromptContext,
): Promise<T> {
  if (choices.length === 0) {
    throw new UsageError('select() needs at least one choice');
  }

  const output = ctx?.output ?? process.stderr;

  return await withInterface(ctx, async (ask) => {
    for (;;) {
      output.write(`${question}\n`);
      choices.forEach((choice, index) => {
        output.write(`  ${index + 1}) ${choice.label}\n`);
      });

      const answer = await ask(`Choose 1-${choices.length}: `);
      const index = Number(answer);

      if (Number.isInteger(index) && index >= 1 && index <= choices.length) {
        return (choices[index - 1] as SelectChoice<T>).value;
      }

      output.write(`  Enter a number between 1 and ${choices.length}.\n`);
    }
  });
}
