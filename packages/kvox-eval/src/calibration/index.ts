// The calibration slice's public surface (re-exported by the package root).
export {
  CALIBRATION_PAIRS_PATH,
  CalibrationSetError,
  buildCalibrationSet,
  calibrationTexts,
  loadHandPairs,
} from './calibration-set.js';
export type { CalibrationSet, CalibrationSetOptions, EntityPair, ItemPair } from './calibration-set.js';
export { CALIBRATE_COMMAND_USAGE, runCalibrateCommand } from './calibrate-command.js';
export type { CalibrateCommandIo } from './calibrate-command.js';
export { hashedNgramVectors, recordedVectors } from './embedders.js';
export type { HashedNgramOptions, VectorTable } from './embedders.js';
export { evaluateModel, recommendedCalibration } from './evaluate.js';
export type { Calibration, DecisionSummary, EvaluateOptions, ModelCalibrationReport } from './evaluate.js';
export {
  cosine,
  defaultThresholds,
  highestThresholdWithRecall,
  lowestThresholdWithPrecision,
  mapCutoffByHeadroom,
  sweep,
  pgTrigramSimilarity,
} from './metrics.js';
export type { Sample, ThresholdPoint, UnrelatedCeilings } from './metrics.js';
export { formatCalibrationReport } from './report.js';
