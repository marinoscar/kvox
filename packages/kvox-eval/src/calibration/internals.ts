// =============================================================================
// The slices' internals the calibration harness replays (issue #681)
// =============================================================================
//
// Same rule as `kg/internals.ts`: the one place this slice names a function that
// `@marinoscar/kvox-api` keeps internal (tagged `@internal`, no stability
// promise). The harness replays the product's OWN scorer and dedup functions, so
// a change to either shows in its report. NOT EXPORTED from the package.
// =============================================================================

import { internals as extractionInternals } from '@marinoscar/kvox-api/graph-extraction/testing';

export const {
  DEFAULT_GRAPH_CALIBRATION,
  bandFor,
  buildEntityProfileText,
  buildItemProfileText,
  mapItemVerdicts,
  normalizeForMatch,
  resolveGraphCalibration,
  scoreCandidate,
  selectCandidates,
} = extractionInternals;
