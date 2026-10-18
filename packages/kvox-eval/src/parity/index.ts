/**
 * `@marinoscar/kvox-eval/parity`: the harness-parity scenario.
 *
 * @remarks
 * For the same input, two bindings of the model port (the web edition's, KVox
 * Desktop's) must build byte-identical provider requests: system prompt, user
 * prompt or input, JSON Schema, tool definitions, model, reasoning effort and output
 * ceiling. `runParityScenario` drives the product's own notes, extraction,
 * adjudication and Ask code through a port; the committed snapshots
 * (`parity/requests.*.json`) are what each binding's recording must equal.
 *
 * @packageDocumentation
 */
export {
  PARITY_DEFAULT_EFFORT,
  PARITY_DEFAULT_MODEL,
  PARITY_MODELS,
  PARITY_PROVIDER,
  PARITY_TASK_MODELS,
  PARITY_USER_ID,
  parityModelState,
  parityTaskModelSource,
} from './constants.js';
export type { ParityModel } from './constants.js';
export { PARITY_FIXTURES, PARITY_QUESTIONS, runParityScenario } from './scenario.js';
export type { ParityScenarioOptions } from './scenario.js';
export { createParityScript, goldExtractionAnswer } from './script.js';
export type { ParityScript } from './script.js';
export {
  PARITY_ASK_SNAPSHOT,
  PARITY_SNAPSHOT_DIR,
  loadParitySnapshot,
  paritySnapshotPath,
  writeParitySnapshot,
} from './snapshot.js';
