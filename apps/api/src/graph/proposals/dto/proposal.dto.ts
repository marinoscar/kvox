import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { userGuidanceSchema } from '../../extraction/dto/extraction.dto';
import { resolutionSchema } from '../proposal-payload.schema';

// =============================================================================
// Graph proposal DTOs (#366, epic #346; docs/specs/ontology.md §8, §19)
// =============================================================================
//
// THE CONTRACT the review sheet (#367) and the Guide/Add surfaces (#368) are
// built against. Every shape below is the issue's Contract section verbatim;
// a change here needs an edit to #366, #367 and #368 together.
//
// Ids are `z.guid()` (any UUID-shaped string), the convention every graph DTO
// in this module uses — the wire format is the same as `z.string().uuid()`.
// Every request body is `.strict()`: an unknown key is a 400.
// =============================================================================

// -----------------------------------------------------------------------------
// Shared shapes
// -----------------------------------------------------------------------------

export const proposalStatusSchema = z.enum(['extracting', 'draft', 'committed', 'discarded', 'failed', 'reverted']);
export type ProposalStatus = z.infer<typeof proposalStatusSchema>;
export const proposalKindSchema = z.enum(['extraction', 'import', 'resolution']);
export const decisionSchema = z.enum(['pending', 'accept', 'edit', 'reject', 'merge_into']);
export type ProposalDecision = z.infer<typeof decisionSchema>;

export const GROUP_KEYS = [
  'Person',
  'Organization',
  'Project',
  'Meeting',
  'Decision',
  'Commitment',
  'Claim',
  'PersonFact',
  'Other',
  'relations',
  'closings',
] as const;
/** `Other` = any further entity type from the effective schema; the web renders its own label. */
export const groupKeySchema = z.enum(GROUP_KEYS);
export type GroupKey = z.infer<typeof groupKeySchema>;

export const proposalCountsSchema = z
  .object({
    total: z.number().int(),
    pending: z.number().int(),
    accepted: z.number().int().describe('Rows decided `accept`, `edit` or `merge_into`.'),
    rejected: z.number().int(),
    known: z.number().int().describe('Rows flagged `known` — already in your graph; committing only adds evidence.'),
    byGroup: z.record(groupKeySchema, z.number().int()).describe('Rows per review group; every group is present.'),
  })
  .describe('Row counts by decision and by review group.');
export type ProposalCounts = z.infer<typeof proposalCountsSchema>;

export const proposalSummarySchema = z.object({
  id: z.guid(),
  kind: proposalKindSchema,
  status: proposalStatusSchema,
  noteId: z.guid().nullable(),
  noteTitle: z.string().nullable(),
  noteVersion: z.number().int().nullable().describe('The note version the proposal was extracted from.'),
  noteCurrentVersion: z.number().int().nullable().describe('The note\'s version now. Greater than `noteVersion` = the note changed since.'),
  model: z.string().nullable(),
  providerId: z.string().nullable(),
  userGuidance: userGuidanceSchema.nullable(),
  counts: proposalCountsSchema,
  stats: z.record(z.string(), z.unknown()).describe('The extraction and pipeline statistics, passed through (`stats.commit` / `stats.revert` once committed / reverted).'),
  failure: z.object({ errorClass: z.string(), message: z.string() }).nullable(),
  createdAt: z.string(),
  committedAt: z.string().nullable(),
  revertedAt: z.string().nullable(),
});
export type ProposalSummary = z.infer<typeof proposalSummarySchema>;

export const evidenceViewSchema = z.object({
  id: z.guid(),
  source: z.enum(['segment', 'note']),
  transcriptId: z.guid().nullable(),
  segmentId: z.guid().nullable(),
  segmentRev: z.number().int().nullable(),
  startMs: z.number().int().nullable(),
  endMs: z.number().int().nullable(),
  noteId: z.guid().nullable(),
  noteVersion: z.number().int().nullable(),
  charStart: z.number().int().nullable(),
  charEnd: z.number().int().nullable(),
  quote: z.string(),
  speakerName: z.string().nullable().describe('Segment evidence: the speaker\'s display name at read time.'),
  stale: z.boolean().describe('The cited text changed since (segment rev or note version moved on), or its source is gone.'),
});
export type EvidenceView = z.infer<typeof evidenceViewSchema>;

export const PROPOSAL_ITEM_KINDS = ['entity', 'relation', 'item', 'closing'] as const;
export type ProposalItemKind = (typeof PROPOSAL_ITEM_KINDS)[number];

export const proposalItemViewSchema = z.object({
  id: z.guid(),
  kind: z.enum(PROPOSAL_ITEM_KINDS),
  origin: z.enum(['ai', 'user']),
  groupKey: groupKeySchema,
  decision: decisionSchema,
  payload: z.record(z.string(), z.unknown()),
  editedPayload: z.record(z.string(), z.unknown()).nullable(),
  effectivePayload: z.record(z.string(), z.unknown()).describe('`editedPayload ?? payload`, with relinks applied.'),
  display: z.object({
    title: z.string(),
    subtitle: z.string().nullable(),
  }),
  resolution: resolutionSchema
    .extend({ refLabel: z.string().nullable().describe('Label of `resolution.ref` / `mergeIntoId`.') })
    .nullable(),
  mergeIntoId: z.guid().nullable(),
  distinctFrom: z.array(z.guid()),
  flags: z.array(z.string()),
  prechecked: z.boolean().describe('Whether the extraction pre-check ticked this row.'),
  evidence: z.array(evidenceViewSchema),
  committedRefId: z.guid().nullable(),
});
export type ProposalItemView = z.infer<typeof proposalItemViewSchema>;

export const proposalDetailSchema = z.object({
  proposal: proposalSummarySchema,
  items: z.array(proposalItemViewSchema).describe('Ordered by review group, then `display.title`.'),
  context: z
    .object({ systemPrompt: z.string(), userContent: z.string() })
    .nullable()
    .describe('The exact prompt the extraction sent — only with `?include=context`.'),
});
export type ProposalDetail = z.infer<typeof proposalDetailSchema>;
export class ProposalDetailDto extends createZodDto(proposalDetailSchema) {}

// -----------------------------------------------------------------------------
// Queries
// -----------------------------------------------------------------------------

export const listProposalsQuerySchema = z
  .object({
    status: proposalStatusSchema.default('draft'),
    kind: proposalKindSchema.optional(),
    noteId: z.guid().optional(),
    transcriptId: z.guid().optional().describe('Proposals whose note came (directly or through a chain of notes) from this transcript.'),
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
export type ListProposalsQuery = z.infer<typeof listProposalsQuerySchema>;

export const getProposalQuerySchema = z
  .object({ include: z.enum(['context']).optional() })
  .strict();
export type GetProposalQuery = z.infer<typeof getProposalQuerySchema>;

export const proposalListResponseSchema = z.object({
  items: z.array(proposalSummarySchema),
  nextCursor: z.string().nullable(),
});
export type ProposalListResponse = z.infer<typeof proposalListResponseSchema>;
export class ProposalListResponseDto extends createZodDto(proposalListResponseSchema) {}

export const noteProposalResponseSchema = z.object({ proposal: proposalDetailSchema.nullable() });
export type NoteProposalResponse = z.infer<typeof noteProposalResponseSchema>;
export class NoteProposalResponseDto extends createZodDto(noteProposalResponseSchema) {}

// -----------------------------------------------------------------------------
// Review decisions
// -----------------------------------------------------------------------------

export const endpointTargetSchema = z.union([
  z.object({ entityId: z.guid() }).strict(),
  z.object({ ref: z.string().min(1).max(40) }).strict(),
]);
export type EndpointTarget = z.infer<typeof endpointTargetSchema>;

export const evidenceSpanInputSchema = z.discriminatedUnion('source', [
  z
    .object({
      source: z.literal('note'),
      noteVersion: z.number().int().min(1),
      charStart: z.number().int().min(0),
      charEnd: z.number().int().min(1),
      quote: z.string().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      source: z.literal('segment'),
      segmentId: z.guid(),
      segmentRev: z.number().int().min(1),
      charStart: z.number().int().min(0),
      charEnd: z.number().int().min(1),
      quote: z.string().min(1).max(2000),
    })
    .strict(),
]);
export type EvidenceSpanInput = z.infer<typeof evidenceSpanInputSchema>;

export const RELINK_FIELDS = ['from', 'to', 'subject', 'owner', 'counterparty', 'meeting'] as const;
export type RelinkField = (typeof RELINK_FIELDS)[number];

export const patchItemSchema = z
  .object({
    decision: decisionSchema,
    editedPayload: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Required iff `decision` is `edit`: the full payload of the row\'s kind.'),
    mergeIntoId: z.guid().optional().describe('Required iff `decision` is `merge_into` (entity rows only): "this is the existing X".'),
    relinkTo: z
      .object({
        field: z.enum(RELINK_FIELDS),
        target: endpointTargetSchema.nullable().describe('`null` only for owner/counterparty/meeting.'),
      })
      .strict()
      .optional()
      .describe('Relation/item rows: re-point one endpoint.'),
    distinctFrom: z.array(z.guid()).max(10).optional().describe('Entity rows: "not the same as" these candidates.'),
    evidence: z
      .object({
        add: z.array(evidenceSpanInputSchema).max(10).default([]),
        remove: z.array(z.guid()).max(50).default([]),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PatchItemDto = z.infer<typeof patchItemSchema>;
export class PatchItemBodyDto extends createZodDto(patchItemSchema) {}

export const itemDecisionResponseSchema = z.object({ item: proposalItemViewSchema, counts: proposalCountsSchema });
export type ItemDecisionResponse = z.infer<typeof itemDecisionResponseSchema>;
export class ItemDecisionResponseDto extends createZodDto(itemDecisionResponseSchema) {}

export const bulkDecisionSchema = z
  .object({
    itemIds: z.array(z.guid()).min(1).max(500),
    decision: z.enum(['accept', 'reject', 'pending']),
  })
  .strict();
export type BulkDecisionDto = z.infer<typeof bulkDecisionSchema>;
export class BulkDecisionBodyDto extends createZodDto(bulkDecisionSchema) {}

export const BULK_SKIP_REASONS = ['not_found', 'sensitive_requires_individual_accept', 'closing_requires_individual_accept'] as const;
export type BulkSkipReason = (typeof BULK_SKIP_REASONS)[number];

export const bulkDecisionResponseSchema = z.object({
  updated: z.number().int(),
  skipped: z.array(z.object({ itemId: z.guid(), reason: z.enum(BULK_SKIP_REASONS) })),
  counts: proposalCountsSchema,
});
export type BulkDecisionResponse = z.infer<typeof bulkDecisionResponseSchema>;
export class BulkDecisionResponseDto extends createZodDto(bulkDecisionResponseSchema) {}

export const addItemSchema = z
  .object({
    kind: z.enum(['entity', 'relation', 'item']),
    payload: z
      .record(z.string(), z.unknown())
      .describe('Entity/relation/item payload. `ref` is assigned by the server (`u1`, `u2`, …); an item\'s `statementHash` is computed by it.'),
    existingEntityId: z.guid().optional().describe('Entity rows only: it is this existing entity (→ decision `merge_into`).'),
    evidence: z.array(evidenceSpanInputSchema).min(1).max(10),
  })
  .strict();
export type AddItemDto = z.infer<typeof addItemSchema>;
export class AddItemBodyDto extends createZodDto(addItemSchema) {}

// -----------------------------------------------------------------------------
// Commit, discard, revert
// -----------------------------------------------------------------------------

export const emptyBodySchema = z.object({}).strict();
export class EmptyProposalBodyDto extends createZodDto(emptyBodySchema) {}

export const commitResultSchema = z.object({
  created: z.object({ entities: z.number().int(), relations: z.number().int(), items: z.number().int() }),
  linked: z.number().int().describe('Rows linked to an existing entity (`merge_into` / `resolution.ref` accepts).'),
  evidenceAdded: z.number().int().describe('Evidence rows written, including known/same appends.'),
  closingsApplied: z.number().int(),
  closingsSkipped: z.number().int(),
  superseded: z.number().int(),
  aliasesAdded: z.number().int(),
  distinctPairsRecorded: z.number().int(),
  skippedPending: z.number().int().describe('Rows still `pending`: not committed and not remembered as rejected.'),
});
export type CommitResult = z.infer<typeof commitResultSchema>;

export const commitResponseSchema = z.object({ proposal: proposalSummarySchema, result: commitResultSchema });
export type CommitResponse = z.infer<typeof commitResponseSchema>;
export class CommitResponseDto extends createZodDto(commitResponseSchema) {}

export const proposalResponseSchema = z.object({ proposal: proposalSummarySchema });
export type ProposalResponse = z.infer<typeof proposalResponseSchema>;
export class ProposalResponseDto extends createZodDto(proposalResponseSchema) {}

export const revertBodySchema = z
  .object({
    confirmPartial: z
      .boolean()
      .default(false)
      .describe('Revert what can be reverted even when some rows changed since (they are kept and listed).'),
  })
  .strict();
export type RevertBody = z.infer<typeof revertBodySchema>;
export class RevertBodyDto extends createZodDto(revertBodySchema) {}

export const REVERT_KEPT_KINDS = ['entity', 'relation', 'item', 'closing', 'alias', 'item_change'] as const;
export const REVERT_KEPT_WHY = ['edited_since', 'referenced_since', 'merged_since', 'evidence_since'] as const;

export const revertKeptSchema = z.object({
  kind: z.enum(REVERT_KEPT_KINDS),
  id: z.guid(),
  label: z.string(),
  why: z.enum(REVERT_KEPT_WHY),
});
export type RevertKept = z.infer<typeof revertKeptSchema>;

export const revertResultSchema = z.object({
  reverted: z.number().int(),
  kept: z.array(revertKeptSchema),
});
export type RevertResult = z.infer<typeof revertResultSchema>;

export const revertResponseSchema = z.object({ proposal: proposalSummarySchema, result: revertResultSchema });
export type RevertResponse = z.infer<typeof revertResponseSchema>;
export class RevertResponseDto extends createZodDto(revertResponseSchema) {}

// -----------------------------------------------------------------------------
// 400 reasons (not 409s — a request invalid in itself; see graph-conflict-reasons.ts)
// -----------------------------------------------------------------------------

export const PROPOSAL_BAD_REQUEST_REASONS = {
  SPAN_MISMATCH: 'span_mismatch',
  SPAN_OUTSIDE_SOURCE: 'span_outside_source',
  WOULD_ORPHAN: 'would_orphan',
} as const;

/** Commit 400 `details.items[].issues[].code` values beyond Zod's own. */
export const COMMIT_ISSUE_CODES = {
  ENDPOINT_NOT_ACCEPTED: 'endpoint_not_accepted',
  ENDPOINT_GONE: 'endpoint_gone',
  MERGE_TARGET_GONE: 'merge_target_gone',
  LINK_TARGET_GONE: 'link_target_gone',
  INVALID: 'invalid',
} as const;
