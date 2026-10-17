#!/usr/bin/env node
// =============================================================================
// The `kvox-eval` command (issue #580)
// =============================================================================
//
//   kvox-eval kg  ...   score knowledge-graph extraction (see kg-command.ts)
//   kvox-eval ask ...   the Ask evaluation: NOT headless yet (exit 2)
//
// The Ask run seeds a graph in a database and drives the real `ask.respond`
// handler on a Nest application, which only the web app has; until a headless
// runner exists it stays `npm run ask:eval --workspace=api`.
// =============================================================================

import { KG_EVAL_EXIT, runKgCommand, type EvalCommandIo, type KgCommandOptions } from './kg-command.js';

/**
 * The usage text of `kvox-eval`.
 *
 * @stability experimental
 */
export const KVOX_EVAL_USAGE = `usage: kvox-eval kg [flags]    score knowledge-graph extraction against the golden set
       kvox-eval ask          the Ask evaluation (not headless yet: npm run ask:eval --workspace=api)
       kvox-eval kg --help    the kg flags`;

/**
 * Runs `kvox-eval` with the given arguments (everything after the command name).
 *
 * @param argv - the arguments, the subcommand first.
 * @param io - output streams and environment.
 * @param options - passed to the kg command.
 * @returns the exit code.
 * @stability experimental
 */
export async function main(argv: string[], io: EvalCommandIo = defaultIo(), options: KgCommandOptions = {}): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'kg') return runKgCommand(rest, io, options);
  if (command === 'ask') {
    io.err('kvox-eval ask: the headless Ask run is not available yet; run the Ask evaluation from the web app: npm run ask:eval --workspace=api');
    return KG_EVAL_EXIT.usage;
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    io.out(KVOX_EVAL_USAGE);
    return KG_EVAL_EXIT.ok;
  }
  io.err(command === undefined ? 'kvox-eval: no command given' : `kvox-eval: unknown command '${command}'`);
  io.err(KVOX_EVAL_USAGE);
  return KG_EVAL_EXIT.usage;
}

function defaultIo(): EvalCommandIo {
  return {
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
    env: process.env,
  };
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      // A KvoxAiError never reaches here (the kg command reports it by class);
      // anything else is a bug, and its stack is the useful part.
      process.stderr.write(`kvox-eval: ${(err as Error).stack ?? String(err)}\n`);
      process.exitCode = KG_EVAL_EXIT.usage;
    },
  );
}
