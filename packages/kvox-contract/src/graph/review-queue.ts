import { z } from 'zod';

// =============================================================================
// Review queue and batch commit DTOs (#717, epic #708; ADR-0007)
// =============================================================================
//
// `GET /api/graph/review-queue` lists the caller's open draft proposals grouped
// by import batch / library. `POST /api/graph/proposals/commit-batch` applies the
// SAFE policy to many drafts: it accepts the rows that need no person, commits
// each proposal on its own, and keeps the rest for review.
//
// The safe policy never accepts a sensitive person fact, a closing, an
// ambiguous resolution or a merge, a row below the caller's
// `graph.review.minConfidence`, or any row of a stale proposal.
// =============================================================================

/**
 * Most proposals one request names or one queue page returns.
 *
 * @stability experimental
 */
export const REVIEW_QUEUE_MAX_PROPOSALS = 500;

/**
 * Wire constant: why a row stays in the draft under the safe policy.
 *
 * @stability experimental
 */
export const SAFE_POLICY_WAIT_REASONS = [
  'sensitive',
  'closing',
  'ambiguous',
  'merge',
  'low_confidence',
  'flagged',
  'blocked_endpoint',
] as const;

/**
 * Zod schema for {@link SAFE_POLICY_WAIT_REASONS}.
 *
 * @stability experimental
 */
export const safePolicyWaitReasonSchema = z.enum(SAFE_POLICY_WAIT_REASONS);

/**
 * The parsed shape of {@link safePolicyWaitReasonSchema}.
 *
 * @stability experimental
 */
export type SafePolicyWaitReason = z.infer<typeof safePolicyWaitReasonSchema>;

/**
 * Zod schema for the group a queued proposal belongs to.
 *
 * @stability experimental
 */
export const reviewQueueGroupKeySchema = z.object({
  type: z.enum(['batch', 'library', 'other']),
  id: z.guid().nullable().describe('The batch or library id; null for `other` (a note imported outside any batch).'),
  label: z.string(),
});

/**
 * The parsed shape of {@link reviewQueueGroupKeySchema}.
 *
 * @stability experimental
 */
export type ReviewQueueGroupKey = z.infer<typeof reviewQueueGroupKeySchema>;

/**
 * Zod schema for the row counts of one queued proposal.
 *
 * @stability experimental
 */
export const reviewQueueCountsSchema = z.object({
  total: z.number().int(),
  safe: z.number().int().describe('Rows already accepted plus rows the safe policy would accept.'),
  waiting: z.number().int().describe('Rows the safe policy keeps for a person.'),
});

/**
 * The parsed shape of {@link reviewQueueCountsSchema}.
 *
 * @stability experimental
 */
export type ReviewQueueCounts = z.infer<typeof reviewQueueCountsSchema>;

/**
 * Zod schema for one queued proposal.
 *
 * @stability experimental
 */
export const reviewQueueProposalSchema = z.object({
  proposalId: z.guid(),
  noteId: z.guid().nullable(),
  noteTitle: z.string().nullable(),
  noteVersion: z.number().int().nullable(),
  stale: z.boolean().describe('The note changed since the proposal was extracted; a stale proposal is never batch-committed.'),
  counts: reviewQueueCountsSchema,
  createdAt: z.string(),
});

/**
 * The parsed shape of {@link reviewQueueProposalSchema}.
 *
 * @stability experimental
 */
export type ReviewQueueProposal = z.infer<typeof reviewQueueProposalSchema>;

/**
 * Zod schema for the totals of a group or of the whole queue.
 *
 * @stability experimental
 */
export const reviewQueueTotalsSchema = z.object({
  proposals: z.number().int(),
  stale: z.number().int(),
  total: z.number().int(),
  safe: z.number().int(),
  waiting: z.number().int(),
});

/**
 * The parsed shape of {@link reviewQueueTotalsSchema}.
 *
 * @stability experimental
 */
export type ReviewQueueTotals = z.infer<typeof reviewQueueTotalsSchema>;

/**
 * Zod schema for one group of the queue.
 *
 * @stability experimental
 */
export const reviewQueueGroupSchema = z.object({
  key: reviewQueueGroupKeySchema,
  proposals: z.array(reviewQueueProposalSchema),
  totals: reviewQueueTotalsSchema,
});

/**
 * The parsed shape of {@link reviewQueueGroupSchema}.
 *
 * @stability experimental
 */
export type ReviewQueueGroup = z.infer<typeof reviewQueueGroupSchema>;

/**
 * Zod schema for the query of `GET /api/graph/review-queue`.
 *
 * @stability experimental
 */
export const reviewQueueQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(REVIEW_QUEUE_MAX_PROPOSALS).default(REVIEW_QUEUE_MAX_PROPOSALS),
  })
  .strict();

/**
 * The parsed shape of {@link reviewQueueQuerySchema}.
 *
 * @stability experimental
 */
export type ReviewQueueQuery = z.infer<typeof reviewQueueQuerySchema>;

/**
 * Zod schema for the response of `GET /api/graph/review-queue`.
 *
 * @stability experimental
 */
export const reviewQueueResponseSchema = z.object({
  groups: z.array(reviewQueueGroupSchema),
  totals: reviewQueueTotalsSchema,
  minConfidence: z.number().min(0).max(1).describe('The caller\'s `graph.review.minConfidence` the counts were computed with.'),
  truncated: z.boolean().describe('More drafts exist than `limit`; the newest are listed.'),
});

/**
 * The parsed shape of {@link reviewQueueResponseSchema}.
 *
 * @stability experimental
 */
export type ReviewQueueResponse = z.infer<typeof reviewQueueResponseSchema>;

/**
 * Zod schema for the body of `POST /api/graph/proposals/commit-batch`: exactly one of
 * `batchId`, `libraryId`, `proposalIds`.
 *
 * @stability experimental
 */
export const commitBatchSchema = z
  .object({
    batchId: z.guid().optional(),
    libraryId: z.guid().optional(),
    proposalIds: z.array(z.guid()).min(1).max(REVIEW_QUEUE_MAX_PROPOSALS).optional(),
    policy: z.literal('safe'),
  })
  .strict()
  .refine(
    (b) => [b.batchId, b.libraryId, b.proposalIds].filter((v) => v !== undefined).length === 1,
    { message: 'Send exactly one of batchId, libraryId or proposalIds.' },
  );

/**
 * The parsed shape of {@link commitBatchSchema}.
 *
 * @stability experimental
 */
export type CommitBatchDto = z.infer<typeof commitBatchSchema>;

/**
 * Zod schema for one proposal's outcome in a batch commit.
 *
 * @stability experimental
 */
export const commitBatchResultSchema = z.object({
  proposalId: z.guid(),
  status: z.enum(['committed', 'skipped', 'failed']),
  accepted: z.number().int().describe('Rows accepted (earlier by a person plus newly by the policy).'),
  waiting: z.number().int().describe('Rows the policy kept for a person.'),
  reason: z.string().optional().describe('Why a proposal was skipped (`stale`, `not_draft`, `nothing_to_commit`) or failed (an error code).'),
  remainderProposalId: z.guid().nullable().optional().describe('The new draft that now holds the waiting rows of a committed proposal.'),
});

/**
 * The parsed shape of {@link commitBatchResultSchema}.
 *
 * @stability experimental
 */
export type CommitBatchResult = z.infer<typeof commitBatchResultSchema>;

/**
 * Zod schema for the response of `POST /api/graph/proposals/commit-batch`.
 *
 * @stability experimental
 */
export const commitBatchResponseSchema = z.object({
  results: z.array(commitBatchResultSchema),
});

/**
 * The parsed shape of {@link commitBatchResponseSchema}.
 *
 * @stability experimental
 */
export type CommitBatchResponse = z.infer<typeof commitBatchResponseSchema>;

/**
 * The response of `POST /api/graph/import-batches/:batchId/retry-extractions`: how many notes
 * of the batch were queued for graph extraction again (#716).
 *
 * @stability experimental
 */
export const retryExtractionsResponseSchema = z.object({
  requeued: z.number().int().min(0),
});

/**
 * The parsed shape of {@link retryExtractionsResponseSchema}.
 *
 * @stability experimental
 */
export type RetryExtractionsResponse = z.infer<typeof retryExtractionsResponseSchema>;
