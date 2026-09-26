import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// Entity brief DTOs (#372, epic #347; docs/specs/ontology.md §9.1, §9.2)
// =============================================================================
//
// The contract `GET /api/graph/entities/:id/brief` answers, which the entity
// page (#373) renders and the Ask agent's `entity_brief` tool (#377) returns.
// Field names are stable once merged.
//
// ⚠ THERE IS NO `compose` AND NO `model` PARAMETER, deliberately. The brief is
// assembled from stored rows only — deterministic sections plus the latest
// digest `kg.entity_digest` wrote. No AI model is ever called inside this
// request; a stale digest is refreshed by ENQUEUEING that job. A legacy
// `?compose=true&model=x` is simply stripped by the (non-strict) object schema.
// =============================================================================

/** Newest entries per section — the ceilings the response schema enforces. */
export const BRIEF_SECTION_LIMITS = {
  whatChanged: 20,
  decisions: 10,
  openCommitments: 20,
  risksClaims: 10,
  peopleChanges: 20,
} as const;
/** Related sources returned. */
export const BRIEF_RELATED_LIMIT = 8;
/** Evidence ids per section entry. */
export const BRIEF_ENTRY_EVIDENCE_IDS = 5;
/** Evidence ids per digest statement. */
export const DIGEST_STATEMENT_EVIDENCE_IDS = 8;

const dateOrDatetime = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

export const entityBriefQuerySchema = z.object({
  since: dateOrDatetime
    .optional()
    .describe(
      'Start of the "what changed" window. Default: when you last opened this brief, else the digest\'s ' +
        '`coversUntil`, else 30 days before `as_of`.',
    ),
  as_of: dateOrDatetime
    .optional()
    .describe(
      'Evaluate the brief as of this instant (`YYYY-MM-DD` = 00:00:00Z that day). With it, `digest` is null, ' +
        'nothing is enqueued and your last-viewed time is not moved.',
    ),
  markViewed: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true')
    .describe('Record this visit as "last looked" (default true). Ignored with `as_of`.'),
});
export type EntityBriefQuery = z.infer<typeof entityBriefQuerySchema>;

const PRECISIONS = ['day', 'month', 'year', 'unknown'] as const;

export const citedStatementSchema = z.object({
  text: z.string(),
  evidenceIds: z.array(z.uuid()).min(1).max(DIGEST_STATEMENT_EVIDENCE_IDS),
});
export type CitedStatement = z.infer<typeof citedStatementSchema>;

export const briefEntityRefSchema = z.object({ id: z.uuid(), label: z.string(), type: z.string() });
export type BriefEntityRef = z.infer<typeof briefEntityRefSchema>;

export const briefEntrySchema = z.object({
  itemId: z.uuid(),
  kind: z.enum(['commitment', 'decision', 'claim', 'person_fact']),
  title: z.string().nullable(),
  statement: z.string(),
  occurredAt: z.string().nullable(),
  precision: z.enum(PRECISIONS),
  status: z.string().nullable(),
  dueAt: z.string().nullable(),
  ownerPerson: briefEntityRefSchema.nullable(),
  counterparty: briefEntityRefSchema.nullable(),
  superseded: z.boolean(),
  evidenceIds: z.array(z.uuid()).min(1).max(BRIEF_ENTRY_EVIDENCE_IDS),
});
export type BriefEntry = z.infer<typeof briefEntrySchema>;

export const peopleChangeSchema = z.object({
  relationId: z.uuid(),
  type: z.string(),
  change: z.enum(['started', 'ended']),
  at: z.string(),
  precision: z.enum(PRECISIONS),
  person: briefEntityRefSchema,
  other: briefEntityRefSchema,
  /** `HAS_ROLE.props.title`, else null. */
  title: z.string().nullable(),
  evidenceIds: z.array(z.uuid()).min(1).max(BRIEF_ENTRY_EVIDENCE_IDS),
});
export type PeopleChange = z.infer<typeof peopleChangeSchema>;

export const relatedSourceSchema = z.object({
  kind: z.enum(['transcript', 'note']),
  id: z.uuid(),
  title: z.string(),
  /** From `SearchService` snippets: already HTML-escaped, `<mark>` the only markup. */
  snippetHtml: z.string().nullable(),
  startMs: z.number().int().nullable(),
  score: z.number(),
  /** Whether this document is cited by the entity's graph (the graph arm found it). */
  inGraph: z.boolean(),
  occurredAt: z.string().nullable(),
});
export type RelatedSource = z.infer<typeof relatedSourceSchema>;

export const DIGEST_UNAVAILABLE_REASONS = [
  'graph_disabled',
  'ai_not_configured',
  'ai_key_missing',
  'model_lacks_capability',
] as const;
export type DigestUnavailableReason = (typeof DIGEST_UNAVAILABLE_REASONS)[number];

export const entityBriefResponseSchema = z.object({
  entity: briefEntityRefSchema,
  window: z.object({
    since: z.string().nullable(),
    sinceSource: z.enum(['query', 'last_viewed', 'digest', 'default']),
    asOf: z.string(),
    lastViewedAt: z.string().nullable(),
  }),
  /** The latest `kg_entity_digests` row as the job stored it; null when none yet, or with `as_of`. */
  digest: z
    .object({
      statements: z.array(citedStatementSchema),
      coversUntil: z.string().nullable(),
      generatedAt: z.string(),
      model: z.string(),
    })
    .nullable(),
  /** No digest while there is something to summarize, or the digest predates the newest change. */
  digestStale: z.boolean(),
  /** A `kg.entity_digest` job for this entity is pending or running. */
  digestPending: z.boolean(),
  /** Why a stale digest is NOT being refreshed (a configuration read — no provider call). */
  digestUnavailable: z.enum(DIGEST_UNAVAILABLE_REASONS).nullable(),
  sections: z.object({
    whatChanged: z.array(briefEntrySchema).max(BRIEF_SECTION_LIMITS.whatChanged),
    decisions: z.array(briefEntrySchema).max(BRIEF_SECTION_LIMITS.decisions),
    openCommitments: z.object({
      theirs: z.array(briefEntrySchema).max(BRIEF_SECTION_LIMITS.openCommitments),
      yours: z.array(briefEntrySchema).max(BRIEF_SECTION_LIMITS.openCommitments),
    }),
    risksClaims: z.array(briefEntrySchema).max(BRIEF_SECTION_LIMITS.risksClaims),
    peopleChanges: z.array(peopleChangeSchema).max(BRIEF_SECTION_LIMITS.peopleChanges),
  }),
  related: z.array(relatedSourceSchema).max(BRIEF_RELATED_LIMIT),
});
export type EntityBriefResponse = z.infer<typeof entityBriefResponseSchema>;
export type BriefSections = EntityBriefResponse['sections'];

export class EntityBriefResponseDto extends createZodDto(entityBriefResponseSchema) {}
