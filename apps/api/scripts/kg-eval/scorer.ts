// =============================================================================
// The kg:eval scorer (issue #362) — pure, deterministic, no I/O.
//
// Matching rules (the issue's contract, restated only where a choice was made):
//   - Entities: a candidate pair needs equal types and either the normalized
//     predicted label ∈ normalized {gold label ∪ gold aliases} (similarity 1)
//     or a token-set Jaccard ≥ 0.8 against one of those names. Assignment is
//     one-to-one, greedy by descending similarity — never double-counted.
//   - Entity coverage uses the same matcher with the type check dropped.
//   - A relation/item endpoint is compared by CANONICAL identity: a gold
//     entity is its `existingId` when it has one, else `key:<key>`; a
//     `knownEntities` id is itself; a predicted ref maps to the gold entity it
//     matched (or, unmatched, to the id its resolution linked, else nothing).
//   - Items: equal kind, subject matched, statement token-set F1 ≥ 0.5, and a
//     commitment's owner matched when the label names one.
//   - Temporal accuracy: over matched relations of a temporal type (from the
//     ontology registry, never a hand list): equal precision and both bounds
//     equal after truncation to it (`unknown` matches only `unknown`); over
//     matched items that carry a date: `occurredAt`/`dueAt` equal to the day.
// =============================================================================

import { ONTOLOGY } from '@app/shared/ontology';

import type { GoldenFixture, ItemLabelKind, ValidPrecisionLabel } from './fixture-schema';
import type { KgEvalPrediction, PredictedEvidence } from './prediction-schema';
import { jaccard, normalizeName, quoteFoundIn, tokenF1, tokenSet } from './text';

export { normalizeName } from './text';

export const ENTITY_MATCH_JACCARD = 0.8;
export const ITEM_STATEMENT_F1 = 0.5;

/** Report rows, fixed order. Relation rows (`relation:<TYPE>`) follow, sorted. */
export const ENTITY_REPORT_TYPES = ['Person', 'Organization', 'Project', 'Meeting'] as const;
export const ITEM_REPORT_TYPES: Record<ItemLabelKind, string> = {
  commitment: 'Commitment',
  decision: 'Decision',
  claim: 'Claim',
  person_fact: 'PersonFact',
};
export const BASE_REPORT_TYPES: string[] = [...ENTITY_REPORT_TYPES, ...Object.values(ITEM_REPORT_TYPES)];

export interface Counts {
  tp: number;
  fp: number;
  fn: number;
}

export interface FixtureScore {
  fixtureId: string;
  types: Record<string, Counts>;
  coverage: { matched: number; total: number };
  /** `anyResolution`: at least one prediction carried a resolution at all. */
  autoLink: { correct: number; total: number; anyResolution: boolean };
  evidence: { valid: number; total: number };
  temporal: { accurate: number; total: number };
  stats: Record<string, number>;
}

export interface RunScore {
  fixtures: number;
  types: Record<string, Counts>;
  coverage: { matched: number; total: number };
  autoLink: { correct: number; total: number; anyResolution: boolean };
  evidence: { valid: number; total: number };
  temporal: { accurate: number; total: number };
  stats: Record<string, number>;
  perFixture: FixtureScore[];
}

function bump(types: Record<string, Counts>, type: string, key: keyof Counts, by = 1): void {
  const c = types[type] ?? (types[type] = { tp: 0, fp: 0, fn: 0 });
  c[key] += by;
}

interface Named {
  type: string;
  names: Set<string>;
  tokenSets: Set<string>[];
}

function goldNames(label: string, aliases: readonly string[]): Named['names'] {
  return new Set([label, ...aliases].map(normalizeName).filter((n) => n.length > 0));
}

/** Similarity of one predicted label to one gold name set; 0 when not a candidate. */
export function nameSimilarity(predLabel: string, gold: Pick<Named, 'names' | 'tokenSets'>): number {
  const n = normalizeName(predLabel);
  if (gold.names.has(n)) return 1;
  const toks = tokenSet(predLabel);
  let best = 0;
  for (const g of gold.tokenSets) best = Math.max(best, jaccard(toks, g));
  return best >= ENTITY_MATCH_JACCARD ? best : 0;
}

/** Greedy one-to-one assignment; returns predIdx → goldIdx. */
function greedyAssign(candidates: Array<{ p: number; g: number; sim: number }>): Map<number, number> {
  const sorted = [...candidates].sort((a, b) => b.sim - a.sim || a.p - b.p || a.g - b.g);
  const usedP = new Set<number>();
  const usedG = new Set<number>();
  const out = new Map<number, number>();
  for (const c of sorted) {
    if (usedP.has(c.p) || usedG.has(c.g)) continue;
    usedP.add(c.p);
    usedG.add(c.g);
    out.set(c.p, c.g);
  }
  return out;
}

export function matchEntities(
  gold: ReadonlyArray<{ type: string; label: string; aliases: readonly string[] }>,
  preds: ReadonlyArray<{ type: string; label: string }>,
  opts: { typed: boolean },
): Map<number, number> {
  const g: Named[] = gold.map((e) => {
    const names = goldNames(e.label, e.aliases);
    return { type: e.type, names, tokenSets: [...names].map((n) => tokenSet(n)) };
  });
  const candidates: Array<{ p: number; g: number; sim: number }> = [];
  preds.forEach((p, pi) => {
    g.forEach((ge, gi) => {
      if (opts.typed && ge.type !== p.type) return;
      const sim = nameSimilarity(p.label, ge);
      if (sim > 0) candidates.push({ p: pi, g: gi, sim });
    });
  });
  return greedyAssign(candidates);
}

const TRUNC: Record<Exclude<ValidPrecisionLabel, 'unknown'>, number> = { day: 10, month: 7, year: 4 };

export function temporalEqual(
  gold: { validFrom: string | null; validTo: string | null; precision: ValidPrecisionLabel },
  pred: { validFrom: string | null; validTo: string | null; precision: ValidPrecisionLabel },
): boolean {
  if (gold.precision !== pred.precision) return false;
  if (gold.precision === 'unknown') return true;
  const n = TRUNC[gold.precision];
  const t = (d: string | null) => (d === null ? null : d.slice(0, n));
  return t(gold.validFrom) === t(pred.validFrom) && t(gold.validTo) === t(pred.validTo);
}

const day = (d: string | null | undefined) => (d ? d.slice(0, 10) : null);

function evidenceValid(fixture: GoldenFixture, ev: PredictedEvidence): boolean {
  if (ev.source === 'note') return quoteFoundIn(ev.quote, fixture.note.body);
  const seg = fixture.segments.find((s) => s.id === ev.segmentId);
  return seg !== undefined && quoteFoundIn(ev.quote, seg.text);
}

export function scoreFixture(fixture: GoldenFixture, prediction: KgEvalPrediction): FixtureScore {
  const types: Record<string, Counts> = {};
  for (const t of BASE_REPORT_TYPES) types[t] = { tp: 0, fp: 0, fn: 0 };

  const goldEntities = fixture.labels.entities;
  const knownIds = new Set(fixture.knownEntities.map((k) => k.id));

  // --- entities -------------------------------------------------------------
  const typedMatch = matchEntities(goldEntities, prediction.entities, { typed: true });
  const matchedGold = new Set(typedMatch.values());
  prediction.entities.forEach((p, pi) => {
    if (typedMatch.has(pi)) bump(types, p.type, 'tp');
    else bump(types, p.type, 'fp');
  });
  goldEntities.forEach((g, gi) => {
    if (!matchedGold.has(gi)) bump(types, g.type, 'fn');
  });

  const anyTypeMatch = matchEntities(goldEntities, prediction.entities, { typed: false });
  const coverage = { matched: new Set(anyTypeMatch.values()).size, total: goldEntities.length };

  // --- canonical identities -------------------------------------------------
  const goldCanon = new Map<string, string>();
  for (const g of goldEntities) goldCanon.set(g.key, g.existingId ?? `key:${g.key}`);
  const canonGold = (s: string | null): string | null => {
    if (s === null) return null;
    return goldCanon.get(s) ?? (knownIds.has(s) ? s : `unresolved:${s}`);
  };

  const predCanon = new Map<string, string>();
  prediction.entities.forEach((p, pi) => {
    const gi = typedMatch.get(pi);
    if (gi !== undefined) {
      predCanon.set(p.ref, canonGold(goldEntities[gi].key) as string);
    } else if (p.resolution?.outcome === 'linked' && p.resolution.entityId) {
      predCanon.set(p.ref, p.resolution.entityId);
    } else {
      predCanon.set(p.ref, `pred:${p.ref}`);
    }
  });
  const canonPred = (s: string | null): string | null => {
    if (s === null) return null;
    return predCanon.get(s) ?? (knownIds.has(s) ? s : `pred:${s}`);
  };

  // --- auto-link precision --------------------------------------------------
  const autoLink = { correct: 0, total: 0, anyResolution: false };
  prediction.entities.forEach((p, pi) => {
    if (p.resolution) autoLink.anyResolution = true;
    if (!p.resolution || !p.resolution.prechecked || p.resolution.outcome !== 'linked') return;
    autoLink.total += 1;
    const gi = typedMatch.get(pi);
    const expected = gi === undefined ? undefined : goldEntities[gi].existingId;
    if (expected && p.resolution.entityId === expected) autoLink.correct += 1;
  });

  const temporal = { accurate: 0, total: 0 };

  // --- relations ------------------------------------------------------------
  const goldRels = fixture.labels.relations;
  const usedGoldRel = new Set<number>();
  for (const p of prediction.relations) {
    const pf = canonPred(p.from);
    const pt = canonPred(p.to);
    const gi = goldRels.findIndex(
      (g, i) => !usedGoldRel.has(i) && g.type === p.type && canonGold(g.from) === pf && canonGold(g.to) === pt,
    );
    const row = `relation:${p.type}`;
    if (gi === -1) {
      bump(types, row, 'fp');
      continue;
    }
    usedGoldRel.add(gi);
    bump(types, row, 'tp');
    const g = goldRels[gi];
    if (ONTOLOGY.relationType(g.type)?.temporal) {
      temporal.total += 1;
      if (temporalEqual(g, p)) temporal.accurate += 1;
    }
  }
  goldRels.forEach((g, i) => {
    if (!usedGoldRel.has(i)) bump(types, `relation:${g.type}`, 'fn');
  });

  // --- items ----------------------------------------------------------------
  const goldItems = fixture.labels.items;
  const itemCandidates: Array<{ p: number; g: number; sim: number }> = [];
  prediction.items.forEach((p, pi) => {
    goldItems.forEach((g, gi) => {
      if (g.kind !== p.kind) return;
      if (canonGold(g.subject) !== canonPred(p.subject)) return;
      if (g.kind === 'commitment' && g.owner !== null && canonGold(g.owner) !== canonPred(p.owner)) return;
      const f1 = tokenF1(g.statement, p.statement);
      if (f1 >= ITEM_STATEMENT_F1) itemCandidates.push({ p: pi, g: gi, sim: f1 });
    });
  });
  const itemMatch = greedyAssign(itemCandidates);
  const matchedGoldItems = new Set(itemMatch.values());
  prediction.items.forEach((p, pi) => {
    const row = ITEM_REPORT_TYPES[p.kind];
    const gi = itemMatch.get(pi);
    if (gi === undefined) {
      bump(types, row, 'fp');
      return;
    }
    bump(types, row, 'tp');
    const g = goldItems[gi];
    if (g.occurredAt !== null || g.dueAt !== null) {
      temporal.total += 1;
      if (day(p.occurredAt) === g.occurredAt && day(p.dueAt) === g.dueAt) temporal.accurate += 1;
    }
  });
  goldItems.forEach((g, gi) => {
    if (!matchedGoldItems.has(gi)) bump(types, ITEM_REPORT_TYPES[g.kind], 'fn');
  });

  // --- evidence validity ----------------------------------------------------
  const evidence = { valid: 0, total: 0 };
  const allEvidence = [
    ...prediction.entities.flatMap((e) => e.evidence),
    ...prediction.relations.flatMap((r) => r.evidence),
    ...prediction.items.flatMap((i) => i.evidence),
  ];
  for (const ev of allEvidence) {
    evidence.total += 1;
    if (evidenceValid(fixture, ev)) evidence.valid += 1;
  }

  return {
    fixtureId: fixture.id,
    types,
    coverage,
    autoLink,
    evidence,
    temporal,
    stats: { ...prediction.stats },
  };
}

export function scoreRun(
  fixtures: readonly GoldenFixture[],
  predictions: ReadonlyMap<string, KgEvalPrediction>,
): RunScore {
  const run: RunScore = {
    fixtures: fixtures.length,
    types: {},
    coverage: { matched: 0, total: 0 },
    autoLink: { correct: 0, total: 0, anyResolution: false },
    evidence: { valid: 0, total: 0 },
    temporal: { accurate: 0, total: 0 },
    stats: {},
    perFixture: [],
  };
  for (const t of BASE_REPORT_TYPES) run.types[t] = { tp: 0, fp: 0, fn: 0 };

  for (const f of fixtures) {
    const pred = predictions.get(f.id) ?? {
      fixtureId: f.id,
      model: null,
      entities: [],
      relations: [],
      items: [],
      stats: {},
    };
    const s = scoreFixture(f, pred);
    run.perFixture.push(s);
    for (const [type, c] of Object.entries(s.types)) {
      bump(run.types, type, 'tp', c.tp);
      bump(run.types, type, 'fp', c.fp);
      bump(run.types, type, 'fn', c.fn);
    }
    run.coverage.matched += s.coverage.matched;
    run.coverage.total += s.coverage.total;
    run.autoLink.correct += s.autoLink.correct;
    run.autoLink.total += s.autoLink.total;
    run.autoLink.anyResolution ||= s.autoLink.anyResolution;
    run.evidence.valid += s.evidence.valid;
    run.evidence.total += s.evidence.total;
    run.temporal.accurate += s.temporal.accurate;
    run.temporal.total += s.temporal.total;
    for (const [k, v] of Object.entries(s.stats)) run.stats[k] = (run.stats[k] ?? 0) + v;
  }
  return run;
}

// --- ratios -----------------------------------------------------------------

export const ratio = (num: number, den: number): number | null => (den === 0 ? null : num / den);

export function precisionOf(c: Counts): number | null {
  return ratio(c.tp, c.tp + c.fp);
}
export function recallOf(c: Counts): number | null {
  return ratio(c.tp, c.tp + c.fn);
}
export function f1Of(c: Counts): number | null {
  const p = precisionOf(c);
  const r = recallOf(c);
  if (p === null || r === null) return null;
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}

export function entityCoverage(run: Pick<RunScore, 'coverage'>): number | null {
  return ratio(run.coverage.matched, run.coverage.total);
}
export function commitmentRecall(run: Pick<RunScore, 'types'>): number | null {
  return recallOf(run.types.Commitment ?? { tp: 0, fp: 0, fn: 0 });
}
/** `null` (printed `n/a`) when no prediction carries a resolution, or none was a prechecked link. */
export function autoLinkPrecision(run: Pick<RunScore, 'autoLink'>): number | null {
  if (!run.autoLink.anyResolution) return null;
  return ratio(run.autoLink.correct, run.autoLink.total);
}
