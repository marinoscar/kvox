// =============================================================================
// `kvox-eval kg` — score knowledge-graph extraction against the golden set
// (issue #362; the package command since #580)
// =============================================================================
//
//   kvox-eval kg --predictions gold
//   kvox-eval kg --predictions <dir> [--only m01,m07] [--tag promotion]
//   kvox-eval kg --runner extract --provider openai --model <id> [--out <dir>]
//   kvox-eval kg --runner extract --provider openai-compatible --base-url <url> --model <id>
//   kvox-eval kg --real-dir <dir outside the repo> --predictions <dir>
//
// Flags: --json <file> also writes the report as JSON; --enforce exits 1 when a
// §6 target (docs/specs/ontology.md) fails — for local use, CI reports only.
// `--run` is accepted for `--runner` (the web app's `npm run kg:eval` spelling).
//
// Exit codes: 0 ok · 1 --enforce and a target failed · 2 usage/runner/load
// error (a refused provider and a failed live call included) · 3 a real-data
// path inside the repository (refused).
//
// The API key for a live runner comes from KVOX_EVAL_OPENAI_API_KEY only
// (KG_EVAL_OPENAI_API_KEY and ASK_EVAL_OPENAI_API_KEY for one more release),
// never a flag, and is never printed or written anywhere. A failed live call
// is reported by its error class, code and HTTP status only.
//
// `runKgCommand` takes its output streams and environment as arguments, so a
// test (and the web app's thin `scripts/kg-eval.ts` wrapper) drives it in
// process.
// =============================================================================

import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { parseArgs } from 'util';

import { KvoxAiError } from '@marinoscar/kvox-api/ports';
import type { AiProviderAdapter } from '@marinoscar/platform-ai-providers';

import { KgEvalLoadError } from '../fixtures/index.js';
import { formatReport } from '../kg/index.js';
import { KgEvalUsageError, runKgEval } from '../kg/index.js';
import { findKgEvalRunner, KG_EVAL_RUNNERS } from '../kg/index.js';
import { KVOX_EVAL_API_KEY_ENV, readEvalApiKey } from '../live/index.js';
import { assertLiveProvider, createLiveKvoxAi, LiveProviderError, type LiveCallFailure } from '../live/index.js';
import { assertOutsideRepo, RealDataPathError } from '../real-data/index.js';

/**
 * The exit codes of `kvox-eval kg` (and of the web app's `npm run kg:eval`).
 *
 * @stability experimental
 */
export const KG_EVAL_EXIT = Object.freeze({ ok: 0, targetsFailed: 1, usage: 2, pathRefused: 3 } as const);

/**
 * Where a command writes, and the environment it reads.
 *
 * @stability experimental
 */
export interface EvalCommandIo {
  /** One line to standard output. */
  out: (line: string) => void;
  /** One line to standard error. */
  err: (line: string) => void;
  /** The environment (`process.env`, or a test's own). */
  env: Readonly<Record<string, string | undefined>>;
}

/**
 * How a host runs the kg command under its own name.
 *
 * @stability experimental
 */
export interface KgCommandOptions {
  /** The prefix of every message (`kvox-eval kg`, `kg:eval`). */
  name?: string;
  /** The usage text printed with a usage error and for `--help`. */
  usage?: string;
  /**
   * A git-ignored directory inside the repository that output of a run over the
   * SYNTHETIC set may be written to, and the default `--out` root (the web app's
   * `apps/api/.kg-eval/`). Default: none, and the output defaults to the system
   * temporary directory.
   */
  syntheticRunsDir?: string | null;
  /** The provider adapters by id. Default: the platform's. A test passes a fake. */
  adapters?: Readonly<Record<string, AiProviderAdapter>>;
}

/**
 * The usage text of `kvox-eval kg`.
 *
 * @stability experimental
 */
export const KG_COMMAND_USAGE = `usage: kvox-eval kg (--predictions <dir|gold> | --runner extract|extract-resolve --model <id>)
               [--provider openai|openai-compatible|copilot] [--base-url <url>] [--out <dir>]
               [--only m01,m07] [--tag <tag>] [--json <file>] [--enforce] [--real-dir <dir>]
       reads a live runner's API key from ${KVOX_EVAL_API_KEY_ENV} (never a flag)`;

/** A command line that cannot run; printed with the usage text. */
class UsageError extends Error {}

/** A live call that failed; printed by class, code and status only. */
class LiveCallError extends Error {}

/**
 * Runs `kvox-eval kg` with the given arguments (everything after `kg`).
 *
 * @example
 * ```ts
 * const code = await runKgCommand(['--predictions', 'gold'], { out: console.log, err: console.error, env: process.env });
 * ```
 *
 * @param argv - the arguments.
 * @param io - output streams and environment.
 * @param options - the host's name, usage text, scratch directory and adapters.
 * @returns the exit code ({@link KG_EVAL_EXIT}).
 * @stability experimental
 */
export async function runKgCommand(argv: string[], io: EvalCommandIo, options: KgCommandOptions = {}): Promise<number> {
  const name = options.name ?? 'kvox-eval kg';
  const usage = options.usage ?? KG_COMMAND_USAGE;
  try {
    return await run(argv, io, options, name, usage);
  } catch (err) {
    if (err instanceof RealDataPathError) {
      io.err(`${name}: ${err.message}`);
      return KG_EVAL_EXIT.pathRefused;
    }
    if (err instanceof UsageError || err instanceof KgEvalUsageError) {
      io.err(`${name}: ${err.message}`);
      io.err(usage);
      return KG_EVAL_EXIT.usage;
    }
    if (err instanceof KgEvalLoadError || err instanceof LiveProviderError || err instanceof LiveCallError) {
      io.err(`${name}: ${err.message}`);
      return KG_EVAL_EXIT.usage;
    }
    throw err;
  }
}

async function run(argv: string[], io: EvalCommandIo, options: KgCommandOptions, name: string, usage: string): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        predictions: { type: 'string' },
        runner: { type: 'string' },
        run: { type: 'string' },
        provider: { type: 'string' },
        model: { type: 'string' },
        'base-url': { type: 'string' },
        out: { type: 'string' },
        only: { type: 'string' },
        tag: { type: 'string' },
        json: { type: 'string' },
        enforce: { type: 'boolean' },
        'real-dir': { type: 'string' },
        help: { type: 'boolean' },
      },
    }));
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const str = (k: string) => (typeof values[k] === 'string' ? (values[k] as string) : undefined);

  if (values.help) {
    io.out(usage);
    return KG_EVAL_EXIT.ok;
  }

  // Real-data mode: the path guard runs before anything is read or written.
  const realDirArg = str('real-dir') ?? (io.env.KG_EVAL_REAL_DIR || undefined);
  const realDir = realDirArg ? assertOutsideRepo(realDirArg) : null;

  if (str('runner') !== undefined && str('run') !== undefined) throw new UsageError('pass --runner or --run, not both');
  const runnerFlag = str('runner') !== undefined ? '--runner' : '--run';
  const runnerName = str('runner') ?? str('run');
  const predictionsArg = str('predictions');
  if ((predictionsArg === undefined) === (runnerName === undefined)) {
    throw new UsageError(`pass exactly one of --predictions <dir|gold> or ${runnerFlag} <runner>`);
  }

  // An unregistered runner is reported before anything is loaded or written.
  const live = runnerName !== undefined ? findKgEvalRunner(runnerName) : null;
  if (runnerName !== undefined && live === null) {
    io.err(`${name}: no runner '${runnerName}' registered (known: ${Object.keys(KG_EVAL_RUNNERS).join(', ')})`);
    return KG_EVAL_EXIT.usage;
  }

  // The output guard runs before anything is loaded: a run over real data may
  // never write inside the repository, not even into the git-ignored scratch dir.
  let outDir: string | null = null;
  if (live !== null) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const synthetic = options.syntheticRunsDir ?? null;
    const outArg =
      str('out') ??
      (realDir ? join(realDir, 'runs', stamp) : synthetic ? join(synthetic, 'runs', stamp) : join(tmpdir(), 'kvox-eval', 'runs', stamp));
    outDir = assertOutsideRepo(outArg, { allowInside: realDir === null ? synthetic : null });
  }

  const only = str('only')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const selection = {
    ...(only ? { fixtures: only } : {}),
    ...(str('tag') !== undefined ? { tag: str('tag') as string } : {}),
    ...(realDir ? { fixturesDir: realDir } : {}),
  };

  let report;
  if (live !== null) {
    // The provider is refused (copilot, an unknown id) before the key is looked for.
    const provider = str('provider') ?? 'openai';
    assertLiveProvider(provider);
    const model = str('model');
    if (!model) throw new UsageError(`${runnerFlag} requires --model <id>`);
    const key = readEvalApiKey(io.env, io.err);
    if (key === null && provider === 'openai') {
      throw new UsageError(`${runnerFlag} reads its API key from ${KVOX_EVAL_API_KEY_ENV}; it is not set`);
    }
    const baseUrl = str('base-url');
    const { ai, failures } = createLiveKvoxAi({
      provider,
      model,
      apiKey: key?.apiKey ?? null,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(options.adapters !== undefined ? { adapters: options.adapters } : {}),
    });

    const dir = outDir as string;
    mkdirSync(dir, { recursive: true });
    try {
      report = await runKgEval({
        runner: live.name,
        ai,
        model,
        provider,
        ...selection,
        onPrediction: (fixtureId, pred) => writeFileSync(join(dir, `${fixtureId}.json`), `${JSON.stringify(pred, null, 2)}\n`),
      });
    } catch (err) {
      if (err instanceof KvoxAiError) throw new LiveCallError(describeLiveFailure(err, failures));
      throw err;
    }
    io.err(`${name}: predictions written to ${dir}`);
  } else if (predictionsArg === 'gold') {
    report = await runKgEval({ runner: 'gold', ...selection });
  } else {
    report = await runKgEval({
      predictionsDir: resolve(predictionsArg as string),
      ...selection,
      onMissingPrediction: (fixtureId, dir) => io.err(`${name}: no prediction for ${fixtureId} in ${dir} (scored as empty)`),
    });
  }

  io.out(formatReport(report));

  const jsonPath = str('json');
  if (jsonPath) {
    const abs = resolve(jsonPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `${JSON.stringify(report, null, 2)}\n`);
  }

  if (values.enforce && !report.targetsMet) {
    io.err(`${name}: one or more §6 targets failed (--enforce)`);
    return KG_EVAL_EXIT.targetsFailed;
  }
  return KG_EVAL_EXIT.ok;
}

/** `the live call failed (auth; AI_KEY_INVALID, HTTP 400)`: class, code, status. Never a message body. */
function describeLiveFailure(err: KvoxAiError, failures: readonly LiveCallFailure[]): string {
  const last = failures[failures.length - 1];
  const detail = last ? `; ${last.code}${last.status !== null ? `, HTTP ${last.status}` : ''}` : '';
  return `the live call failed (${err.errorClass}${detail})`;
}
