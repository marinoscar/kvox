// The kg slice's public surface (re-exported by the package root).
export { goldPrediction } from './gold-runner.js';
export {
  emptyPrediction,
  kgEvalPredictionSchema,
  predictedEntitySchema,
  predictedEvidenceSchema,
  predictedItemSchema,
  predictedRelationSchema,
  predictedResolutionSchema,
} from './prediction-schema.js';
export type {
  KgEvalPrediction,
  KgEvalPredictionInput,
  PredictedEntity,
  PredictedEvidence,
  PredictedItem,
  PredictedRelation,
} from './prediction-schema.js';
export { loadPredictionFile } from './predictions.js';
export { buildReport, formatReport, kgEvalReportSchema } from './report.js';
export type { KgEvalReport } from './report.js';
export { KgEvalTargetsError, KgEvalUsageError, runKgEval } from './run-kg-eval.js';
export type { RunKgEvalOptions } from './run-kg-eval.js';
export { findKgEvalRunner, KG_EVAL_RUNNER_ALIASES, KG_EVAL_RUNNERS } from './runner.js';
export type { KgEvalRunner, KgEvalRunnerDeps, KgEvalRunnerFactory, KgEvalRunOptions } from './runner.js';
export {
  autoLinkPrecision,
  BASE_REPORT_TYPES,
  commitmentRecall,
  ENTITY_MATCH_JACCARD,
  ENTITY_REPORT_TYPES,
  entityCoverage,
  f1Of,
  ITEM_REPORT_TYPES,
  ITEM_STATEMENT_F1,
  matchEntities,
  precisionOf,
  ratio,
  recallOf,
  scoreFixture,
  scoreRun,
  temporalEqual,
} from './scorer.js';
export type { Counts, FixtureScore, RunScore } from './scorer.js';
export { KG_EVAL_TARGETS } from './targets.js';
export type { KgEvalTargetKey } from './targets.js';
export { collapseWhitespace, jaccard, normalizeName, quoteFoundIn, tokenF1, tokenSet } from './text.js';
export {
  EVAL_CONTEXT_WINDOW_TOKENS,
  EVAL_MAX_OUTPUT_TOKENS,
  EVAL_TIMEOUT_MS,
  EVAL_USER_ID,
  createExtractRunner,
} from './runners/extract-runner.js';
export { createExtractResolveRunner, trigramSimilarity } from './runners/extract-resolve-runner.js';
