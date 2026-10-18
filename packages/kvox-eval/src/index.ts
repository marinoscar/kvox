/**
 * `@marinoscar/kvox-eval`: the KVox knowledge-graph and Ask evaluation.
 *
 * @remarks
 * Written only against the model port (`KvoxAiPort` of `@marinoscar/kvox-api/ports`,
 * bound with `createKvoxAi` of `@marinoscar/kvox-ai`), so the web edition and KVox
 * Desktop measure the same prompts, schemas and validators the product ships.
 * Slices: `kg` (prediction schema, scorer, report, the gold and live runners,
 * `runKgEval`), `ask` (the Ask question schema, scorer and report), `live` (the key
 * from the environment and the live port over the provider adapters),
 * `real-data` (the guard that keeps real meetings out of the repository) and `cli`
 * (`kvox-eval`). The golden set is the `@marinoscar/kvox-eval/fixtures` entry.
 *
 * @packageDocumentation
 */
export * from './ask/index.js';
export * from './ask-run/index.js';
export * from './cli/index.js';
export * from './kg/index.js';
export * from './live/index.js';
export * from './real-data/index.js';
