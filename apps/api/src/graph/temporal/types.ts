// =============================================================================
// The temporal engine's types (issue #353, epic #344)
// =============================================================================
//
// docs/specs/ontology.md §5.4. Every range is HALF-OPEN, `[from, to)`: the
// lower bound is inclusive, the upper bound exclusive, and `null` means
// unbounded on that side. Every instant is a UTC `Date`. The same convention
// Postgres uses for the `tstzrange` column (`valid @> $asOf`), so the in-memory
// predicates and the SQL ones answer identically.
//
// ⚠ Everything in this directory is pure: no database, no framework, no
// clock. "Now" is always a parameter. `purity.spec.ts` enforces it.
// =============================================================================

/**
 * How exact the source actually was (§5.4). `unknown` is a legitimate value,
 * never a gap to fill in: it is always paired with a `null` range.
 *
 * Local until #350 (`@app/shared/ontology`) merges; it then becomes a
 * re-export of that package's `ValidPrecision`.
 */
export type ValidPrecision = 'day' | 'month' | 'year' | 'unknown';

/** `[from, to)`; `null` = unbounded on that side. */
export interface ValidRange {
  from: Date | null;
  to: Date | null;
}

/**
 * The three `RelationTypeSpec` fields the temporal engine needs.
 *
 * Local fallback until #350 merges: it then becomes
 * `Pick<RelationTypeSpec, 'temporal' | 'exclusive' | 'exclusiveScope'>` from
 * `@app/shared/ontology`, supplied by `ONTOLOGY.relationType(key)`.
 */
export interface TemporalRelationRule {
  /** Whether the relation carries a `valid` range at all (§5.2). */
  temporal: boolean;
  /** `soft` = normally exclusive: the closing rule applies, overlap only warns. */
  exclusive: 'soft' | 'none';
  /**
   * What "the same slot" means for exclusivity: `from` (one open `WORKS_FOR`
   * per person) or `from_to` (one open `HAS_ROLE` per person *per organization*).
   */
  exclusiveScope: 'from' | 'from_to';
}

/**
 * A relation rule plus the props that decide whether two edges state the
 * same fact — the relation's `required` prop keys (`HAS_ROLE` → `['title']`).
 */
export interface TemporalRule extends TemporalRelationRule {
  identityProps: readonly string[];
}

export type TemporalReviewStatus =
  | 'accepted'
  | 'edited'
  | 'merged'
  | 'superseded'
  | 'rejected'
  | 'unreviewed';

/** An existing edge, as the planner and `edgesAsOf` see it. */
export interface TemporalEdge {
  id: string;
  type: string;
  fromId: string;
  toId: string;
  /** Compared through `TemporalRule.identityProps` (e.g. `HAS_ROLE.title`). */
  props: Record<string, unknown>;
  valid: ValidRange | null;
  precision: ValidPrecision | null;
  reviewStatus: TemporalReviewStatus;
}

/** A proposed edge, not yet written. */
export interface CandidateEdge {
  type: string;
  fromId: string;
  toId: string;
  props: Record<string, unknown>;
  valid: ValidRange | null;
  precision: ValidPrecision;
}

export type TemporalPlanFlag = 'overlaps' | 'unordered';

export type TemporalPlan =
  | {
      action: 'attach_evidence';
      edgeId: string;
      reason: 'restated' | 'inside_existing';
    }
  | {
      action: 'create';
      /** Each becomes a `kind: 'closing'` proposal row (#365), never a silent write. */
      closes: { edgeId: string; newTo: Date }[];
      /** The edge the new edge `SUPERSEDES`, if the closing rule fired. */
      supersedes: string | null;
      /** The candidate itself proposed closed at the next edge's start (an older fact). */
      candidateTo: Date | null;
      /** Soft warnings; never a rejection. */
      flags: TemporalPlanFlag[];
      overlapsWith: string[];
    };

/** Bad input to a range constructor or parser. */
export class TemporalInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemporalInputError';
    Object.setPrototypeOf(this, TemporalInputError.prototype);
  }
}
