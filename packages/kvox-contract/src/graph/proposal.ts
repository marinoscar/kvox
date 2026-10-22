import { z } from 'zod';
import { userGuidanceSchema } from './extraction.js';
import { resolutionSchema } from './proposal-payload.schema.js';

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

/**
 * Zod schema for the proposal status wire shape.
 *
 * @stability experimental
 */
export const proposalStatusSchema = z.enum(['extracting', 'draft', 'committed', 'discarded', 'failed', 'reverted']);
/**
 * The parsed shape of {@link proposalStatusSchema}.
 *
 * @stability experimental
 */
export type ProposalStatus = z.infer<typeof proposalStatusSchema>;
/**
 * Zod schema for the proposal kind wire shape.
 *
 * @stability experimental
 */
export const proposalKindSchema = z.enum(['extraction', 'import', 'resolution']);
/**
 * Zod schema for the decision wire shape.
 *
 * @stability experimental
 */
export const decisionSchema = z.enum(['pending', 'accept', 'edit', 'reject', 'merge_into']);
/**
 * The parsed shape of {@link decisionSchema}.
 *
 * @stability experimental
 */
export type ProposalDecision = z.infer<typeof decisionSchema>;

/**
 * Wire constant: group keys.
 *
 * @stability experimental
 */
export const GROUP_KEYS = [
  'Person',
  'Organization',
  'Project',
  'Meeting',
  'Decision',
  'Commitment',
  'Risk',
  'Claim',
  'PersonFact',
  'Other',
  'relations',
  'closings',
] as const;
/**
 * `Other` = any further entity type from the effective schema; the web renders its own label.
 *
 * @stability experimental
 */
export const groupKeySchema = z.enum(GROUP_KEYS);
/**
 * The parsed shape of {@link groupKeySchema}.
 *
 * @stability experimental
 */
export type GroupKey = z.infer<typeof groupKeySchema>;

/**
 * Zod schema for the proposal counts wire shape.
 *
 * @stability experimental
 */
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
/**
 * The parsed shape of {@link proposalCountsSchema}.
 *
 * @stability experimental
 */
export type ProposalCounts = z.infer<typeof proposalCountsSchema>;

/**
 * Zod schema for the proposal summary wire shape.
 *
 * @stability experimental
 */
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
/**
 * The parsed shape of {@link proposalSummarySchema}.
 *
 * @stability experimental
 */
export type ProposalSummary = z.infer<typeof proposalSummarySchema>;

/**
 * Zod schema for the evidence view wire shape.
 *
 * @stability experimental
 */
export const evidenceViewSchema = z.object({
  id: z.guid(),
  source: z.enum(['segment', 'note', 'import']).describe('`import` (#387): the row came from an uploaded RDF file — cited to the file itself.'),
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
  importObjectId: z.guid().nullable().describe('Import evidence: the stored file the row was imported from.'),
  sourceIri: z.string().nullable().describe('Import evidence: the node’s IRI in that file.'),
  speakerName: z.string().nullable().describe('Segment evidence: the speaker\'s display name at read time.'),
  hasAudio: z
    .boolean()
    .describe(
      'Segment evidence (#604): whether the cited transcript has a recording to play. False for a ' +
        'transcript imported from a kvox.transcript/v1 file (its audio route answers 404), for a ' +
        'transcript that no longer exists, and for note and import evidence.',
    ),
  stale: z.boolean().describe('The cited text changed since (segment rev or note version moved on), or its source is gone.'),
});
/**
 * The parsed shape of {@link evidenceViewSchema}.
 *
 * @stability experimental
 */
export type EvidenceView = z.infer<typeof evidenceViewSchema>;

/**
 * Wire constant: proposal item kinds.
 *
 * @stability experimental
 */
export const PROPOSAL_ITEM_KINDS = ['entity', 'relation', 'item', 'closing'] as const;
/**
 * The `ProposalItemKind` type (proposal item kind).
 *
 * @stability experimental
 */
export type ProposalItemKind = (typeof PROPOSAL_ITEM_KINDS)[number];

/**
 * Zod schema for the proposal item view wire shape.
 *
 * @stability experimental
 */
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
  fills: z
    .record(z.string(), z.unknown())
    .nullable()
    .describe(
      'A `known` relation row only (#444): the props committing it would ADD to the live relation it matched — keys that relation does not hold yet. Null for every other row, or when there is nothing to add.',
    ),
});
/**
 * The parsed shape of {@link proposalItemViewSchema}.
 *
 * @stability experimental
 */
export type ProposalItemView = z.infer<typeof proposalItemViewSchema>;

/**
 * Zod schema for the proposal detail wire shape.
 *
 * @stability experimental
 */
export const proposalDetailSchema = z.object({
  proposal: proposalSummarySchema,
  items: z.array(proposalItemViewSchema).describe('Ordered by review group, then `display.title`.'),
  context: z
    .object({ systemPrompt: z.string(), userContent: z.string() })
    .nullable()
    .describe('The exact prompt the extraction sent — only with `?include=context`.'),
});
/**
 * The parsed shape of {@link proposalDetailSchema}.
 *
 * @stability experimental
 */
export type ProposalDetail = z.infer<typeof proposalDetailSchema>;

// -----------------------------------------------------------------------------
// Queries
// -----------------------------------------------------------------------------

/**
 * Zod schema for the list proposals query wire shape.
 *
 * @stability experimental
 */
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
/**
 * The parsed shape of {@link listProposalsQuerySchema}.
 *
 * @stability experimental
 */
export type ListProposalsQuery = z.infer<typeof listProposalsQuerySchema>;

/**
 * Zod schema for the get proposal query wire shape.
 *
 * @stability experimental
 */
export const getProposalQuerySchema = z
  .object({ include: z.enum(['context']).optional() })
  .strict();
/**
 * The parsed shape of {@link getProposalQuerySchema}.
 *
 * @stability experimental
 */
export type GetProposalQuery = z.infer<typeof getProposalQuerySchema>;

/**
 * Zod schema for the proposal list response wire shape.
 *
 * @stability experimental
 */
export const proposalListResponseSchema = z.object({
  items: z.array(proposalSummarySchema),
  nextCursor: z.string().nullable(),
});
/**
 * The parsed shape of {@link proposalListResponseSchema}.
 *
 * @stability experimental
 */
export type ProposalListResponse = z.infer<typeof proposalListResponseSchema>;

/**
 * Zod schema for the note proposal response wire shape.
 *
 * @stability experimental
 */
export const noteProposalResponseSchema = z.object({ proposal: proposalDetailSchema.nullable() });
/**
 * The parsed shape of {@link noteProposalResponseSchema}.
 *
 * @stability experimental
 */
export type NoteProposalResponse = z.infer<typeof noteProposalResponseSchema>;

// -----------------------------------------------------------------------------
// Review decisions
// -----------------------------------------------------------------------------

/**
 * Zod schema for the endpoint target wire shape.
 *
 * @stability experimental
 */
export const endpointTargetSchema = z.union([
  z.object({ entityId: z.guid() }).strict(),
  z.object({ ref: z.string().min(1).max(40) }).strict(),
]);
/**
 * The parsed shape of {@link endpointTargetSchema}.
 *
 * @stability experimental
 */
export type EndpointTarget = z.infer<typeof endpointTargetSchema>;

/**
 * Zod schema for the evidence span input wire shape.
 *
 * @stability experimental
 */
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
/**
 * The parsed shape of {@link evidenceSpanInputSchema}.
 *
 * @stability experimental
 */
export type EvidenceSpanInput = z.infer<typeof evidenceSpanInputSchema>;

/**
 * Wire constant: relink fields.
 *
 * @stability experimental
 */
export const RELINK_FIELDS = ['from', 'to', 'subject', 'owner', 'counterparty', 'meeting'] as const;
/**
 * The `RelinkField` type (relink field).
 *
 * @stability experimental
 */
export type RelinkField = (typeof RELINK_FIELDS)[number];

/**
 * Zod schema for the patch item wire shape.
 *
 * @stability experimental
 */
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
/**
 * The parsed shape of {@link patchItemSchema}.
 *
 * @stability experimental
 */
export type PatchItemDto = z.infer<typeof patchItemSchema>;

/**
 * Zod schema for the item decision response wire shape.
 *
 * @stability experimental
 */
export const itemDecisionResponseSchema = z.object({ item: proposalItemViewSchema, counts: proposalCountsSchema });
/**
 * The parsed shape of {@link itemDecisionResponseSchema}.
 *
 * @stability experimental
 */
export type ItemDecisionResponse = z.infer<typeof itemDecisionResponseSchema>;

/**
 * Zod schema for the bulk decision wire shape.
 *
 * @stability experimental
 */
export const bulkDecisionSchema = z
  .object({
    itemIds: z.array(z.guid()).min(1).max(500),
    decision: z.enum(['accept', 'reject', 'pending']),
  })
  .strict();
/**
 * The parsed shape of {@link bulkDecisionSchema}.
 *
 * @stability experimental
 */
export type BulkDecisionDto = z.infer<typeof bulkDecisionSchema>;

/**
 * Wire constant: bulk skip reasons.
 *
 * @stability experimental
 */
export const BULK_SKIP_REASONS = ['not_found', 'sensitive_requires_individual_accept', 'closing_requires_individual_accept'] as const;
/**
 * The `BulkSkipReason` type (bulk skip reason).
 *
 * @stability experimental
 */
export type BulkSkipReason = (typeof BULK_SKIP_REASONS)[number];

/**
 * Zod schema for the bulk decision response wire shape.
 *
 * @stability experimental
 */
export const bulkDecisionResponseSchema = z.object({
  updated: z.number().int(),
  skipped: z.array(z.object({ itemId: z.guid(), reason: z.enum(BULK_SKIP_REASONS) })),
  counts: proposalCountsSchema,
});
/**
 * The parsed shape of {@link bulkDecisionResponseSchema}.
 *
 * @stability experimental
 */
export type BulkDecisionResponse = z.infer<typeof bulkDecisionResponseSchema>;

/**
 * Zod schema for the add item wire shape.
 *
 * @stability experimental
 */
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
/**
 * The parsed shape of {@link addItemSchema}.
 *
 * @stability experimental
 */
export type AddItemDto = z.infer<typeof addItemSchema>;

// -----------------------------------------------------------------------------
// Commit, discard, revert
// -----------------------------------------------------------------------------

/**
 * Zod schema for the empty body wire shape.
 *
 * @stability experimental
 */
export const emptyBodySchema = z.object({}).strict();

/**
 * Zod schema for the commit result wire shape.
 *
 * @stability experimental
 */
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
  propsFilled: z
    .number()
    .int()
    .describe('Props a `known` relation row added to the live relation it matched (#444) — only keys that relation did not hold; never an overwrite.'),
});
/**
 * The parsed shape of {@link commitResultSchema}.
 *
 * @stability experimental
 */
export type CommitResult = z.infer<typeof commitResultSchema>;

/**
 * Zod schema for the commit response wire shape.
 *
 * @stability experimental
 */
export const commitResponseSchema = z.object({ proposal: proposalSummarySchema, result: commitResultSchema });
/**
 * The parsed shape of {@link commitResponseSchema}.
 *
 * @stability experimental
 */
export type CommitResponse = z.infer<typeof commitResponseSchema>;

/**
 * Zod schema for the proposal response wire shape.
 *
 * @stability experimental
 */
export const proposalResponseSchema = z.object({ proposal: proposalSummarySchema });
/**
 * The parsed shape of {@link proposalResponseSchema}.
 *
 * @stability experimental
 */
export type ProposalResponse = z.infer<typeof proposalResponseSchema>;

/**
 * Zod schema for the revert body wire shape.
 *
 * @stability experimental
 */
export const revertBodySchema = z
  .object({
    confirmPartial: z
      .boolean()
      .default(false)
      .describe('Revert what can be reverted even when some rows changed since (they are kept and listed).'),
  })
  .strict();
/**
 * The parsed shape of {@link revertBodySchema}.
 *
 * @stability experimental
 */
export type RevertBody = z.infer<typeof revertBodySchema>;

/**
 * Wire constant: revert kept kinds.
 *
 * @stability experimental
 */
export const REVERT_KEPT_KINDS = ['entity', 'relation', 'item', 'closing', 'alias', 'item_change', 'relation_fill'] as const;
/**
 * Wire constant: revert kept why.
 *
 * @stability experimental
 */
export const REVERT_KEPT_WHY = ['edited_since', 'referenced_since', 'merged_since', 'evidence_since'] as const;

/**
 * Zod schema for the revert kept wire shape.
 *
 * @stability experimental
 */
export const revertKeptSchema = z.object({
  kind: z.enum(REVERT_KEPT_KINDS),
  id: z.guid(),
  label: z.string(),
  why: z.enum(REVERT_KEPT_WHY),
});
/**
 * The parsed shape of {@link revertKeptSchema}.
 *
 * @stability experimental
 */
export type RevertKept = z.infer<typeof revertKeptSchema>;

/**
 * Zod schema for the revert result wire shape.
 *
 * @stability experimental
 */
export const revertResultSchema = z.object({
  reverted: z.number().int(),
  kept: z.array(revertKeptSchema),
});
/**
 * The parsed shape of {@link revertResultSchema}.
 *
 * @stability experimental
 */
export type RevertResult = z.infer<typeof revertResultSchema>;

/**
 * Zod schema for the revert response wire shape.
 *
 * @stability experimental
 */
export const revertResponseSchema = z.object({ proposal: proposalSummarySchema, result: revertResultSchema });
/**
 * The parsed shape of {@link revertResponseSchema}.
 *
 * @stability experimental
 */
export type RevertResponse = z.infer<typeof revertResponseSchema>;

// -----------------------------------------------------------------------------
// 400 reasons (not 409s — a request invalid in itself; see graph-conflict-reasons.ts)
// -----------------------------------------------------------------------------

/**
 * Wire constant: proposal bad request reasons.
 *
 * @stability experimental
 */
export const PROPOSAL_BAD_REQUEST_REASONS = {
  SPAN_MISMATCH: 'span_mismatch',
  SPAN_OUTSIDE_SOURCE: 'span_outside_source',
  WOULD_ORPHAN: 'would_orphan',
} as const;

/**
 * Commit 400 `details.items[].issues[].code` values beyond Zod's own.
 *
 * @stability experimental
 */
export const COMMIT_ISSUE_CODES = {
  ENDPOINT_NOT_ACCEPTED: 'endpoint_not_accepted',
  ENDPOINT_GONE: 'endpoint_gone',
  MERGE_TARGET_GONE: 'merge_target_gone',
  LINK_TARGET_GONE: 'link_target_gone',
  INVALID: 'invalid',
} as const;
