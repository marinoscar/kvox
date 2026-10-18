// =============================================================================
// ask:eval — evaluate the Ask agent against its golden question set (issue #382)
// =============================================================================
//
//   npm run ask:eval --workspace=api -- --model gpt-4o-mini
//   npm run ask:eval --workspace=api -- --only q01,q22 --model gpt-4o-mini
//   npm run ask:eval --workspace=api -- --category negative --model gpt-4o-mini
//   npm run ask:eval --workspace=api -- --replay
//
// A THIN WRAPPER (#608): this is `kvox-eval ask` of `@marinoscar/kvox-eval`
// (`runAskCommand` of `@marinoscar/kvox-eval/ask-run`), run under this script's name with the git-ignored
// `apps/api/.ask-eval/` as the runs directory. Every flag of the package
// command works here (`--provider`, `--base-url`, `--min-match`, `--replay`, ...).
//
// The run no longer touches this app's database or its Nest application: the
// package starts an in-memory PostgreSQL (PGlite), applies the platform and
// domain migrations, seeds the golden graph through the graph write service and
// runs every question through the real `ask.respond` handler on the live model
// port. Nothing outlives the process, so the old `--keep` and `--allow-db`
// flags have nothing left to do: they are accepted, ignored, and say so.
//
// The API key comes ONLY from `KVOX_EVAL_OPENAI_API_KEY` (never a flag;
// `ASK_EVAL_OPENAI_API_KEY` is still read for one release, #580).
//
// Exit codes: 0 pass · 1 a gate failed (citation validity < 1, a sensitive
// leak) or answer match fell below `--min-match` · 2 configuration error (no
// key, a refused provider, a bad flag).
// =============================================================================

import { join } from 'path';

import { KVOX_EVAL_API_KEY_ENV, type EvalCommandIo } from '@marinoscar/kvox-eval';
import { ASK_EVAL_EXIT, DEFAULT_ASK_EVAL_MODEL, runAskCommand } from '@marinoscar/kvox-eval/ask-run';

export const EXIT = ASK_EVAL_EXIT;

const USAGE = `usage: ask:eval [--model <id>] [--provider openai|openai-compatible] [--base-url <url>]
               [--only q01,q07] [--category <c>] [--out <dir>] [--min-match <0..1>]
       ask:eval --replay      the scripted self-test (no model, no key)
       reads the API key from ${KVOX_EVAL_API_KEY_ENV} (never a flag); default model ${DEFAULT_ASK_EVAL_MODEL}`;

/** The flags the database-backed runner took, which the in-memory run has no use for. */
const RETIRED_FLAGS = ['--keep', '--allow-db'] as const;

/** `argv` without the retired flags (and `--allow-db`'s value), plus which ones were given. */
export function withoutRetiredFlags(argv: readonly string[]): { args: string[]; retired: string[] } {
  const args: string[] = [];
  const retired = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--keep') {
      retired.add('--keep');
    } else if (arg === '--allow-db') {
      retired.add('--allow-db');
      i += 1; // its value
    } else if (arg.startsWith('--allow-db=')) {
      retired.add('--allow-db');
    } else {
      args.push(arg);
    }
  }
  return { args, retired: RETIRED_FLAGS.filter((flag) => retired.has(flag)) };
}

function defaultIo(): EvalCommandIo {
  return { out: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`), env: process.env };
}

export async function main(argv: string[], io: EvalCommandIo = defaultIo()): Promise<number> {
  const { args, retired } = withoutRetiredFlags(argv);
  if (retired.length > 0) {
    io.err(`ask:eval: ignoring ${retired.join(' and ')}: the run uses an in-memory database that ends with the process`);
  }
  return runAskCommand(args, io, { name: 'ask:eval', usage: USAGE, syntheticRunsDir: join(__dirname, '../.ask-eval') });
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`ask:eval: ${(err as Error).stack ?? String(err)}\n`);
      process.exitCode = EXIT.config;
    },
  );
}
