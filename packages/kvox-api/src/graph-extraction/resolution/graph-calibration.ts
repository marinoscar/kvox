// =============================================================================
// Per-model graph calibration (#681; docs/specs/ontology.md §7)
// =============================================================================
//
// Entity resolution and item dedup compare embedding COSINES against fixed
// cut-offs. Those cut-offs were tuned to OpenAI text-embedding-3-small, whose
// unrelated texts sit low. A bge-style model sits much higher for the same pairs,
// so the same numbers would auto-link and merge things that are only topically
// close. The cut-offs therefore belong to the embedding MODEL: the host records
// them on its catalog entry (`KvoxEmbeddingModel.graphCalibration` of
// `@marinoscar/kvox-ai`), they travel on `capabilities().embeddings`, and the
// graph reads them here instead of from constants.
//
// A model that records none gets the numbers below: the OpenAI baseline, so the
// web edition behaves exactly as before.
//
// Only COSINES are calibrated. The user-facing preferences (`autoLinkThreshold`,
// `newThreshold`) are thresholds on the final resolution SCORE and stay the user's
// choice; the model changes only how a cosine becomes score evidence.
//
// PURE: no Nest, no Prisma.
// =============================================================================

import type { KvoxGraphCalibration } from '../../ports/index.js';

/**
 * The cosine cut-offs the graph decides with for one embedding model.
 *
 * @stability experimental
 */
export type GraphCalibration = KvoxGraphCalibration;

/**
 * The OpenAI text-embedding-3-small cut-offs the graph was tuned with (the web edition's model).
 *
 * @stability experimental
 */
export const DEFAULT_GRAPH_CALIBRATION: Readonly<GraphCalibration> = Object.freeze({
  vectorFloor: 0.75,
  itemCosine: 0.8,
  itemSameConfidentCosine: 0.92,
});

/**
 * The calibration to use for a model's reported one: the model's own when it is
 * complete and sane, else the OpenAI baseline.
 *
 * @param reported - `capabilities().embeddings.graphCalibration`, when the host names one.
 * @stability experimental
 */
export function resolveGraphCalibration(reported?: Partial<GraphCalibration> | null): GraphCalibration {
  if (!reported) return { ...DEFAULT_GRAPH_CALIBRATION };
  const { vectorFloor, itemCosine, itemSameConfidentCosine } = reported;
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0 && n < 1;
  if (!ok(vectorFloor) || !ok(itemCosine) || !ok(itemSameConfidentCosine) || itemSameConfidentCosine < itemCosine) {
    return { ...DEFAULT_GRAPH_CALIBRATION };
  }
  return { vectorFloor, itemCosine, itemSameConfidentCosine };
}
