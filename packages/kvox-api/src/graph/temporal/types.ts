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

import type { RelationTypeSpec, ValidPrecision } from '@marinoscar/kvox-contract/ontology';

export type { ValidPrecision };

/** A half-open valid-time range `[from, to)`. `null` = unbounded on that side. */
/**
 * ValidRange.
 *
 * @stability experimental
 */
export interface ValidRange {
  /**
   * The from.
   */
  from: Date | null;
  /**
   * The to.
   */
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
 *
 * @stability experimental
 */
export interface TemporalRule {
  /**
   * The temporal.
   */
  temporal: boolean;
  /**
   * The exclusive.
   */
  exclusive: 'soft' | 'none';
  /**
   * The exclusive scope.
   */
  exclusiveScope: 'from' | 'from_to';
  /**
   * Props that make two edges "the same fact", compared strictly — null only
   * equals null (the relation's `required` props; HAS_ROLE: `['title']`).
   */
  identityProps: readonly string[];
  /**
   * #440: props that also take part in identity, except that a null/absent
   * value on EITHER side matches anything (the relation's `identity: true`
   * props; HAS_ROLE: `['businessUnit']`). Absent = none.
   */
  optionalIdentityProps?: readonly string[];
  /**
   * #383: `(a, b)` and `(b, a)` are the same fact (SPOUSE_OF, FRIEND_OF). The
   * planner then reads an existing edge `(b, a)` as `(a, b)`, so dedup,
   * "known, skipped" and closing all compare both directions. Absent = false.
   */
  symmetric?: boolean;
}

/**
 * The temporal review status type.
 *
 * @stability experimental
 */
export type TemporalReviewStatus =
  | 'accepted'
  | 'edited'
  | 'merged'
  | 'superseded'
  | 'rejected'
  | 'unreviewed';

/** An existing edge, as the planner and `edgesAsOf` see it. */
/**
 * TemporalEdge.
 *
 * @stability experimental
 */
export interface TemporalEdge {
  /**
   * The id.
   */
  id: string;
  /**
   * The type.
   */
  type: string;
  /**
   * The from id.
   */
  fromId: string;
  /**
   * The to id.
   */
  toId: string;
  /** Compared by `TemporalRule.identityProps`/`optionalIdentityProps` (HAS_ROLE.title/businessUnit). */
  props: Record<string, unknown>;
  /**
   * The valid.
   */
  valid: ValidRange | null;
  /**
   * The precision.
   */
  precision: ValidPrecision | null;
  /**
   * The review status.
   */
  reviewStatus: TemporalReviewStatus;
}

/** A proposed edge that has not been written yet. */
/**
 * CandidateEdge.
 *
 * @stability experimental
 */
export interface CandidateEdge {
  /**
   * The type.
   */
  type: string;
  /**
   * The from id.
   */
  fromId: string;
  /**
   * The to id.
   */
  toId: string;
  /**
   * The props.
   */
  props: Record<string, unknown>;
  /**
   * The valid.
   */
  valid: ValidRange | null;
  /**
   * The precision.
   */
  precision: ValidPrecision;
}

/**
 * The temporal flag type.
 *
 * @stability experimental
 */
export type TemporalFlag = 'overlaps' | 'unordered';

/**
 * The plan when the candidate restates, or sits inside, an existing edge: attach evidence to it.
 *
 * @stability experimental
 */
export interface TemporalAttachPlan {
  /** Always `attach_evidence`. */
  action: 'attach_evidence';
  /** The existing edge that gets the evidence. */
  edgeId: string;
  /** Why no new edge is made. */
  reason: 'restated' | 'inside_existing';
}

/**
 * An existing edge the new one closes.
 *
 * @stability experimental
 */
export interface TemporalClosing {
  /** The edge to close. */
  edgeId: string;
  /** The instant it closes at. */
  newTo: Date;
}

/**
 * The plan when the candidate is a new edge.
 *
 * @stability experimental
 */
export interface TemporalCreatePlan {
  /** Always `create`. */
  action: 'create';
  /** Each becomes a `closing` proposal row (#365). Sorted by `edgeId`. */
  closes: TemporalClosing[];
  /** The edge id the new edge SUPERSEDES, or null. */
  supersedes: string | null;
  /** The candidate itself closed at the next edge's start (an older fact). */
  candidateTo: Date | null;
  /** Soft warnings, sorted; never a rejection. */
  flags: TemporalFlag[];
  /** Sorted edge ids the candidate's final range overlaps. */
  overlapsWith: string[];
}

/**
 * The temporal plan type.
 *
 * @stability experimental
 */
export type TemporalPlan = TemporalAttachPlan | TemporalCreatePlan;

/** A date string that does not match its precision, or an empty/inverted range. */
/**
 * TemporalInputError.
 *
 * @stability experimental
 */
export class TemporalInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemporalInputError';
  }
}
