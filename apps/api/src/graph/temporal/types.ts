// =============================================================================
// Temporal engine types (issue #353, epic #344; docs/specs/ontology.md §5.4)
// =============================================================================
//
// Every range in this module is HALF-OPEN, `[from, to)`: `from` is included,
// `to` is not. `null` on either side means unbounded on that side. Every
// instant is a UTC `Date`. The Postgres column these map onto is a
// `tstzrange` written as `'[from,to)'`, so the two agree by construction.
//
// PURE: nothing here imports Prisma or Nest, and nothing reads the clock.
// =============================================================================

import type { RelationTypeSpec, ValidPrecision } from '@app/shared/ontology';

export type { ValidPrecision };

/** A half-open valid-time range `[from, to)`. `null` = unbounded on that side. */
export interface ValidRange {
  from: Date | null;
  to: Date | null;
}

/**
 * The three ontology fields the engine reads from a relation type (#350).
 * `exclusiveScope` is optional in the ontology and defaults to `'from'`.
 */
export type TemporalRelationRule = Pick<
  RelationTypeSpec,
  'temporal' | 'exclusive' | 'exclusiveScope'
>;

/**
 * Everything the planner needs to know about a relation type. Build it from
 * the ontology with `temporalRuleFor()` rather than by hand.
 */
export interface TemporalRule {
  temporal: boolean;
  exclusive: 'soft' | 'none';
  exclusiveScope: 'from' | 'from_to';
  /** Props that make two edges "the same fact" (HAS_ROLE: `['title']`). */
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
  /** Compared by `TemporalRule.identityProps` (e.g. HAS_ROLE.title). */
  props: Record<string, unknown>;
  valid: ValidRange | null;
  precision: ValidPrecision | null;
  reviewStatus: TemporalReviewStatus;
}

/** A proposed edge that has not been written yet. */
export interface CandidateEdge {
  type: string;
  fromId: string;
  toId: string;
  props: Record<string, unknown>;
  valid: ValidRange | null;
  precision: ValidPrecision;
}

export type TemporalFlag = 'overlaps' | 'unordered';

export type TemporalPlan =
  | { action: 'attach_evidence'; edgeId: string; reason: 'restated' | 'inside_existing' }
  | {
      action: 'create';
      /** Each becomes a `closing` proposal row (#365). Sorted by `edgeId`. */
      closes: { edgeId: string; newTo: Date }[];
      /** The edge id the new edge SUPERSEDES, or null. */
      supersedes: string | null;
      /** The candidate itself closed at the next edge's start (an older fact). */
      candidateTo: Date | null;
      /** Soft warnings, sorted; never a rejection. */
      flags: TemporalFlag[];
      /** Sorted edge ids the candidate's final range overlaps. */
      overlapsWith: string[];
    };

/** A date string that does not match its precision, or an empty/inverted range. */
export class TemporalInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemporalInputError';
  }
}
