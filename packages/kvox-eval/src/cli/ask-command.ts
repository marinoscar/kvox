// =============================================================================
// `kvox-eval ask` — the Ask evaluation, headless (issue #608; the web app's
// `npm run ask:eval`, #382)
// =============================================================================
//
//   kvox-eval ask --model gpt-4o-mini
//   kvox-eval ask --model <id> --only q01,q22
//   kvox-eval ask --model <id> --category negative --min-match 0.7
//   kvox-eval ask --provider openai-compatible --base-url <url> --model <id>
//   kvox-eval ask --replay
//
// NO web app and NO external database: the run starts PGlite in memory, applies
// the platform and domain migrations, seeds the golden graph through the graph
// write service, and runs every selected question through the real
// `ask.respond` handler of `@marinoscar/kvox-api/ask` on the live model port
// (`createLiveKvoxAi`). Everything dies with the process. It prints the table
// and writes `report.json` and `answers.md` under `--out` (default: a stamped
// folder under the system temporary directory, or under the host's own
// git-ignored runs directory).
//
// `--replay` runs the harness's self-test instead: six scripted questions on a
// scripted runtime (no model, no key, no network), checked for citation
// validity, every turn complete and the sensitive-fact leak gate; it prints one
// line per question and writes `replay.json` (the same `--out` default).
//
// The API key comes from KVOX_EVAL_OPENAI_API_KEY only (ASK_EVAL_OPENAI_API_KEY
// for one more release), never a flag, and is never printed or written. The key
// gate runs FIRST, before the database starts. A failed provider round trip is
// reported by its error code and HTTP status only.
//
// Exit codes: 0 pass · 1 a gate failed (citation validity < 1, a sensitive
// leak) or answer match fell below `--min-match`, or a replay expectation
// failed · 2 configuration error (no key, a refused provider, a bad flag, an
// unknown question id, a malformed fixture, every model call failed, or a rate
// limit the run cannot wait out). A turn whose model call failed is otherwise
// scored as a failed answer and the run goes on.
// =============================================================================

import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { parseArgs } from 'util';

import { KvoxAiError, KvoxRateLimitError } from '@marinoscar/kvox-api/ports';

import {
  AskEvalQuestionLoadError,
  formatAnswersMarkdown,
  formatAskEvalReport,
  selectAskEvalQuestions,
  type AskEvalQuestion,
} from '../ask/index.js';
import { DEFAULT_ASK_EVAL_MODEL, runAskEval, runAskReplay } from '../ask-run/index.js';
import { KgEvalLoadError, loadGoldenAskQuestions, loadGoldenSet } from '../fixtures/index.js';
import { KVOX_EVAL_API_KEY_ENV, readEvalApiKey } from '../live/index.js';
import { assertLiveProvider, createLiveKvoxAi, LiveProviderError, type LiveCallFailure } from '../live/index.js';
import type { EvalCommandIo } from './kg-command.js';

/**
 * The exit codes of `kvox-eval ask` (and of the web app's `npm run ask:eval`).
 *
 * @stability experimental
 */
export const ASK_EVAL_EXIT = Object.freeze({ ok: 0, failed: 1, config: 2 } as const);

/**
 * The usage text of `kvox-eval ask`.
 *
 * @stability experimental
 */
export const ASK_COMMAND_USAGE = `usage: kvox-eval ask [--provider openai|openai-compatible] [--model <id>] [--base-url <url>]
               [--only q01,q07] [--category <c>] [--out <dir>] [--min-match <0..1>]
       kvox-eval ask --replay      the scripted self-test (no model, no key)
       reads the API key from ${KVOX_EVAL_API_KEY_ENV} (never a flag); default model ${DEFAULT_ASK_EVAL_MODEL}`;

/**
 * How a host runs the ask command under its own name.
 *
 * @stability experimental
 */
export interface AskCommandOptions {
  /** The prefix of every message (`kvox-eval ask`, `ask:eval`). */
  name?: string;
  /** The usage text printed with a usage error and for `--help`. */
  usage?: string;
  /**
   * The default `--out` root: a run writes `<dir>/runs/<stamp>/` (the web app's
   * git-ignored `apps/api/.ask-eval/`). Default: none, and the output goes under
   * the system temporary directory.
   */
  syntheticRunsDir?: string | null;
}

/** A command line that cannot run; printed with the usage text. */
class UsageError extends Error {}

/** Flags `--replay` does not take: the replay's questions, model and gate are fixed. */
const LIVE_ONLY_FLAGS = ['provider', 'model', 'base-url', 'only', 'category', 'min-match'] as const;

/**
 * Runs `kvox-eval ask` with the given arguments (everything after `ask`).
 *
 * @example
 * ```ts
 * const code = await runAskCommand(['--replay'], { out: console.log, err: console.error, env: process.env });
 * ```
 *
 * @param argv - the arguments.
 * @param io - output streams and environment.
 * @param options - the host's name, usage text and runs directory.
 * @returns the exit code ({@link ASK_EVAL_EXIT}).
 * @stability experimental
 */
export async function runAskCommand(argv: string[], io: EvalCommandIo, options: AskCommandOptions = {}): Promise<number> {
  const name = options.name ?? 'kvox-eval ask';
  const usage = options.usage ?? ASK_COMMAND_USAGE;
  try {
    return await run(argv, io, options, name, usage);
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`${name}: ${err.message}`);
      io.err(usage);
      return ASK_EVAL_EXIT.config;
    }
    if (err instanceof AskEvalQuestionLoadError || err instanceof KgEvalLoadError || err instanceof LiveProviderError) {
      io.err(`${name}: ${err.message}`);
      return ASK_EVAL_EXIT.config;
    }
    throw err;
  }
}

async function run(argv: string[], io: EvalCommandIo, options: AskCommandOptions, name: string, usage: string): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        provider: { type: 'string' },
        model: { type: 'string' },
        'base-url': { type: 'string' },
        only: { type: 'string' },
        category: { type: 'string' },
        out: { type: 'string' },
        'min-match': { type: 'string' },
        replay: { type: 'boolean' },
        help: { type: 'boolean' },
      },
    }));
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const str = (k: string) => (typeof values[k] === 'string' ? (values[k] as string) : undefined);

  if (values.help) {
    io.out(usage);
    return ASK_EVAL_EXIT.ok;
  }

  const log = (line: string) => io.err(`${name}: ${line}`);

  if (values.replay) {
    const extra = LIVE_ONLY_FLAGS.filter((flag) => values[flag] !== undefined);
    if (extra.length > 0) throw new UsageError(`--replay takes no ${extra.map((f) => `--${f}`).join(', ')}`);
    return replay(io, log, outDirFor(str('out'), options));
  }

  const minMatchArg = str('min-match');
  const minMatch = minMatchArg !== undefined ? Number(minMatchArg) : 0.8;
  if (!Number.isFinite(minMatch) || minMatch < 0 || minMatch > 1) throw new UsageError('--min-match must be a number between 0 and 1');

  // The provider is refused (copilot, an unknown id) before the key is looked for,
  // and the key gate runs before anything is loaded or started: a run with no key
  // is a configuration error, not a run that seeds a graph and then fails.
  const provider = str('provider') ?? 'openai';
  assertLiveProvider(provider);
  const model = str('model') ?? DEFAULT_ASK_EVAL_MODEL;
  const key = readEvalApiKey(io.env, io.err);
  if (key === null && provider === 'openai') {
    io.err(`${name}: reads its API key from ${KVOX_EVAL_API_KEY_ENV}; it is not set`);
    return ASK_EVAL_EXIT.config;
  }
  const baseUrl = str('base-url');
  const { ai, failures } = createLiveKvoxAi({
    provider,
    model,
    apiKey: key?.apiKey ?? null,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  });

  const only = str('only')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const questions: AskEvalQuestion[] = selectAskEvalQuestions(loadGoldenAskQuestions(), only ?? null, str('category') ?? null);
  if (questions.length === 0) {
    io.err(`${name}: no questions selected`);
    return ASK_EVAL_EXIT.config;
  }
  // A malformed fixture is a configuration error (`KgEvalLoadError`), and must not seed a partial graph.
  const fixtures = loadGoldenSet();
  const outDir = outDirFor(str('out'), options);

  let result;
  try {
    result = await runAskEval({ ai, model, questions, fixtures, minMatch, log });
  } catch (err) {
    // A failure the run cannot go on from (a rate limit before any text, which
    // a queue would re-run later): reported by class, code and status only.
    if (err instanceof KvoxAiError || err instanceof KvoxRateLimitError) {
      reportFailures(failures, log);
      io.err(`${name}: the live call failed (${err instanceof KvoxAiError ? err.errorClass : 'rate_limit'}); the run stopped`);
      return ASK_EVAL_EXIT.config;
    }
    throw err;
  }
  reportFailures(failures, log);

  io.out(formatAskEvalReport(result.report));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(result.report, null, 2)}\n`);
  const answers = new Map(result.results.map((r) => [r.question.id, { question: r.question.question, content: r.message.content }]));
  writeFileSync(join(outDir, 'answers.md'), formatAnswersMarkdown(result.report, answers));
  log(`report written to ${outDir}`);

  // Not one turn reached the model: a configuration problem (a wrong key, model
  // or base URL), not a measurement.
  if (result.results.every((r) => r.modelError !== undefined)) {
    io.err(`${name}: every model call failed (${[...new Set(result.results.map((r) => r.modelError?.errorClass))].join(', ')}); check the key, model and base URL`);
    return ASK_EVAL_EXIT.config;
  }
  if (!result.report.gatesPassed || !result.report.answerMatchPassed) return ASK_EVAL_EXIT.failed;
  return ASK_EVAL_EXIT.ok;
}

/** `--out`, else `<runs dir>/runs/<stamp>`, else the system temporary directory. */
function outDirFor(out: string | undefined, options: AskCommandOptions): string {
  if (out) return resolve(out);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const root = options.syntheticRunsDir ?? join(tmpdir(), 'kvox-eval', 'ask');
  return join(root, 'runs', stamp);
}

/** How many provider round trips failed, by code and status (never a message body). */
function reportFailures(failures: readonly LiveCallFailure[], log: (line: string) => void): void {
  if (failures.length === 0) return;
  const counts = new Map<string, number>();
  for (const f of failures) {
    const label = `${f.code}${f.status !== null ? `, HTTP ${f.status}` : ''}`;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  log(`${failures.length} provider round trip(s) failed: ${[...counts].map(([l, n]) => `${n} x (${l})`).join('; ')}`);
}

/** `--replay`: the six scripted questions, one line each, then the gates; `replay.json` under `--out`. */
async function replay(io: EvalCommandIo, log: (line: string) => void, outDir: string): Promise<number> {
  const run = await runAskReplay({ log });
  io.out('Ask evaluation replay (scripted runtime, no model)');
  for (const r of run.results) {
    const tools = r.message.toolCalls.map((c) => c.name).join(' > ') || '-';
    const cites = r.message.citations.map((c) => `[^${c.marker}] ${c.valid ? 'valid' : 'INVALID'}`).join(', ') || 'none';
    const verdict = r.failures.length === 0 ? 'ok' : `FAILED: ${r.failures.join('; ')}`;
    io.out(`  ${r.scenario.id}  ${r.message.status}  tools: ${tools}  citations: ${cites}  validity ${r.citationValidity.toFixed(2)}  ${verdict}`);
  }
  io.out(`  leak gate: ${run.leakFree ? 'ok (the sensitive fact reached no request and no answer)' : 'FAILED'}`);
  io.out(run.passed ? 'replay passed' : 'replay FAILED');

  mkdirSync(outDir, { recursive: true });
  const summary = {
    passed: run.passed,
    leakFree: run.leakFree,
    scenarios: run.results.map((r) => ({
      id: r.scenario.id,
      title: r.scenario.title,
      status: r.message.status,
      toolCalls: r.message.toolCalls.map((c) => c.name),
      citations: r.message.citations.map((c) => ({ marker: c.marker, kind: c.kind, valid: c.valid })),
      citationValidity: r.citationValidity,
      failures: r.failures,
    })),
  };
  writeFileSync(join(outDir, 'replay.json'), `${JSON.stringify(summary, null, 2)}\n`);
  log(`replay summary written to ${outDir}`);
  return run.passed ? ASK_EVAL_EXIT.ok : ASK_EVAL_EXIT.failed;
}
