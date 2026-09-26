// =============================================================================
// The kg:eval runner seam (issue #362).
//
// A runner turns one fixture into one prediction. This issue ships the
// interface and an empty registry; the extraction runner (`extract`) lands
// with the kg.extract issue (#363), resolution extends it (`extract+resolve`,
// #364). A runner registers itself by adding an entry below from its own file
// (`scripts/kg-eval/runners/*.ts`) — a lazy factory, so the CLI never loads
// provider code for a `--predictions` run.
//
// The API key reaches a runner through `opts.apiKey` only; a runner must never
// log it or write it into a prediction (the prediction carries `model` alone).
// =============================================================================

import type { GoldenFixture } from './fixture-schema';
import type { KgEvalPrediction } from './prediction-schema';

export interface KgEvalRunOptions {
  model: string;
  apiKey: string;
}

export interface KgEvalRunner {
  /** 'extract' (#363), 'extract+resolve' (#364). */
  readonly name: string;
  run(fixture: GoldenFixture, opts: KgEvalRunOptions): Promise<KgEvalPrediction>;
}

/** Runners add entries; empty until the kg.extract issue registers `extract`. */
export const KG_EVAL_RUNNERS: Record<string, () => Promise<KgEvalRunner>> = {};

/** The environment variable a runner's API key is read from — never a flag. */
export const KG_EVAL_API_KEY_ENV = 'KG_EVAL_OPENAI_API_KEY';
