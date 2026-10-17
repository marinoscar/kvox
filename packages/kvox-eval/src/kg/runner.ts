// =============================================================================
// The kg:eval runner seam (issue #362; #580 moved it onto the model port).
//
// A runner turns one fixture into one prediction. The extraction runner
// (`extract`) is kg.extract's own pipeline (#363); resolution extends it
// (`extract+resolve`, #364). A runner registers itself by adding an entry below
// from its own file (`kg/runners/*.ts`) — a lazy factory, so a `--predictions`
// run never loads the extraction code.
//
// #580: a runner is built over a `KvoxAiPort` (`createKvoxAi` of
// `@marinoscar/kvox-ai`, or a fake in a test) and never sees a key. Whoever
// builds the port owns the key (`live/`: the environment, never a flag); a
// prediction carries `model` alone.
// =============================================================================

import type { KvoxAiPort } from '@marinoscar/kvox-api/ports';

import type { GoldenFixture } from '../fixtures/index.js';
import type { KgEvalPrediction } from './prediction-schema.js';

/**
 * What one live run is made with.
 *
 * @stability experimental
 */
export interface KgEvalRunOptions {
  /** The provider's model id. */
  model: string;
  /** The provider id the call targets (`openai`, `openai-compatible`). Default `openai`. */
  provider?: string;
}

/**
 * What a runner factory is handed.
 *
 * @stability experimental
 */
export interface KgEvalRunnerDeps {
  /** The model port every structured call goes through. */
  ai: KvoxAiPort;
}

/**
 * Turns one golden fixture into one prediction.
 *
 * @extensionPoint
 * @stability experimental
 */
export interface KgEvalRunner {
  /** `extract` (#363), `extract+resolve` (#364): the report's `runner` column. */
  readonly name: string;
  /**
   * One fixture's prediction.
   *
   * @param fixture - the fixture.
   * @param opts - the model (and provider) to run on.
   * @returns the prediction (it carries `model`, never a key).
   */
  run(fixture: GoldenFixture, opts: KgEvalRunOptions): Promise<KgEvalPrediction>;
}

/**
 * A lazy runner factory.
 *
 * @stability experimental
 */
export type KgEvalRunnerFactory = (deps: KgEvalRunnerDeps) => Promise<KgEvalRunner>;

/**
 * The registered runners, by name. Lazy factories, so a `--predictions` run never
 * loads the extraction code. A test may add an entry (and delete it afterwards).
 *
 * @stability experimental
 */
export const KG_EVAL_RUNNERS: Record<string, KgEvalRunnerFactory> = {
  // `require`, not `import()`: under NodeNext a dynamic import stays a native
  // ESM import, which cannot load a `.ts` file through ts-node or ts-jest.
  extract: async (deps) => (require('./runners/extract-runner.js') as typeof import('./runners/extract-runner.js')).createExtractRunner(deps),
  // #364: extraction, then in-memory resolution against `knownEntities`.
  'extract+resolve': async (deps) =>
    (require('./runners/extract-resolve-runner.js') as typeof import('./runners/extract-resolve-runner.js')).createExtractResolveRunner(deps),
};

/**
 * Spellings a command line accepts for a registered runner (`extract-resolve`,
 * a shell-friendly `extract+resolve`).
 *
 * @stability experimental
 */
export const KG_EVAL_RUNNER_ALIASES: Readonly<Record<string, string>> = Object.freeze({ 'extract-resolve': 'extract+resolve' });

/**
 * The registered runner a name (or an alias) means, or `null`.
 *
 * @param name - a runner name or alias.
 * @returns the factory and the registered name, or `null` when none is registered.
 * @stability experimental
 */
export function findKgEvalRunner(name: string): { name: string; factory: KgEvalRunnerFactory } | null {
  const registered = Object.prototype.hasOwnProperty.call(KG_EVAL_RUNNER_ALIASES, name) ? KG_EVAL_RUNNER_ALIASES[name] : name;
  if (!Object.prototype.hasOwnProperty.call(KG_EVAL_RUNNERS, registered)) return null;
  return { name: registered, factory: KG_EVAL_RUNNERS[registered] };
}
