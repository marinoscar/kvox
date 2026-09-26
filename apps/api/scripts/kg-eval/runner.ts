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

/**
 * Runners add entries — lazy factories, so a `--predictions` run never loads
 * provider code. `extract` is kg.extract's own pipeline (#363).
 */
export const KG_EVAL_RUNNERS: Record<string, () => Promise<KgEvalRunner>> = {
  // `require`, not `import()`: under NodeNext a dynamic import stays a native
  // ESM import, which cannot load a `.ts` file through ts-node.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  extract: async () => (require('./runners/extract-runner') as typeof import('./runners/extract-runner')).createExtractRunner(),
};

/** The environment variable a runner's API key is read from — never a flag. */
export const KG_EVAL_API_KEY_ENV = 'KG_EVAL_OPENAI_API_KEY';
