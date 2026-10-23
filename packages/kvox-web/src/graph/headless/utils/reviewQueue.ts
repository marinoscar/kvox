/**
 * Pure helpers of the Review Queue (#721): the plain-language copy of the safe
 * policy's waiting reasons, a group's label, and the summary of a batch
 * commit's outcomes. No React, no MUI: a host with another design system draws
 * the same sentences.
 */

import { SAFE_POLICY_WAIT_REASONS } from '@marinoscar/kvox-contract/graph';

import type {
  CommitBatchResult,
  ReviewQueueGroupKey,
  SafePolicyWaitReason,
} from '../clients/reviewQueue.js';

/**
 * The plain-language explanation of one waiting reason.
 *
 * @stability experimental
 */
export interface WaitReasonCopy {
  /** A short name for the reason. */
  title: string;
  /** One sentence saying why the row waits for a person. */
  body: string;
}

/**
 * Every reason the safe policy keeps a row for a person, in the order the
 * "What is safe?" explanation lists them.
 *
 * @stability experimental
 */
export const SAFE_POLICY_WAIT_REASON_ORDER: readonly SafePolicyWaitReason[] = SAFE_POLICY_WAIT_REASONS;

/**
 * Why a row waits for you, per reason. `low_confidence` mentions the floor; see
 * {@link waitReasonCopy} for the sentence with the caller's own value.
 *
 * @stability experimental
 */
export const SAFE_POLICY_WAIT_REASON_COPY: Readonly<Record<SafePolicyWaitReason, WaitReasonCopy>> = {
  sensitive: {
    title: 'Sensitive facts',
    body: 'Something personal about a person, such as health or beliefs. Only you decide what is kept.',
  },
  closing: {
    title: 'Closing something',
    body: 'It would mark something in your graph as finished or no longer true, such as a commitment done.',
  },
  merge: {
    title: 'Merging two entries',
    body: 'It would combine two people, organizations or projects into one.',
  },
  ambiguous: {
    title: 'Unclear matches',
    body: 'A name could be more than one entry already in your graph.',
  },
  low_confidence: {
    title: 'Low confidence',
    body: 'The AI was less sure than your minimum confidence.',
  },
  flagged: {
    title: 'Flagged by the AI',
    body: 'The AI asked for a second look, for example because it may contradict what you already have.',
  },
  blocked_endpoint: {
    title: 'Depends on another decision',
    body: 'It connects to an entry that is itself waiting for you.',
  },
};

/**
 * The explanation of one waiting reason, with the caller's minimum confidence
 * written into the `low_confidence` sentence.
 *
 * @param reason - The reason.
 * @param minConfidence - The caller's `graph.review.minConfidence` (0 to 1), when known.
 * @returns The title and sentence.
 *
 * @stability experimental
 */
export function waitReasonCopy(reason: SafePolicyWaitReason, minConfidence?: number): WaitReasonCopy {
  const copy = SAFE_POLICY_WAIT_REASON_COPY[reason];
  if (reason === 'low_confidence' && typeof minConfidence === 'number') {
    return { ...copy, body: `The AI was less sure than your minimum confidence (${Math.round(minConfidence * 100)}%).` };
  }
  return copy;
}

/**
 * A count with its noun: `1 draft`, `2,140 safe rows` (the number grouped for the locale).
 *
 * @param count - The number.
 * @param one - The phrase for exactly one.
 * @param many - The phrase for any other count.
 * @returns The phrase.
 *
 * @stability experimental
 */
export function countPhrase(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

const ISO_DAY = /^Import (\d{4})-(\d{2})-(\d{2})$/;

/**
 * The heading of one queue group: the library's name, the import's date, or
 * "Other notes" for notes imported outside any batch.
 *
 * @param key - The group's key, as the API sends it.
 * @returns The heading.
 *
 * @stability experimental
 */
export function reviewGroupLabel(key: ReviewQueueGroupKey): string {
  if (key.type === 'other') return 'Other notes';
  if (key.type === 'batch') {
    const day = ISO_DAY.exec(key.label);
    if (day) {
      const date = new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3])));
      return `Import of ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`;
    }
    return key.label || 'Import';
  }
  return key.label || 'Library';
}

/**
 * One proposal a batch commit did not commit because it failed.
 *
 * @stability experimental
 */
export interface CommitBatchFailure {
  /** The proposal. */
  proposalId: string;
  /** What the failure means, in a sentence. */
  message: string;
}

/**
 * What a batch commit did, counted.
 *
 * @stability experimental
 */
export interface CommitBatchSummary {
  /** Proposals committed (their safe rows are in the graph). */
  committed: number;
  /** Rows accepted across the committed proposals. */
  accepted: number;
  /** Rows kept for a person across every proposal. */
  waiting: number;
  /** Committed proposals whose waiting rows moved to a new draft. */
  remainders: number;
  /** Proposals skipped because the note changed since extraction. */
  stale: number;
  /** Proposals skipped for any other reason (already reviewed, nothing safe). */
  skipped: number;
  /** Proposals that failed, with why. */
  failures: CommitBatchFailure[];
}

/**
 * Why a proposal was skipped or failed, in a sentence.
 *
 * @param reason - The result's `reason`.
 * @returns The sentence.
 *
 * @stability experimental
 */
export function commitOutcomeMessage(reason: string | undefined): string {
  switch (reason) {
    case 'stale':
      return 'The note changed after it was read. Extract it again to review it.';
    case 'not_draft':
      return 'It was already reviewed.';
    case 'nothing_to_commit':
      return 'Nothing in it was safe to accept; every row waits for you.';
    case 'not_found':
      return 'It no longer exists.';
    case 'unsupported_kind':
      return 'It cannot be committed in a batch. Review it on its own.';
    case undefined:
    case '':
      return 'It could not be committed.';
    default:
      return `It could not be committed (${reason}).`;
  }
}

/**
 * Counts the outcomes of a batch commit.
 *
 * @param results - The API's per-proposal results.
 * @returns The summary.
 *
 * @stability experimental
 */
export function summarizeCommitBatch(results: readonly CommitBatchResult[]): CommitBatchSummary {
  const summary: CommitBatchSummary = {
    committed: 0,
    accepted: 0,
    waiting: 0,
    remainders: 0,
    stale: 0,
    skipped: 0,
    failures: [],
  };
  for (const result of results) {
    summary.waiting += result.waiting;
    if (result.status === 'committed') {
      summary.committed += 1;
      summary.accepted += result.accepted;
      if (result.remainderProposalId) summary.remainders += 1;
    } else if (result.status === 'skipped') {
      if (result.reason === 'stale') summary.stale += 1;
      else summary.skipped += 1;
    } else {
      summary.failures.push({ proposalId: result.proposalId, message: commitOutcomeMessage(result.reason) });
    }
  }
  return summary;
}
