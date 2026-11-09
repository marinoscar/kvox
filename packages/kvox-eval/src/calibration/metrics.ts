// =============================================================================
// Calibration metrics (issue #681)
// =============================================================================
//
// PURE helpers: cosine, pg_trgm's similarity (the entity resolver's trigram arm),
// precision / recall over a threshold sweep, the three recommendation rules, and
// the headroom mapping that derives a first calibration for a model nobody has
// measured yet.
// =============================================================================

/**
 * Cosine similarity of two vectors (0 when either has no length).
 *
 * @stability experimental
 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function trigrams(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of text.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i += 1) out.add(padded.slice(i, i + 3));
  }
  return out;
}

/**
 * `pg_trgm`'s `similarity()`: the Jaccard index of the two texts' trigram sets (words padded
 * with two leading spaces and one trailing).
 *
 * @stability experimental
 */
export function pgTrigramSimilarity(a: string, b: string): number {
  const x = trigrams(a);
  const y = trigrams(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const t of x) if (y.has(t)) shared += 1;
  return shared / (x.size + y.size - shared);
}

/**
 * One labelled observation: a score and whether the pair is a true match.
 *
 * @stability experimental
 */
export interface Sample {
  /** The similarity or score the decision compares to a threshold. */
  score: number;
  /** True when the pair really is a match. */
  positive: boolean;
}

/**
 * Precision and recall of `score >= threshold` at one threshold.
 *
 * @stability experimental
 */
export interface ThresholdPoint {
  /** The threshold. */
  threshold: number;
  /** Positives at or above it. */
  tp: number;
  /** Negatives at or above it. */
  fp: number;
  /** Positives below it. */
  fn: number;
  /** Negatives below it. */
  tn: number;
  /** `tp / (tp + fp)`; null when nothing is at or above the threshold. */
  precision: number | null;
  /** `tp / (tp + fn)`; null when the set has no positive. */
  recall: number | null;
}

/**
 * The thresholds a sweep tries by default: 0.30 to 0.99 in steps of 0.01.
 *
 * @stability experimental
 */
export function defaultThresholds(): number[] {
  return Array.from({ length: 70 }, (_, i) => Math.round((0.3 + i * 0.01) * 100) / 100);
}

/**
 * Precision and recall at each threshold.
 *
 * @param samples - the labelled observations.
 * @param thresholds - the thresholds to try, ascending.
 * @returns one point per threshold.
 * @stability experimental
 */
export function sweep(samples: readonly Sample[], thresholds: readonly number[] = defaultThresholds()): ThresholdPoint[] {
  const positives = samples.filter((s) => s.positive).length;
  return thresholds.map((threshold) => {
    let tp = 0;
    let fp = 0;
    for (const s of samples) {
      if (s.score >= threshold) {
        if (s.positive) tp += 1;
        else fp += 1;
      }
    }
    return {
      threshold,
      tp,
      fp,
      fn: positives - tp,
      tn: samples.length - positives - fp,
      precision: tp + fp === 0 ? null : tp / (tp + fp),
      recall: positives === 0 ? null : tp / positives,
    };
  });
}

/**
 * The lowest threshold whose precision is at least `minPrecision` and that still keeps a positive
 * (a precise threshold that finds nothing is not a recommendation). Null when none does.
 *
 * @stability experimental
 */
export function lowestThresholdWithPrecision(points: readonly ThresholdPoint[], minPrecision: number): number | null {
  const hit = points.find((p) => p.precision !== null && p.precision >= minPrecision && p.tp > 0);
  return hit ? hit.threshold : null;
}

/**
 * The highest threshold whose recall is at least `minRecall`: the strictest gate that still lets
 * nearly every true match through. Null when none does.
 *
 * @stability experimental
 */
export function highestThresholdWithRecall(points: readonly ThresholdPoint[], minRecall: number): number | null {
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const r = points[i].recall;
    if (r !== null && r >= minRecall) return points[i].threshold;
  }
  return null;
}

/**
 * Where a model's unrelated texts sit: the cosine ceiling of unrelated pairs (e.g. 0.35 for OpenAI
 * text-embedding-3-small, 0.55 for bge-small-en-v1.5).
 *
 * @stability experimental
 */
export interface UnrelatedCeilings {
  /** The ceiling for the model the cut-offs were tuned to. */
  from: number;
  /** The ceiling for the model being calibrated. */
  to: number;
}

/**
 * Maps one cut-off tuned to a baseline model onto another model by keeping the SAME FRACTION of
 * headroom above the unrelated ceiling, rounded UP to the next 0.01 (too high costs a missed link
 * a person can confirm; too low merges two things that are only topically close).
 *
 * @example
 * `mapCutoffByHeadroom(0.8, { from: 0.35, to: 0.55 })` is `0.87`.
 *
 * @param cutoff - the cut-off tuned to the baseline model.
 * @param ceilings - the unrelated-pair ceilings of the two models.
 * @returns the cut-off for the other model, in (0, 1).
 * @stability experimental
 */
export function mapCutoffByHeadroom(cutoff: number, ceilings: UnrelatedCeilings): number {
  const { from, to } = ceilings;
  const fraction = (cutoff - from) / (1 - from);
  const mapped = to + fraction * (1 - to);
  return Math.min(0.99, Math.ceil(mapped * 100 - 1e-9) / 100);
}
