// =============================================================================
// Measuring one embedding model on the calibration set (issue #681)
// =============================================================================
//
// For one model's vectors:
//
//   1. every pair's cosine, split into positives (same entity / duplicate fact) and
//      negatives;
//   2. a threshold sweep (precision and recall per cosine) for the entity pairs and the
//      item pairs;
//   3. the DECISIONS the product makes with a calibration, replayed through the product's
//      own functions (`scoreCandidate` + `bandFor` for entities; `selectCandidates` +
//      `mapItemVerdicts` for items), so a change to either shows here;
//   4. a recommended calibration, by three stated rules.
//
// The recommendation rules (and why):
//
//   vectorFloor              the LOWEST entity cosine whose precision is >= minPrecision
//                            (default 0.95). Below it a cosine says nothing a person
//                            would trust, so it must not count as evidence.
//   itemCosine               the HIGHEST item cosine whose recall is >= minRecall (default
//                            0.95). It only gates who is shown to the adjudicator, so it
//                            must let nearly every true duplicate through and cut the noise.
//   itemSameConfidentCosine  the LOWEST item cosine whose precision is >= confidentPrecision
//                            (default 0.99), floored at itemCosine. Above it a `same` verdict
//                            is trusted without a `possible_duplicate` flag.
//
// With too little data for a rule (no threshold reaches the target) the field is null and
// the model keeps its current value: the report says so rather than inventing a number.
// =============================================================================

import {
  DEFAULT_GRAPH_CALIBRATION,
  bandFor,
  mapItemVerdicts,
  resolveGraphCalibration,
  scoreCandidate,
  selectCandidates,
  normalizeForMatch,
} from './internals.js';
import { entityText, itemText, type CalibrationSet } from './calibration-set.js';
import type { VectorTable } from './embedders.js';
import {
  cosine,
  highestThresholdWithRecall,
  lowestThresholdWithPrecision,
  sweep,
  pgTrigramSimilarity,
  type Sample,
  type ThresholdPoint,
} from './metrics.js';

/**
 * The cosine cut-offs the graph decides with.
 *
 * @stability experimental
 */
export interface Calibration {
  /** Entity resolution: where vector evidence starts to count. */
  vectorFloor: number;
  /** Item dedup: the cosine a candidate needs to be adjudicated. */
  itemCosine: number;
  /** Item dedup: the cosine above which a `same` verdict is not flagged. */
  itemSameConfidentCosine: number;
}

/**
 * Options of {@link evaluateModel}.
 *
 * @stability experimental
 */
export interface EvaluateOptions {
  /** The calibration whose decisions are replayed (default: the OpenAI baseline). */
  calibration?: Calibration;
  /** The user preferences the entity decisions use (defaults 0.9 and 0.55). */
  preferences?: { autoLinkThreshold: number; newThreshold: number };
  /** Entity rule: the precision the vector floor must reach (default 0.95). */
  minPrecision?: number;
  /** Item rule: the recall the candidate cosine must keep (default 0.95). */
  minRecall?: number;
  /** Item rule: the precision a confident `same` must reach (default 0.99). */
  confidentPrecision?: number;
}

/**
 * Counts and rates of one decision over the labelled pairs.
 *
 * @stability experimental
 */
export interface DecisionSummary {
  /** Pairs the decision fired on. */
  fired: number;
  /** True matches among them. */
  tp: number;
  /** False matches among them. */
  fp: number;
  /** True matches it missed. */
  fn: number;
  /** `tp / fired`; null when it never fired. */
  precision: number | null;
  /** `tp / positives`; null when the set has no positive. */
  recall: number | null;
}

function summarize(decisions: ReadonlyArray<{ fired: boolean; positive: boolean }>): DecisionSummary {
  const positives = decisions.filter((d) => d.positive).length;
  const fired = decisions.filter((d) => d.fired);
  const tp = fired.filter((d) => d.positive).length;
  return {
    fired: fired.length,
    tp,
    fp: fired.length - tp,
    fn: positives - tp,
    precision: fired.length === 0 ? null : tp / fired.length,
    recall: positives === 0 ? null : tp / positives,
  };
}

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/**
 * One model's measurements.
 *
 * @stability experimental
 */
export interface ModelCalibrationReport {
  /** The embedding model id. */
  model: string;
  /** The calibration whose decisions were replayed. */
  calibration: Calibration;
  /** Pairs skipped because a text had no vector. */
  missingVectors: number;
  /** Entity-name pairs. */
  entities: {
    pairs: number;
    positives: number;
    /** Precision and recall of `cosine >= t`. */
    cosineSweep: ThresholdPoint[];
    /** Cosine of the negatives: 95th percentile and maximum (where unrelated texts sit). */
    negativeCosineP95: number | null;
    negativeCosineMax: number | null;
    /** Pairs the full score puts at or above `newThreshold` (surfaced to adjudication or linked). */
    surfaced: DecisionSummary;
    /** Pairs the full score puts at or above `autoLinkThreshold` (linked without a person), with no context boost. */
    autoLinked: DecisionSummary;
    /**
     * The same, in the best case for linking: the mention shares a meeting and an organization with
     * the candidate (+0.20). The vector arm alone tops out at 0.60 + 0.27, below the 0.90 auto-link preference, and so never links
     * by itself; this shows what the name arms link, and that a calibration does not change it.
     */
    autoLinkedBestContext: DecisionSummary;
  };
  /** Statement pairs. */
  items: {
    pairs: number;
    positives: number;
    cosineSweep: ThresholdPoint[];
    negativeCosineP95: number | null;
    negativeCosineMax: number | null;
    /** Pairs `selectCandidates` keeps for adjudication. */
    candidates: DecisionSummary;
    /** Pairs a `same` verdict would leave unflagged (the auto-merge path). */
    confident: DecisionSummary;
  };
  /** The rules' answers; null where no threshold reached the target. */
  recommended: { vectorFloor: number | null; itemCosine: number | null; itemSameConfidentCosine: number | null };
}

/**
 * Measures one model.
 *
 * @param model - the embedding model id.
 * @param set - the labelled pairs.
 * @param vectors - a vector per text of {@link calibrationTexts}.
 * @param options - the calibration to replay and the rule targets.
 * @returns the report.
 * @stability experimental
 */
export function evaluateModel(
  model: string,
  set: CalibrationSet,
  vectors: VectorTable,
  options: EvaluateOptions = {},
): ModelCalibrationReport {
  const calibration = options.calibration ?? { ...DEFAULT_GRAPH_CALIBRATION };
  const prefs = options.preferences ?? { autoLinkThreshold: 0.9, newThreshold: 0.55 };
  const minPrecision = options.minPrecision ?? 0.95;
  const minRecall = options.minRecall ?? 0.95;
  const confidentPrecision = options.confidentPrecision ?? 0.99;
  let missing = 0;

  // --- entities --------------------------------------------------------------
  const entitySamples: Sample[] = [];
  const entityDecisions: Array<{ surfaced: boolean; autoLinked: boolean; autoLinkedBest: boolean; positive: boolean }> = [];
  for (const p of set.entityPairs) {
    const va = vectors.get(entityText(p.type, p.a));
    const vb = vectors.get(entityText(p.type, p.b));
    if (!va || !vb) {
      missing += 1;
      continue;
    }
    const cos = cosine(va, vb);
    entitySamples.push({ score: cos, positive: p.same });
    const na = normalizeForMatch(p.a);
    const nb = normalizeForMatch(p.b);
    const features = { aliasExact: na === nb, trigram: pgTrigramSimilarity(na, nb), cosine: cos, sameMeeting: false, orgCoMention: false, sharedNeighbour: false, recent: false };
    const band = bandFor(scoreCandidate(features, calibration.vectorFloor).score, prefs);
    const best = bandFor(scoreCandidate({ ...features, sameMeeting: true, orgCoMention: true }, calibration.vectorFloor).score, prefs);
    entityDecisions.push({ surfaced: band !== 'new', autoLinked: band === 'link', autoLinkedBest: best === 'link', positive: p.same });
  }

  // --- items -----------------------------------------------------------------
  const itemSamples: Sample[] = [];
  const itemDecisions: Array<{ candidate: boolean; confident: boolean; positive: boolean }> = [];
  const same = new Map([['x', { verdict: 'same' as const, changes: { status: null, dueAt: null }, rationale: '' }]]);
  for (const p of set.itemPairs) {
    const va = vectors.get(itemText(p.kind, p.a));
    const vb = vectors.get(itemText(p.kind, p.b));
    if (!va || !vb) {
      missing += 1;
      continue;
    }
    const cos = cosine(va, vb);
    itemSamples.push({ score: cos, positive: p.duplicate });
    const candidate = { itemId: 'x', cosine: cos, lexical: null };
    const kept = selectCandidates([candidate], calibration).length > 0;
    const confident = kept && mapItemVerdicts('claim', [candidate], same, null, calibration).flags.length === 0;
    itemDecisions.push({ candidate: kept, confident, positive: p.duplicate });
  }

  const entitySweep = sweep(entitySamples);
  const itemSweep = sweep(itemSamples);
  const negatives = (samples: Sample[]) => samples.filter((s) => !s.positive).map((s) => s.score);
  const itemCosine = highestThresholdWithRecall(itemSweep, minRecall);
  const confident = lowestThresholdWithPrecision(itemSweep, confidentPrecision);

  return {
    model,
    calibration,
    missingVectors: missing,
    entities: {
      pairs: entitySamples.length,
      positives: entitySamples.filter((s) => s.positive).length,
      cosineSweep: entitySweep,
      negativeCosineP95: percentile(negatives(entitySamples), 0.95),
      negativeCosineMax: percentile(negatives(entitySamples), 1),
      surfaced: summarize(entityDecisions.map((d) => ({ fired: d.surfaced, positive: d.positive }))),
      autoLinked: summarize(entityDecisions.map((d) => ({ fired: d.autoLinked, positive: d.positive }))),
      autoLinkedBestContext: summarize(entityDecisions.map((d) => ({ fired: d.autoLinkedBest, positive: d.positive }))),
    },
    items: {
      pairs: itemSamples.length,
      positives: itemSamples.filter((s) => s.positive).length,
      cosineSweep: itemSweep,
      negativeCosineP95: percentile(negatives(itemSamples), 0.95),
      negativeCosineMax: percentile(negatives(itemSamples), 1),
      candidates: summarize(itemDecisions.map((d) => ({ fired: d.candidate, positive: d.positive }))),
      confident: summarize(itemDecisions.map((d) => ({ fired: d.confident, positive: d.positive }))),
    },
    recommended: {
      vectorFloor: lowestThresholdWithPrecision(entitySweep, minPrecision),
      itemCosine,
      itemSameConfidentCosine: confident === null ? null : Math.max(confident, itemCosine ?? confident),
    },
  };
}

/**
 * The recommendation as a calibration the catalog can take: the rules' answers where they have one,
 * else the model's current value. Validated like the graph validates a reported one.
 *
 * @param report - a model's report.
 * @returns a complete calibration.
 * @stability experimental
 */
export function recommendedCalibration(report: ModelCalibrationReport): Calibration {
  const r = report.recommended;
  return resolveGraphCalibration({
    vectorFloor: r.vectorFloor ?? report.calibration.vectorFloor,
    itemCosine: r.itemCosine ?? report.calibration.itemCosine,
    itemSameConfidentCosine: r.itemSameConfidentCosine ?? report.calibration.itemSameConfidentCosine,
  });
}
