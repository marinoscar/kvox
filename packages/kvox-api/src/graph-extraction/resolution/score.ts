// =============================================================================
// scoreCandidate / rankCandidates (#364, epic #346; docs/specs/ontology.md §7)
// =============================================================================
//
// PURE. The transparent additive score entity resolution decides with — no
// Prisma, no Nest, no clock (recency arrives as a boolean feature). A reviewer
// asking "why was this linked?" reads the `signals` list; #362's kg:eval
// numbers tune the table below, never an opaque learned weight.
//
//   name (the BASE — the best of whichever arms found the candidate)
//     exact alias/label                 0.80
//     trigram similarity s ≥ 0.4        0.40 + 0.40 × (s − 0.4) / 0.6   (0.40 → 0.80)
//     vector-only, cosine c             0.30 + 0.30 × max(0, (c − 0.75) / 0.25)
//   strong (capped together at +0.20)
//     same-meeting attendee/speaker     +0.15
//     organization co-mention           +0.15
//   medium
//     shared 1-hop neighbour            +0.05
//   weak (a tie-breaker, never deciding on its own)
//     evidence in the last 90 days      +0.02
//
//   score = min(1, base + boosts)
//
// AMBIGUITY: when the runner-up is within 0.05 of the best, the best is capped
// just below the auto-link threshold and flagged `ambiguous` — two plausible
// "Sarah"s are a question for a person, never a coin flip.
// =============================================================================

export type NameArm = 'alias_exact' | 'trigram' | 'vector';

export const SCORE_WEIGHTS = Object.freeze({
  exact: 0.8,
  trigramFloor: 0.4,
  trigramMin: 0.4,
  trigramSpan: 0.4,
  vectorBase: 0.3,
  vectorSpan: 0.3,
  vectorFloor: 0.75,
  sameMeeting: 0.15,
  orgCoMention: 0.15,
  strongCap: 0.2,
  sharedNeighbour: 0.05,
  recency: 0.02,
  ambiguityMargin: 0.05,
});

/** Everything the score reads about one candidate. */
export interface CandidateFeatures {
  /** The candidate matched an alias/label exactly (normalized). */
  aliasExact: boolean;
  /** Best trigram similarity over label + aliases, or null when arm B did not find it. */
  trigram: number | null;
  /** Cosine similarity from arm C, or null when arm C did not find it (or was skipped). */
  cosine: number | null;
  sameMeeting: boolean;
  orgCoMention: boolean;
  sharedNeighbour: boolean;
  recent: boolean;
}

export interface ScoredCandidate {
  score: number;
  /** Why, in order: the name arm first, then each boost that applied. */
  signals: string[];
  /** The arm that supplied the base (null when no arm found it — score 0). */
  arm: NameArm | null;
}

const round = (n: number): number => Math.round(n * 10_000) / 10_000;

/** The three name bases, each null when its arm does not apply. */
function nameBases(f: CandidateFeatures): Array<{ arm: NameArm; base: number }> {
  const w = SCORE_WEIGHTS;
  const out: Array<{ arm: NameArm; base: number }> = [];
  if (f.aliasExact) out.push({ arm: 'alias_exact', base: w.exact });
  if (f.trigram !== null && f.trigram >= w.trigramFloor) {
    const s = Math.min(1, f.trigram);
    out.push({ arm: 'trigram', base: w.trigramMin + (w.trigramSpan * (s - w.trigramFloor)) / (1 - w.trigramFloor) });
  }
  if (f.cosine !== null) {
    const c = Math.min(1, f.cosine);
    out.push({ arm: 'vector', base: w.vectorBase + w.vectorSpan * Math.max(0, (c - w.vectorFloor) / (1 - w.vectorFloor)) });
  }
  return out;
}

export function scoreCandidate(features: CandidateFeatures): ScoredCandidate {
  const w = SCORE_WEIGHTS;
  const bases = nameBases(features);
  // The strongest arm supplies the base; ties go to the earlier (more exact) arm.
  const best = bases.reduce<{ arm: NameArm; base: number } | null>(
    (acc, b) => (acc === null || b.base > acc.base ? b : acc),
    null,
  );
  const signals: string[] = [];
  let score = 0;
  if (best) {
    score = best.base;
    signals.push(best.arm);
  }

  let strong = 0;
  if (features.sameMeeting) {
    strong += w.sameMeeting;
    signals.push('same_meeting');
  }
  if (features.orgCoMention) {
    strong += w.orgCoMention;
    signals.push('org_co_mention');
  }
  score += Math.min(strong, w.strongCap);
  if (features.sharedNeighbour) {
    score += w.sharedNeighbour;
    signals.push('shared_neighbour');
  }
  if (features.recent) {
    score += w.recency;
    signals.push('recent');
  }

  return { score: round(Math.min(1, score)), signals, arm: best?.arm ?? null };
}

export interface RankedCandidate extends ScoredCandidate {
  entityId: string;
}

export interface RankResult<T extends RankedCandidate> {
  /** Highest first; ties by entity id so the order is total. */
  candidates: T[];
  /** The best was capped below `autoLinkThreshold` because the runner-up is too close. */
  ambiguous: boolean;
}

/**
 * Sort, then apply the ambiguity rule (only when the best reaches
 * `newThreshold` — below it the row is new regardless of which candidate is
 * first). Never mutates its input; returns new
 * candidate objects (the best one's score may be capped).
 */
export function rankCandidates<T extends RankedCandidate>(
  scored: readonly T[],
  thresholds: { autoLinkThreshold: number; newThreshold: number },
): RankResult<T> {
  const { autoLinkThreshold, newThreshold } = thresholds;
  const sorted = [...scored]
    .map((c) => ({ ...c, signals: [...c.signals] }))
    .sort((a, b) => b.score - a.score || a.entityId.localeCompare(b.entityId));
  if (sorted.length < 2) return { candidates: sorted, ambiguous: false };
  const [best, second] = sorted;
  // Only where it matters: two candidates both below `newThreshold` are a new
  // entity either way, and flagging them would only block its pre-check.
  if (best.score >= newThreshold && best.score - second.score <= SCORE_WEIGHTS.ambiguityMargin + 1e-9) {
    best.score = round(Math.min(best.score, autoLinkThreshold - 0.01));
    if (!best.signals.includes('ambiguous')) best.signals.push('ambiguous');
    return { candidates: sorted, ambiguous: true };
  }
  return { candidates: sorted, ambiguous: false };
}

/** `resolution.source` for a linked row, from the arm that supplied its base. */
export function sourceForArm(arm: NameArm | null): 'alias' | 'trigram' | 'vector' | null {
  if (arm === 'alias_exact') return 'alias';
  return arm;
}

/** What resolution decides from the ranked list, before any adjudication. */
export type Band = 'link' | 'new' | 'middle';

export function bandFor(topScore: number | null, thresholds: { autoLinkThreshold: number; newThreshold: number }): Band {
  if (topScore === null || topScore < thresholds.newThreshold) return 'new';
  if (topScore >= thresholds.autoLinkThreshold) return 'link';
  return 'middle';
}
