/**
 * The review queue and the batch commit (#721, epic #708; API #717).
 *
 * Bulk-imported notes each produce one draft extraction proposal; reviewing
 * hundreds of them one sheet at a time is not a workflow. These two endpoints
 * are what the Review Queue page stands on:
 *
 *   - `GET /api/graph/review-queue?limit=` (`graph:read`): the caller's open
 *     drafts grouped by library, import batch or neither, with per-proposal
 *     row counts split into "safe" (the safe policy would accept them) and
 *     "waiting" (a person must decide).
 *   - `POST /api/graph/proposals/commit-batch` (`graph:write`): apply the safe
 *     policy to one library, one batch or a list of proposals, commit each
 *     proposal on its own, and move the waiting rows into a new draft.
 *
 * The wire shapes are the contract's (`@marinoscar/kvox-contract/graph`,
 * `review-queue.ts`), re-exported here so a host imports one module.
 */

import { REVIEW_QUEUE_MAX_PROPOSALS as CONTRACT_REVIEW_QUEUE_MAX_PROPOSALS } from '@marinoscar/kvox-contract/graph';
import type {
  CommitBatchResponse as ContractCommitBatchResponse,
  CommitBatchResult as ContractCommitBatchResult,
  ReviewQueueCounts as ContractReviewQueueCounts,
  ReviewQueueGroup as ContractReviewQueueGroup,
  ReviewQueueGroupKey as ContractReviewQueueGroupKey,
  ReviewQueueProposal as ContractReviewQueueProposal,
  ReviewQueueResponse as ContractReviewQueueResponse,
  ReviewQueueTotals as ContractReviewQueueTotals,
  SafePolicyWaitReason as ContractSafePolicyWaitReason,
} from '@marinoscar/kvox-contract/graph';

import { kvoxGet, kvoxPost } from '../../../core/headless/index.js';
import type { KvoxWebHost } from '../../../core/headless/index.js';

/**
 * Why the safe policy keeps a row for a person: `sensitive`, `closing`,
 * `ambiguous`, `merge`, `low_confidence`, `flagged` or `blocked_endpoint`.
 * Alias of the contract's `SafePolicyWaitReason`.
 *
 * @stability experimental
 */
export type SafePolicyWaitReason = ContractSafePolicyWaitReason;

/**
 * The group a queued proposal belongs to: a library, an import batch, or
 * `other` (no batch; `id` is `null`), with the server's label. Alias of the
 * contract's `ReviewQueueGroupKey`.
 *
 * @stability experimental
 */
export type ReviewQueueGroupKey = ContractReviewQueueGroupKey;

/**
 * Row counts of one queued proposal: `total`, `safe` (accepted already or
 * acceptable by the safe policy) and `waiting` (kept for a person). Alias of
 * the contract's `ReviewQueueCounts`.
 *
 * @stability experimental
 */
export type ReviewQueueCounts = ContractReviewQueueCounts;

/**
 * One queued draft: its proposal, note, note version, whether it is stale, its
 * counts and when it was created. Alias of the contract's `ReviewQueueProposal`.
 *
 * @stability experimental
 */
export type ReviewQueueProposal = ContractReviewQueueProposal;

/**
 * Totals of a group or of the whole queue: proposals, stale proposals, and
 * total, safe and waiting rows. Alias of the contract's `ReviewQueueTotals`.
 *
 * @stability experimental
 */
export type ReviewQueueTotals = ContractReviewQueueTotals;

/**
 * One group of the queue: its key, its proposals and its totals. Alias of the
 * contract's `ReviewQueueGroup`.
 *
 * @stability experimental
 */
export type ReviewQueueGroup = ContractReviewQueueGroup;

/**
 * The answer of `GET /api/graph/review-queue`: the groups, the totals, the
 * confidence floor the counts were computed with, and whether the list was cut.
 * Alias of the contract's `ReviewQueueResponse`.
 *
 * @stability experimental
 */
export type ReviewQueueResponse = ContractReviewQueueResponse;

/**
 * One proposal's outcome in a batch commit: `committed`, `skipped` or `failed`,
 * the rows accepted and waiting, a `reason`, and the new draft holding the
 * waiting rows. Alias of the contract's `CommitBatchResult`.
 *
 * @stability experimental
 */
export type CommitBatchResult = ContractCommitBatchResult;

/**
 * The answer of `POST /api/graph/proposals/commit-batch`. Alias of the
 * contract's `CommitBatchResponse`.
 *
 * @stability experimental
 */
export type CommitBatchResponse = ContractCommitBatchResponse;

/**
 * Most proposals one queue read returns and one batch commit names (the API's cap).
 *
 * @stability experimental
 */
export const REVIEW_QUEUE_MAX_PROPOSALS: number = CONTRACT_REVIEW_QUEUE_MAX_PROPOSALS;

/**
 * A batch commit of one library's drafts.
 *
 * @stability experimental
 */
export interface CommitLibraryTarget {
  /** The library. */
  libraryId: string;
}

/**
 * A batch commit of one import batch's drafts.
 *
 * @stability experimental
 */
export interface CommitImportBatchTarget {
  /** The import batch. */
  batchId: string;
}

/**
 * A batch commit of named proposals.
 *
 * @stability experimental
 */
export interface CommitProposalsTarget {
  /** The proposals, at most {@link REVIEW_QUEUE_MAX_PROPOSALS}. */
  proposalIds: readonly string[];
}

/**
 * What a batch commit applies the safe policy to: exactly one library, one
 * import batch, or a list of proposals.
 *
 * @stability experimental
 */
export type CommitBatchTarget = CommitImportBatchTarget | CommitLibraryTarget | CommitProposalsTarget;

/**
 * `GET /api/graph/review-queue`: the caller's open drafts, grouped.
 *
 * @param host - The host.
 * @param limit - At most this many proposals (1 to {@link REVIEW_QUEUE_MAX_PROPOSALS}); the server's default is the maximum.
 * @param signal - Aborts the request.
 * @returns The groups, the totals, the confidence floor the counts used, and whether the list was cut.
 *
 * @stability experimental
 */
export async function getReviewQueue(
  host: KvoxWebHost,
  limit?: number,
  signal?: AbortSignal,
): Promise<ReviewQueueResponse> {
  const answer = await kvoxGet<Partial<ReviewQueueResponse> | null>(host, '/graph/review-queue', {
    query: { limit },
    ...(signal ? { signal } : {}),
  });
  const empty = { proposals: 0, stale: 0, total: 0, safe: 0, waiting: 0 };
  return {
    groups: Array.isArray(answer?.groups) ? answer.groups : [],
    totals: answer?.totals ?? empty,
    minConfidence: typeof answer?.minConfidence === 'number' ? answer.minConfidence : 0.7,
    truncated: answer?.truncated === true,
  };
}

/**
 * `POST /api/graph/proposals/commit-batch` with the safe policy.
 *
 * @param host - The host.
 * @param target - One library, one batch, or the proposals to commit.
 * @returns One outcome per proposal.
 *
 * @stability experimental
 */
export async function commitBatch(host: KvoxWebHost, target: CommitBatchTarget): Promise<CommitBatchResult[]> {
  const body = 'proposalIds' in target ? { proposalIds: [...target.proposalIds] } : { ...target };
  const answer = await kvoxPost<Partial<CommitBatchResponse> | null>(host, '/graph/proposals/commit-batch', {
    ...body,
    policy: 'safe',
  });
  return Array.isArray(answer?.results) ? answer.results : [];
}
