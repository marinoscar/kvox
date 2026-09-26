// =============================================================================
// ask:eval — evaluate the Ask agent against its golden question set (issue #382)
// =============================================================================
//
//   npm run ask:eval --workspace=api -- --model gpt-4o-mini
//   npm run ask:eval --workspace=api -- --only q01,q22 --model gpt-4o-mini
//   npm run ask:eval --workspace=api -- --category negative --model gpt-4o-mini
//   npm run ask:eval --workspace=api -- --keep --model gpt-4o-mini
//
// Seeds #362's gold graph under a throwaway user in the CURRENT database
// (never against real data — CLAUDE.md's "synthetic fixtures only, ever"),
// runs every selected question through the real `ask.respond` handler on a
// real Nest application context, scores each answer, prints the table, and
// writes `report.json`/`answers.md` under a git-ignored directory.
//
// The API key comes ONLY from `ASK_EVAL_OPENAI_API_KEY` (never a flag) and is
// stored ONLY on the throwaway user, removed at teardown.
//
// Exit codes: 0 pass · 1 a gate failed (citation validity < 1, a sensitive
// leak) or answer match fell below `--min-match` · 2 configuration error (no
// key, an unsafe database).
// =============================================================================

import { mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { parseArgs } from 'util';

import { loadGoldenSet } from './kg-eval/load';
import { formatAnswersMarkdown, buildAskEvalReport, formatAskEvalReport } from './ask-eval/report';
import {
  loadAskEvalQuestions,
  selectAskEvalQuestions,
  AskEvalQuestionLoadError,
} from './ask-eval/question-schema';
import { ASK_EVAL_API_KEY_ENV, DEFAULT_ASK_EVAL_MODEL, runAskEval } from './ask-eval/run';
import { scoreAnswer } from './ask-eval/scorer';
import { UnsafeDatabaseError } from './ask-eval/seed-graph';

export const EXIT = { ok: 0, failed: 1, config: 2 } as const;

const QUESTIONS_PATH = resolve(__dirname, '../test/fixtures/kg-golden/ask-questions.json');

const USAGE = `usage: ask:eval --model <id> [--only q01,q07] [--category <c>] [--out <dir>]
               [--min-match <0..1>] [--keep] [--allow-db <name>]
       reads the API key from ${ASK_EVAL_API_KEY_ENV} (never a flag)`;

class UsageError extends Error {}

interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  env: NodeJS.ProcessEnv;
}

function defaultIo(): Io {
  return { out: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`), env: process.env };
}

export async function main(argv: string[], io: Io = defaultIo()): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        model: { type: 'string' },
        only: { type: 'string' },
        category: { type: 'string' },
        out: { type: 'string' },
        'min-match': { type: 'string' },
        keep: { type: 'boolean' },
        'allow-db': { type: 'string' },
        help: { type: 'boolean' },
      },
    }));
  } catch (err) {
    io.err(`ask:eval: ${(err as Error).message}`);
    io.err(USAGE);
    return EXIT.config;
  }

  if (values.help) {
    io.out(USAGE);
    return EXIT.ok;
  }

  const str = (k: string) => (typeof values[k] === 'string' ? (values[k] as string) : undefined);
  const model = str('model') ?? DEFAULT_ASK_EVAL_MODEL;
  const minMatchArg = str('min-match');
  const minMatch = minMatchArg !== undefined ? Number(minMatchArg) : 0.8;
  if (!Number.isFinite(minMatch) || minMatch < 0 || minMatch > 1) {
    io.err('ask:eval: --min-match must be a number between 0 and 1');
    io.err(USAGE);
    return EXIT.config;
  }

  // The key gate runs FIRST, and needs no database — a run with no key
  // configured is a configuration error, not a run that seeds a graph and
  // then fails partway through.
  const apiKey = io.env[ASK_EVAL_API_KEY_ENV];
  if (!apiKey) {
    io.err(`ask:eval: reads its API key from ${ASK_EVAL_API_KEY_ENV}; it is not set`);
    return EXIT.config;
  }

  let questions;
  try {
    const all = loadAskEvalQuestions(QUESTIONS_PATH);
    const only = str('only')
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    questions = selectAskEvalQuestions(all, only ?? null, str('category') ?? null);
  } catch (err) {
    if (err instanceof AskEvalQuestionLoadError) {
      io.err(`ask:eval: ${err.message}`);
      return EXIT.config;
    }
    throw err;
  }
  if (questions.length === 0) {
    io.err('ask:eval: no questions selected');
    return EXIT.config;
  }

  // `loadGoldenSet()` throws `KgEvalLoadError` on a malformed fixture — that
  // is a configuration error too, and must not seed a partial graph.
  try {
    loadGoldenSet();
  } catch (err) {
    io.err(`ask:eval: ${(err as Error).message}`);
    return EXIT.config;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = resolve(str('out') ?? join(__dirname, '../.ask-eval/runs', stamp));

  let handle;
  try {
    handle = await runAskEval({
      questions,
      model,
      apiKey,
      keep: Boolean(values.keep),
      allowDb: str('allow-db') ?? null,
    });
  } catch (err) {
    if (err instanceof UnsafeDatabaseError) {
      io.err(`ask:eval: ${err.message}`);
      return EXIT.config;
    }
    throw err;
  }

  try {
    const scores = handle.results.map((r) =>
      scoreAnswer(r.question, r.message, r.capturedPrompts, handle.idMap.evidenceSource, { ms: r.ms }),
    );
    const report = buildAskEvalReport(scores, { model, minMatch });
    io.out(formatAskEvalReport(report));

    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    const answers = new Map(handle.results.map((r) => [r.question.id, { question: r.question.question, content: r.message.content }]));
    writeFileSync(join(outDir, 'answers.md'), formatAnswersMarkdown(report, answers));
    io.err(`ask:eval: report written to ${outDir}`);

    if (!report.gatesPassed || !report.answerMatchPassed) return EXIT.failed;
    return EXIT.ok;
  } finally {
    await handle.teardown();
    await handle.close();
  }
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
