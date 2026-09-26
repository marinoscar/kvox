// =============================================================================
// Work-item dedup, temporal closing and rejection memory — the pure core
// (issue #365, epic #346; docs/specs/ontology.md §5.4, §7, §8)
// =============================================================================
//
// PURE: no Prisma, no Nest, no clock. The three stages (`work-item-dedup`,
// `temporal-closing`, `rejection-memory`) load rows and write verdicts; every
// decision in between lives here so the kg:eval runner can run the same code
// with no database, and so the stages' unit tests pin behaviour, not SQL.
//
// Range logic is NEVER re-implemented here: every containment, overlap and
// closing question goes to #353's `planTemporalInsert`. This file only turns
// proposal payloads into the planner's inputs and its plans into verdicts.
// =============================================================================

import type { EffectiveRelationType } from '@app/shared/ontology';

import type {
  EndpointRef,
  EntityPayload,
  ItemDedup,
  ItemPayload,
  ProposalItemFlag,
  ProposalResolution,
  RelationPayload,
} from '../proposals/proposal-payload.schema';
import {
  planTemporalInsert,
  rangeFromPrecision,
  type CandidateEdge,
  type TemporalEdge,
  type TemporalPlan,
  type TemporalRule,
  type ValidPrecision,
  type ValidRange,
} from '../temporal';
import { normalizeAlias } from '../write/normalize';

// -----------------------------------------------------------------------------
// Stage names and orders (after #364's `resolution`, order 100)
// -----------------------------------------------------------------------------

export const WORK_ITEM_DEDUP_STAGE = { name: 'work-item-dedup', order: 200 } as const;
export const TEMPORAL_CLOSING_STAGE = { name: 'temporal-closing', order: 300 } as const;
export const REJECTION_MEMORY_STAGE = { name: 'rejection-memory', order: 400 } as const;

/** §7: a candidate needs cosine ≥ 0.80 to be adjudicated at all. */
export const ITEM_COSINE_THRESHOLD = 0.8;
/** `same` at or above this cosine is not flagged `possible_duplicate`. */
export const ITEM_SAME_CONFIDENT_COSINE = 0.92;
/** The lexical fallback's token-set Jaccard threshold. */
export const ITEM_LEXICAL_THRESHOLD = 0.5;
/** Candidates kept per proposed item. */
export const ITEM_MAX_CANDIDATES = 5;

// -----------------------------------------------------------------------------
// Endpoint resolution
// -----------------------------------------------------------------------------

/** One proposal entity row, as the stages see it. */
export interface ProposalEntityView {
  ref: string;
  type: string;
  label: string;
  /** `resolution.ref` — the linked existing entity, null = proposal-new. */
  resolvedId: string | null;
}

export function entityView(payload: EntityPayload, resolution: ProposalResolution | null): ProposalEntityView {
  return { ref: payload.ref, type: payload.type, label: payload.label, resolvedId: resolution?.ref ?? null };
}

export type ResolvedEndpoint =
  | { kind: 'existing'; entityId: string }
  | { kind: 'new'; ref: string; type: string; label: string }
  | { kind: 'missing' };

export function resolveEndpoint(
  ref: EndpointRef | null | undefined,
  entities: ReadonlyMap<string, ProposalEntityView>,
): ResolvedEndpoint {
  if (!ref) return { kind: 'missing' };
  if ('entityId' in ref) return { kind: 'existing', entityId: ref.entityId };
  const row = entities.get(ref.ref);
  if (!row) return { kind: 'missing' };
  return row.resolvedId
    ? { kind: 'existing', entityId: row.resolvedId }
    : { kind: 'new', ref: row.ref, type: row.type, label: row.label };
}

/** The existing entity id, or null (proposal-new or absent). */
export function existingId(endpoint: ResolvedEndpoint): string | null {
  return endpoint.kind === 'existing' ? endpoint.entityId : null;
}

/**
 * A comparison key for an endpoint that works across proposals: the entity id
 * when there is one, else `new:{type}:{normalized label}` so a still-new
 * mention matches the same still-new mention in an earlier proposal.
 */
export function endpointKey(endpoint: ResolvedEndpoint): string {
  if (endpoint.kind === 'existing') return `id:${endpoint.entityId}`;
  if (endpoint.kind === 'missing') return 'none';
  let label: string;
  try {
    label = normalizeAlias(endpoint.label);
  } catch {
    label = endpoint.label.trim().toLowerCase();
  }
  return `new:${endpoint.type}:${label}`;
}

// -----------------------------------------------------------------------------
// Payload dates → #353 ranges
// -----------------------------------------------------------------------------

const PRECISION_LENGTH: Record<'day' | 'month' | 'year', number> = { day: 10, month: 7, year: 4 };

function atPrecision(date: string | null, precision: 'day' | 'month' | 'year'): string | null {
  return date === null ? null : date.slice(0, PRECISION_LENGTH[precision]);
}

/**
 * A proposed relation's valid range, the way the commit (#366) writes it.
 *
 * Payload dates are `YYYY-MM-DD` at any precision; they are cut to the
 * precision's unit first (`2026-03-14` at `month` → `2026-03`). A relation of a
 * temporal type stated only by its start is a CONTINUING STATE (§5.4: "has
 * worked there since 2019" → `[2019, )`), so it is open-ended; with `point`
 * the same start is read as a POINT fact spanning its one unit — what the
 * out-of-order rule compares ("Joe works for Acme", said in a 2020 meeting, is
 * evidence for an accepted `[2019, 2026)` edge). `unknown` or no dates → null.
 * A malformed date or inverted range also yields null: the extractor already
 * degrades those to `unknown` (#363), so this is belt and braces.
 */
export function proposedRelationRange(
  payload: Pick<RelationPayload, 'validFrom' | 'validTo' | 'precision'>,
  reading: 'state' | 'point' = 'state',
): { range: ValidRange | null; precision: ValidPrecision } {
  const { precision } = payload;
  if (precision === 'unknown' || (payload.validFrom === null && payload.validTo === null)) {
    return { range: null, precision: 'unknown' };
  }
  const from = atPrecision(payload.validFrom, precision);
  const to = atPrecision(payload.validTo, precision);
  try {
    return rangeFromPrecision(from, to, precision, { openEnded: reading === 'state' && to === null && from !== null });
  } catch {
    return { range: null, precision: 'unknown' };
  }
}

/** A `Date` on a UTC day boundary as `YYYY-MM-DD`. */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// -----------------------------------------------------------------------------
// Relation rules from the EFFECTIVE schema (never a hardcoded list — §17.1)
// -----------------------------------------------------------------------------

/**
 * The planner's rule for a relation type as the caller's effective schema
 * declares it. `identityProps` are the type's REQUIRED props, sorted — the
 * same derivation as #353's `temporalRuleFor` (HAS_ROLE → `['title']`).
 */
export function ruleForEffectiveRelation(
  relation: Pick<EffectiveRelationType, 'temporal' | 'exclusive' | 'exclusiveScope' | 'props'>,
): TemporalRule {
  return {
    temporal: relation.temporal,
    exclusive: relation.exclusive,
    exclusiveScope: relation.exclusiveScope,
    identityProps: relation.props
      .filter((p) => p.required)
      .map((p) => p.key)
      .sort(),
  };
}

/** Closing applies to exactly the types declared `temporal: true, exclusive: 'soft'`. */
export function isExclusiveTemporal(rule: TemporalRule): boolean {
  return rule.temporal && rule.exclusive === 'soft';
}

/** A placeholder `toId` for a proposal-new target: it can never equal an existing id. */
export function placeholderId(endpoint: ResolvedEndpoint): string {
  return endpoint.kind === 'existing' ? endpoint.entityId : `proposal:${endpointKey(endpoint)}`;
}

// -----------------------------------------------------------------------------
// Relation `known` (stage 1)
// -----------------------------------------------------------------------------

export type RelationKnownResult = { known: true; edgeId: string } | { known: false };

/**
 * §8 "known, skipped" for a relation, via #353's planner: the same edge
 * restated, or a period inside an accepted one (§5.4 out-of-order rule). A
 * start-only statement is tried as a continuing state first, then as a point
 * fact — "Joe works for Acme" said in 2020 is inside `[2019, 2026)` even
 * though `[2020, )` is not.
 */
export function relationKnown(
  existing: readonly TemporalEdge[],
  payload: RelationPayload,
  fromId: string,
  toId: string,
  rule: TemporalRule,
): RelationKnownResult {
  const attempt = (reading: 'state' | 'point'): TemporalPlan => {
    const { range, precision } = rule.temporal
      ? proposedRelationRange(payload, reading)
      : { range: null, precision: 'unknown' as const };
    return planTemporalInsert(existing, { type: payload.type, fromId, toId, props: payload.props ?? {}, valid: range, precision }, rule);
  };
  const state = attempt('state');
  if (state.action === 'attach_evidence') return { known: true, edgeId: state.edgeId };
  if (rule.temporal && payload.validTo === null && payload.validFrom !== null && payload.precision !== 'unknown') {
    const point = attempt('point');
    if (point.action === 'attach_evidence') return { known: true, edgeId: point.edgeId };
  }
  return { known: false };
}

/** The candidate edge the closing stage plans with (the state reading). */
export function candidateEdge(payload: RelationPayload, fromId: string, toId: string, rule: TemporalRule): CandidateEdge {
  const { range, precision } = rule.temporal
    ? proposedRelationRange(payload, 'state')
    : { range: null, precision: 'unknown' as const };
  return { type: payload.type, fromId, toId, props: payload.props ?? {}, valid: range, precision };
}

// -----------------------------------------------------------------------------
// Items (stage 1)
// -----------------------------------------------------------------------------

const TOKEN_SPLIT = /[^\p{L}\p{N}]+/u;

export function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .normalize('NFKC')
      .toLowerCase()
      .split(TOKEN_SPLIT)
      .filter((t) => t.length > 0),
  );
}

/** Token-set Jaccard — the lexical fallback when no embedding is available. */
export function jaccard(a: string, b: string): number {
  const x = tokenSet(a);
  const y = tokenSet(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const t of x) if (y.has(t)) shared += 1;
  return shared / (x.size + y.size - shared);
}

export interface ItemCandidate {
  itemId: string;
  /** Cosine against the proposed item's embedding; null when either side has none. */
  cosine: number | null;
  /** Token-set Jaccard on `statement`; used only when `cosine` is null. */
  lexical: number | null;
}

/** The candidate's rank score: cosine when there is one, else the lexical score. */
export function candidateScore(c: ItemCandidate): number {
  return c.cosine ?? c.lexical ?? 0;
}

/** Keep the top 5 that clear their arm's threshold, best first, ties by id. */
export function selectCandidates(candidates: readonly ItemCandidate[]): ItemCandidate[] {
  return candidates
    .filter((c) =>
      c.cosine !== null ? c.cosine >= ITEM_COSINE_THRESHOLD : (c.lexical ?? 0) >= ITEM_LEXICAL_THRESHOLD,
    )
    .sort((a, b) => candidateScore(b) - candidateScore(a) || (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0))
    .slice(0, ITEM_MAX_CANDIDATES);
}

export type ItemVerdict = 'same' | 'new' | 'supersedes';

export interface ItemAdjudication {
  verdict: ItemVerdict;
  changes: { status: 'open' | 'done' | 'dropped' | null; dueAt: string | null };
  rationale: string;
}

/**
 * §7 mapping, step 5: the best non-`new` candidate (highest score) wins.
 * `same` carries `changes` only for a commitment and is flagged
 * `possible_duplicate` unless its cosine is ≥ 0.92; `supersedes` is flagged
 * `supersedes`. With no verdicts at all (adjudication off or unavailable) the
 * row stays `new`, pointing at its best candidate, flagged `possible_duplicate`
 * — a reviewer decides.
 */
export function mapItemVerdicts(
  kind: ItemPayload['kind'],
  candidates: readonly ItemCandidate[],
  verdicts: ReadonlyMap<string, ItemAdjudication> | null,
  unavailableReason: string | null = null,
): { dedup: ItemDedup; flags: ProposalItemFlag[] } {
  const ranked = selectCandidates(candidates);
  if (ranked.length === 0) {
    return { dedup: { verdict: 'new', targetItemId: null, changes: {}, rationale: null, score: null }, flags: [] };
  }
  if (verdicts === null) {
    const best = ranked[0];
    return {
      dedup: {
        verdict: 'new',
        targetItemId: best.itemId,
        changes: {},
        rationale: `Not compared by a model (${unavailableReason ?? 'adjudication off'}); a similar item exists.`,
        score: best.cosine,
      },
      flags: ['possible_duplicate'],
    };
  }
  const winner = ranked.find((c) => {
    const v = verdicts.get(c.itemId)?.verdict;
    return v === 'same' || v === 'supersedes';
  });
  if (!winner) {
    const best = ranked[0];
    return {
      dedup: { verdict: 'new', targetItemId: null, changes: {}, rationale: verdicts.get(best.itemId)?.rationale.slice(0, 500) ?? null, score: best.cosine },
      flags: [],
    };
  }
  const v = verdicts.get(winner.itemId)!;
  const rationale = v.rationale.slice(0, 500);
  if (v.verdict === 'supersedes') {
    return {
      dedup: { verdict: 'supersedes', targetItemId: winner.itemId, changes: {}, rationale, score: winner.cosine },
      flags: ['supersedes'],
    };
  }
  const changes: ItemDedup['changes'] = {};
  if (kind === 'commitment') {
    if (v.changes.status !== null) changes.status = v.changes.status;
    if (v.changes.dueAt !== null) changes.dueAt = v.changes.dueAt;
  }
  const confident = winner.cosine !== null && winner.cosine >= ITEM_SAME_CONFIDENT_COSINE;
  return {
    dedup: { verdict: 'same', targetItemId: winner.itemId, changes, rationale, score: winner.cosine },
    flags: confident ? [] : ['possible_duplicate'],
  };
}

// -----------------------------------------------------------------------------
// Rejection memory (stage 3)
// -----------------------------------------------------------------------------

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined && obj[k] !== null)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(typeof obj[k] === 'string' ? (obj[k] as string).trim().toLowerCase() : obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The rejection-memory identity of a relation or item row: kind, type,
 * resolved endpoints, and — for items — the statement hash; relation props are
 * part of it so a rejected "Engineer" role never shadows "Staff Engineer".
 * Null for kinds rejection memory does not track (entities, closings).
 */
export function rejectionKey(
  kind: 'relation' | 'item',
  payload: RelationPayload | ItemPayload,
  entities: ReadonlyMap<string, ProposalEntityView>,
): string {
  if (kind === 'relation') {
    const p = payload as RelationPayload;
    return [
      'relation',
      p.type,
      endpointKey(resolveEndpoint(p.from, entities)),
      endpointKey(resolveEndpoint(p.to, entities)),
      stable(p.props ?? {}),
    ].join('|');
  }
  const p = payload as ItemPayload;
  return ['item', p.kind, endpointKey(resolveEndpoint(p.subject, entities)), p.statementHash].join('|');
}
