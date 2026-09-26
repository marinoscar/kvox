// =============================================================================
// Proposal item payloads (#363, epic #346; docs/specs/ontology.md §8, §10, §19)
// =============================================================================
//
// THE CONTRACT for what a `kg_proposal_items.payload` / `.resolution` holds.
// Written by `kg.extract` (#363), re-scored by resolution (#364), extended by
// dedup/closing (#365), read, overridden and committed by #366, rendered by
// #367. Every one of those imports these schemas; none declares its own.
//
// A payload names its endpoints by `endpointRefSchema`: either an existing,
// committed entity (`{ entityId }`) or another ENTITY row of the same proposal
// (`{ ref }` — `"e3"`, `"k2"`, or the deterministic `"meeting"`). Relations and
// items never point at each other; only entity rows are endpoints.
//
// Deviations from the issue text, both additive (a field more, never a field
// less or a different meaning):
//   - `entityPayloadSchema.occurredAt` — the deterministic Meeting row carries
//     its date here, because `kg_entities.occurred_at` is where a Meeting's
//     date is committed (§10).
//   - `itemPayloadSchema.props` — item types have extractable attributes too
//     (`Decision.rejectedOption`, and a user's own attributes on an item type);
//     without it the closed-props rule would have nowhere to validate them.
//   - `itemPayloadSchema.subject` is nullable — `Commitment`/`Decision` declare
//     `subjectRequired: false` (#350); `claim`/`person_fact` still always carry
//     one (the validator refuses them otherwise, matching
//     `kg_items_subject_required_chk`).
// =============================================================================

import { z } from 'zod';

/** `YYYY-MM-DD`, a real calendar date. */
export const isoDate = z.iso.date();

export const endpointRefSchema = z.union([
  z.object({ entityId: z.guid() }).strict(), // an existing committed entity
  z.object({ ref: z.string().min(1).max(40) }).strict(), // another entity row of this proposal
]);
export type EndpointRef = z.infer<typeof endpointRefSchema>;

export const temporalSchema = z.object({
  validFrom: isoDate.nullable(),
  validTo: isoDate.nullable(),
  precision: z.enum(['day', 'month', 'year', 'unknown']),
});

export const entityPayloadSchema = z.object({
  ref: z.string(),
  type: z.string(),
  label: z.string().trim().min(1).max(200),
  aliases: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
  /** Validated against the effective schema, closed (#350). */
  props: z.record(z.string(), z.unknown()).default({}),
  /** Meeting rows only: the meeting date. See the file header. */
  occurredAt: isoDate.nullable().default(null),
});
export type EntityPayload = z.infer<typeof entityPayloadSchema>;

/**
 * #365 — what `work-item-dedup` (and `temporal-closing`, for `candidateTo`)
 * decided about a proposed relation. `known` = the same edge already exists
 * (restated, or inside a known period — §5.4's out-of-order rule): the commit
 * only appends evidence to `targetRelationId`.
 */
export const relationDedupSchema = z.object({
  verdict: z.enum(['known', 'new']),
  targetRelationId: z.guid().nullable(),
  /**
   * #353's rule 5: an OLDER, open candidate is committed already closed at this
   * exclusive upper bound (the next known edge's start), `YYYY-MM-DD`. Null
   * when the planner leaves the candidate's own range alone.
   */
  candidateTo: isoDate.nullable().default(null),
});
export type RelationDedup = z.infer<typeof relationDedupSchema>;

export const relationPayloadSchema = temporalSchema.extend({
  ref: z.string(),
  type: z.string(),
  from: endpointRefSchema,
  to: endpointRefSchema,
  props: z.record(z.string(), z.unknown()).default({}),
  /** #365 — absent/null until the `work-item-dedup` stage has run (optional so #363 rows need not name it). */
  dedup: relationDedupSchema.nullable().optional(),
});
export type RelationPayload = z.infer<typeof relationPayloadSchema>;

export const ITEM_PAYLOAD_KINDS = ['commitment', 'decision', 'claim', 'person_fact'] as const;
export type ItemPayloadKind = (typeof ITEM_PAYLOAD_KINDS)[number];

/**
 * #365 — what `work-item-dedup` decided about a proposed item (§7 "Work-item
 * dedup", §8 "Known, skipped"). The commit semantics per verdict are
 * `graph/dedup/commit-contract.ts`'s `itemCommitAction`.
 */
export const itemDedupSchema = z.object({
  verdict: z.enum(['same', 'new', 'supersedes', 'known']),
  /** The existing `kg_items` row (same / supersedes / known), or a possible duplicate of a `new` one. */
  targetItemId: z.guid().nullable(),
  /** Only for verdict `same` on a commitment: what the restatement changed. */
  changes: z
    .object({
      status: z.enum(['open', 'done', 'dropped']).optional(),
      dueAt: isoDate.nullable().optional(),
    })
    .default({}),
  rationale: z.string().max(500).nullable(),
  /** Cosine of the best candidate; null when found lexically or by hash. */
  score: z.number().min(0).max(1).nullable(),
});
export type ItemDedup = z.infer<typeof itemDedupSchema>;

export const itemPayloadSchema = temporalSchema.extend({
  ref: z.string(),
  kind: z.enum(ITEM_PAYLOAD_KINDS),
  title: z.string().trim().min(1).max(200),
  statement: z.string().trim().min(1).max(2000),
  subject: endpointRefSchema.nullable(),
  owner: endpointRefSchema.nullable().default(null),
  counterparty: endpointRefSchema.nullable().default(null),
  /**
   * → `kg_items.meeting_id` (CREATED_IN / DECIDED_IN). Set by the validator,
   * never by the model: `{ ref: 'meeting' }` for commitment/decision.
   */
  meeting: endpointRefSchema.nullable().default(null),
  /** Commitment only. */
  status: z.enum(['open', 'done', 'dropped']).nullable().default(null),
  occurredAt: isoDate.nullable(),
  dueAt: isoDate.nullable(),
  /** person_fact only (required there). */
  sensitivity: z.enum(['business', 'personal', 'sensitive']).nullable().default(null),
  /** `statementHash()` from `graph/write/normalize.ts` (#355) — never re-implemented. */
  statementHash: z.string(),
  props: z.record(z.string(), z.unknown()).default({}),
  /** #365 — absent/null until the `work-item-dedup` stage has run (optional so #363 rows need not name it). */
  dedup: itemDedupSchema.nullable().optional(),
});
export type ItemPayload = z.infer<typeof itemPayloadSchema>;

/**
 * #365 — a `kind: 'closing'` row: §5.4's closing rule as a reviewable proposal
 * row ("Closes: Joe works for Acme, 2019 → Feb 2026"), never a side effect.
 * Never pre-checked. UI copy (#367):
 *   `Closes: {fromLabel} {relationType label} {toLabel}{, as roleTitle},
 *    {previousValid.from at its precision} → {closeAt at its precision}`
 * Commit (#366): the target's `valid` becomes `[lower(valid), closeAt)` and its
 * `superseded_by_id` the committed id of `closedByRef`; skipped when that row
 * is rejected.
 */
export const closingPayloadSchema = z.object({
  /** The existing, still-open exclusive edge. */
  relationId: z.guid(),
  /** Any type the effective schema declares `temporal: true, exclusive: 'soft'`. */
  relationType: z.string(),
  fromLabel: z.string(),
  toLabel: z.string(),
  /** HAS_ROLE `props.title` of the edge being closed, when present. */
  roleTitle: z.string().nullable(),
  previousValid: z.object({
    from: isoDate.nullable(),
    to: isoDate.nullable(),
    precision: z.enum(['day', 'month', 'year', 'unknown']),
  }),
  /** The new fact's start (first day of its unit) — the exclusive upper bound. */
  closeAt: isoDate,
  /** Of `closeAt`; a closing never has `unknown`. */
  precision: z.enum(['day', 'month', 'year']),
  /** Proposal `ref` of the new relation row that closes this edge. */
  closedByRef: z.string(),
  /** WORKS_FOR closings only: the person's open commitments (§5.4 company change). */
  affectedCommitments: z
    .array(z.object({ itemId: z.guid(), title: z.string(), role: z.enum(['owner', 'counterparty']) }))
    .default([]),
});
export type ClosingPayload = z.infer<typeof closingPayloadSchema>;

export const RESOLUTION_SOURCES = [
  'model',
  'speaker',
  'meeting',
  'alias',
  'trigram',
  'vector',
  'adjudication',
  'user',
] as const;

export const resolutionCandidateSchema = z.object({
  entityId: z.guid(),
  label: z.string(),
  type: z.string(),
  score: z.number(),
  signals: z.array(z.string()),
});

export const resolutionSchema = z.object({
  /** The linked existing entity; null = new. */
  ref: z.string().nullable(),
  score: z.number().min(0).max(1).nullable(),
  source: z.enum(RESOLUTION_SOURCES).nullable(),
  candidates: z.array(resolutionCandidateSchema).max(10).default([]),
  adjudication: z
    .object({
      verdict: z.enum(['same', 'different', 'uncertain']),
      rationale: z.string().max(500),
      model: z.string(),
    })
    .nullable()
    .default(null),
});
export type ProposalResolution = z.infer<typeof resolutionSchema>;

export const PROPOSAL_ITEM_FLAGS = [
  'known',
  'possible_duplicate',
  'supersedes',
  'overlaps',
  'unordered', // #353's insert planner: start unknown while an open different-fact edge exists (#365 copies it)
  'closing_affects_commitments',
  'sensitive',
  'ambiguous',
  'type_changed',
  'previously_rejected',
  'quote_not_located',
  'model_claimed_match',
  'stale_ontology', // #384: draft predates a major ontology bump
  'imported', // #387: row came from an RDF import
] as const;
/** The single list of flags. #364, #365, #384 and #387 set values from it; #367 renders every one. */
export type ProposalItemFlag = (typeof PROPOSAL_ITEM_FLAGS)[number];

/** `kg_proposals.stats` as `kg.extract` writes it. Stages add `stats.<stageName>`. */
export interface ExtractionStats {
  phase: 'extracting' | 'ready';
  proposed: { entities: number; relations: number; items: number };
  dropped: { uncited: number; invalid: number; unknownType: number; dangling: number };
  quoteNotLocated: number;
  usage: { inputTokens: number; outputTokens: number };
  failure?: {
    errorClass: 'auth' | 'refusal' | 'rate_limit' | 'budget' | 'invalid_output' | 'other';
    message: string;
  };
  discardReason?: 'superseded' | 'user';
  [stage: string]: unknown;
}

export type ExtractionFailureClass = NonNullable<ExtractionStats['failure']>['errorClass'];
