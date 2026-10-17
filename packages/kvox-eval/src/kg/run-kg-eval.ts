// =============================================================================
// runKgEval: one knowledge-graph evaluation run, start to report (issue #580)
// =============================================================================
//
// The one code path behind `kvox-eval kg`, `npm run kg:eval` and a host that
// calls the package directly. Three ways to get the predictions it scores:
//
//   gold             synthesised from the labels (`goldPrediction`): the
//                    harness's self-test, 1.000 everywhere or a bug;
//   predictionsDir   `<dir>/<fixtureId>.json` written by an earlier run (a
//                    missing file is scored as empty, and reported);
//   a live runner    `extract` / `extract+resolve` over the `ai` port, one
//                    structured call per fixture.
//
// PURE OF ENVIRONMENT: nothing here reads `process.env`, prints, or writes a
// file. A live run is handed a `KvoxAiPort` (the CLI builds one with
// `createLiveKvoxAi`, which owns the key); the hooks tell the caller about each
// prediction and each missing file, so the CLI can persist and print them.
// =============================================================================

import type { KvoxAiPort } from '@marinoscar/kvox-api/ports';

import type { GoldenFixture } from '../fixtures/index.js';
import { GOLDEN_MEETINGS_DIR, loadGoldenSet, selectFixtures } from '../fixtures/index.js';
import { goldPrediction } from './gold-runner.js';
import { emptyPrediction, kgEvalPredictionSchema, type KgEvalPrediction } from './prediction-schema.js';
import { loadPredictionFile } from './predictions.js';
import { buildReport, type KgEvalReport } from './report.js';
import { findKgEvalRunner, KG_EVAL_RUNNERS } from './runner.js';
import { scoreRun } from './scorer.js';

/**
 * What {@link runKgEval} is asked to do.
 *
 * @stability experimental
 */
export interface RunKgEvalOptions {
  /**
   * Where predictions come from: `gold` (the default when no `predictionsDir` is
   * given), or a registered live runner (`extract`, `extract-resolve` /
   * `extract+resolve`, or a test's own), which needs `ai` and `model`.
   */
  runner?: string;
  /** Score the prediction files of this directory instead of running anything. */
  predictionsDir?: string;
  /** The model port a live runner calls. Never needed for `gold` or `predictionsDir`. */
  ai?: KvoxAiPort;
  /** The model a live runner targets (required for one). */
  model?: string;
  /** The provider a live runner targets. Default `openai`. */
  provider?: string;
  /** Fixture ids to keep (`--only`); omitted or empty keeps all. */
  fixtures?: readonly string[];
  /** A tag every kept fixture carries (`--tag`). */
  tag?: string;
  /** Throw {@link KgEvalTargetsError} when a §6 target fails. Default `false` (report only). */
  enforce?: boolean;
  /** The directory the golden set is read from. Default the committed synthetic set. */
  fixturesDir?: string;
  /** Called with every prediction a live runner produced, in fixture order (the CLI writes it to `--out`). */
  onPrediction?: (fixtureId: string, prediction: KgEvalPrediction) => void | Promise<void>;
  /** Called for every fixture a `predictionsDir` has no file for (scored as empty). */
  onMissingPrediction?: (fixtureId: string, dir: string) => void;
}

/**
 * A run asked to enforce the §6 targets missed one. Carries the full report.
 *
 * @stability experimental
 */
export class KgEvalTargetsError extends Error {
  /**
   * @param report - the run's report (`targetsMet` is `false`).
   */
  constructor(readonly report: KgEvalReport) {
    super('one or more §6 targets failed (--enforce)');
  }
}

/**
 * A run that cannot start: no runner of that name, a live runner without a model
 * or a port, both a runner and a predictions directory, an empty selection. The
 * CLI maps it to exit code 2.
 *
 * @stability experimental
 */
export class KgEvalUsageError extends Error {}

/**
 * Runs one knowledge-graph evaluation and returns its report.
 *
 * @example
 * ```ts
 * const report = await runKgEval({ runner: 'gold' });
 * report.targetsMet; // true: the self-test scores 1.000 everywhere
 *
 * const live = await runKgEval({ runner: 'extract', ai, model: 'gpt-5-mini', fixtures: ['m01'] });
 * ```
 *
 * @param opts - what to score and how.
 * @returns the report (`formatReport` prints it).
 * @throws {@link KgEvalUsageError} for a run that cannot start; `KgEvalLoadError`
 *   for a golden set or prediction file that does not load; {@link KgEvalTargetsError}
 *   with `enforce` when a target fails. A live call's failure is the port's
 *   `KvoxAiError`, which carries no key.
 * @stability experimental
 */
export async function runKgEval(opts: RunKgEvalOptions = {}): Promise<KgEvalReport> {
  const predictionsDir = opts.predictionsDir;
  const runnerArg = opts.runner ?? (predictionsDir === undefined ? 'gold' : undefined);
  if (predictionsDir !== undefined && runnerArg !== undefined) {
    throw new KgEvalUsageError('pass either a predictions directory or a runner, not both');
  }

  // An unregistered runner is reported before anything is loaded.
  const live = runnerArg !== undefined && runnerArg !== 'gold' ? findKgEvalRunner(runnerArg) : null;
  if (runnerArg !== undefined && runnerArg !== 'gold' && live === null) {
    throw new KgEvalUsageError(`no runner '${runnerArg}' registered (known: ${Object.keys(KG_EVAL_RUNNERS).join(', ')})`);
  }
  if (live !== null && !opts.model) throw new KgEvalUsageError(`the '${live.name}' runner needs a model`);
  if (live !== null && opts.ai === undefined) throw new KgEvalUsageError(`the '${live.name}' runner needs a model port (ai)`);

  const fixtures = selectedFixtures(opts);
  const predictions = new Map<string, KgEvalPrediction>();
  let runnerLabel: string;
  let model: string | null = null;

  if (live !== null) {
    model = opts.model as string;
    const runner = await live.factory({ ai: opts.ai as KvoxAiPort });
    runnerLabel = runner.name;
    for (const fixture of fixtures) {
      const pred = kgEvalPredictionSchema.parse(
        await runner.run(fixture, { model, ...(opts.provider !== undefined ? { provider: opts.provider } : {}) }),
      );
      predictions.set(fixture.id, pred);
      await opts.onPrediction?.(fixture.id, pred);
    }
  } else if (predictionsDir === undefined) {
    runnerLabel = 'gold';
    for (const f of fixtures) predictions.set(f.id, goldPrediction(f));
  } else {
    runnerLabel = 'predictions';
    for (const f of fixtures) {
      const pred = loadPredictionFile(predictionsDir, f.id);
      if (pred === null) opts.onMissingPrediction?.(f.id, predictionsDir);
      predictions.set(f.id, pred ?? emptyPrediction(f.id));
      model ??= pred?.model ?? null;
    }
  }

  const report = buildReport(scoreRun(fixtures, predictions), {
    runner: runnerLabel,
    model,
    fixtureIds: fixtures.map((f) => f.id),
  });
  if (opts.enforce && !report.targetsMet) throw new KgEvalTargetsError(report);
  return report;
}

/** The golden set narrowed by `fixtures` and `tag`; an empty selection is a usage error. */
function selectedFixtures(opts: RunKgEvalOptions): GoldenFixture[] {
  const all = loadGoldenSet(opts.fixturesDir ?? GOLDEN_MEETINGS_DIR);
  const only = opts.fixtures && opts.fixtures.length > 0 ? [...opts.fixtures] : null;
  const selected = selectFixtures(all, only, opts.tag ?? null);
  if (selected.length === 0) throw new KgEvalUsageError('no fixtures selected');
  return selected;
}

