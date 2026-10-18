/**
 * One graph proposal, read and reviewed (#367, epic #346).
 *
 * `source` is either the note the sheet is mounted on
 * (`GET /api/graph/notes/:noteId/proposal`, which answers `null` when nothing
 * was ever extracted) or a proposal opened directly (#368's Home card).
 *
 * - `detail` is `undefined` until the first answer, `null` for "no proposal".
 * - While the proposal is `extracting`, it is re-read every 2 s (`pollMs`) through
 *   `useVisiblePolling` (paused in a hidden tab) and polling stops the moment
 *   it settles.
 * - `awaitUntil` (#616) covers the proposal that does not exist YET: while
 *   `detail` is `null` the hook keeps re-reading every `pollMs` until that
 *   time, so a proposal an automatic extraction creates after the first read
 *   appears (and, being `extracting`, hands over to the poll above). Past the
 *   deadline with still nothing, polling stops.
 * - `decide` is OPTIMISTIC: the row's checkbox moves at once and moves back if
 *   the PATCH is refused (the error is re-thrown for the sheet's snackbar).
 *   `pendingItemIds` names the rows with a write in flight.
 * - Every mutation resolves with the server's answer and rejects with its
 *   `KvoxApiError`; the hook never swallows one.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  bulkDecideProposalItems,
  commitProposal,
  discardProposal,
  getNoteProposal,
  getProposal,
  patchProposalItem,
  requestExtraction,
  revertProposal,
} from '../clients/graph.js';
import type {
  BulkDecideResult,
  BulkDecision,
  CommitResult,
  PatchProposalItemInput,
  PatchProposalItemResult,
  ProposalDetail,
  ProposalItem,
  ProposalSummary,
  RequestExtractionInput,
  RequestExtractionResult,
  RevertResult,
} from '../clients/graph.js';
import { KvoxApiError, useIsMounted, useKvoxHost, useVisiblePolling } from '../../../core/headless/index.js';

/**
 * How often a proposal that is still `extracting` is re-read, in milliseconds.
 *
 * @stability experimental
 */
export const PROPOSAL_POLL_MS = 2_000;

/**
 * How long after a note turns ready the note page keeps looking for the
 * proposal an automatic extraction creates, in milliseconds (#616).
 *
 * @stability experimental
 */
export const NOTE_EXTRACTION_FOLLOW_MS = 30_000;

/**
 * Where a proposal is read from: the newest one of a note, or one opened directly by id.
 *
 * @stability experimental
 */
export type GraphProposalSource = {
  /** Note whose newest non-discarded proposal to read; it resolves to `null` when nothing was ever extracted. */
  noteId: string;
} | {
  /** Proposal to open directly. */
  proposalId: string;
};

/**
 * What {@link useGraphProposal} returns.
 *
 * @stability experimental
 */
export interface UseGraphProposalReturn {
  /** The proposal with its rows: `undefined` until the first answer, `null` when the note has no proposal. */
  detail: ProposalDetail | null | undefined;
  /** The first read has not settled yet. */
  isLoading: boolean;
  /** A message when the last read failed, else `null`. */
  error: string | null;
  /** Reads the proposal again. */
  refresh: () => Promise<void>;
  /** Records a decision on one row. Optimistic: the row changes at once and changes back if the request is refused, in which case the error is re-thrown. */
  decide: (itemId: string, body: PatchProposalItemInput) => Promise<PatchProposalItemResult>;
  /** Applies one decision to many rows, then re-reads the proposal because the server decides which rows it skipped. */
  bulk: (itemIds: string[], decision: BulkDecision) => Promise<BulkDecideResult>;
  /** Commits the proposal into the graph and stores the updated summary. */
  commit: () => Promise<{
    /** The proposal, now committed. */
    proposal: ProposalSummary;
    /** What the commit wrote. */
    result: CommitResult;
  }>;
  /** Discards the proposal and stores the updated summary. */
  discard: () => Promise<{
    /** The proposal, now discarded. */
    proposal: ProposalSummary;
  }>;
  /** Reverts a committed proposal; `confirmPartial` lets it revert what it can when some rows changed since. */
  revert: (confirmPartial: boolean) => Promise<{
    /** The proposal, now reverted. */
    proposal: ProposalSummary;
    /** How many rows were reverted and which were kept. */
    result: RevertResult;
  }>;
  /** Starts an extraction for the note and re-reads the proposal. Rejects when there is no note to extract from. */
  requestExtract: (body?: RequestExtractionInput) => Promise<RequestExtractionResult>;
  /** Ids of the rows with a write in flight. */
  pendingItemIds: Set<string>;
}

function sourceKey(source: GraphProposalSource): string {
  return 'noteId' in source ? `note:${source.noteId}` : `proposal:${source.proposalId}`;
}

/** What the row looks like the moment a decision is made, before the server answers. */
function optimistic(item: ProposalItem, body: PatchProposalItemInput): ProposalItem {
  return {
    ...item,
    decision: body.decision,
    mergeIntoId: body.decision === 'merge_into' ? (body.mergeIntoId ?? item.mergeIntoId) : item.mergeIntoId,
    distinctFrom: body.distinctFrom ?? item.distinctFrom,
  };
}

/**
 * Reads one proposal, polls it while it is extracting, and exposes the review mutations (decide, bulk, commit, discard, revert, request extraction).
 *
 * @stability experimental
 */
export function useGraphProposal(
  source: GraphProposalSource,
  options: {
    /** Set `false` to skip reading (default `true`). */
    enabled?: boolean;
    /** Poll interval while the proposal is `extracting`, in milliseconds; defaults to {@link PROPOSAL_POLL_MS}. Polling pauses in a hidden tab. */
    pollMs?: number;
    /**
     * Epoch milliseconds. While `detail` is `null`, also re-read every `pollMs`
     * until this time, so a proposal created after the first read (an automatic
     * extraction) appears. Polling pauses in a hidden tab.
     */
    awaitUntil?: number;
  } = {},
): UseGraphProposalReturn {
  const host = useKvoxHost();
  const enabled = options.enabled ?? true;
  const pollMs = options.pollMs ?? PROPOSAL_POLL_MS;
  const key = sourceKey(source);
  const [detail, setDetail] = useState<ProposalDetail | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [pendingItemIds, setPendingItemIds] = useState<Set<string>>(() => new Set());
  const isMounted = useIsMounted();

  // Read through refs so the callbacks keep a stable identity.
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const detailRef = useRef(detail);
  detailRef.current = detail;

  const refresh = useCallback(async () => {
    const current = sourceRef.current;
    try {
      const next =
        'noteId' in current ? await getNoteProposal(host, current.noteId) : await getProposal(host, current.proposalId);
      if (!isMounted() || sourceKey(sourceRef.current) !== sourceKey(current)) return;
      setDetail(next);
      setError(null);
    } catch (err) {
      if (!isMounted()) return;
      setError(err instanceof KvoxApiError ? err.message : 'This proposal could not be loaded');
    }
  }, [isMounted]);

  useEffect(() => {
    setDetail(undefined);
    setError(null);
    setPendingItemIds(new Set());
    if (enabled) void refresh();
  }, [enabled, key, refresh]);

  const awaitUntil = options.awaitUntil;
  const awaitUntilRef = useRef(awaitUntil);
  awaitUntilRef.current = awaitUntil;
  // Flipped by the poll once the deadline passes with still no proposal, which
  // stops the interval; a new deadline or a new source starts the wait again.
  const [awaitExpired, setAwaitExpired] = useState(false);
  useEffect(() => {
    setAwaitExpired(false);
  }, [awaitUntil, key]);

  const extracting = detail?.proposal.status === 'extracting';
  const awaiting = detail === null && awaitUntil !== undefined && !awaitExpired;
  const poll = useCallback(() => {
    const until = awaitUntilRef.current;
    if (detailRef.current === null && until !== undefined && Date.now() >= until) {
      setAwaitExpired(true);
      return;
    }
    void refresh();
  }, [refresh]);
  useVisiblePolling(poll, enabled && (extracting || awaiting) ? pollMs : 0);

  const proposalId = useCallback((): string => {
    const id = detailRef.current?.proposal.id;
    if (!id) throw new Error('No proposal loaded');
    return id;
  }, []);

  const replaceItem = useCallback((item: ProposalItem, counts?: ProposalSummary['counts']) => {
    setDetail((current) =>
      current
        ? {
            ...current,
            proposal: counts ? { ...current.proposal, counts } : current.proposal,
            items: current.items.map((row) => (row.id === item.id ? item : row)),
          }
        : current,
    );
  }, []);

  const markPending = useCallback((ids: string[], on: boolean) => {
    setPendingItemIds((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const decide = useCallback(
    async (itemId: string, body: PatchProposalItemInput) => {
      const id = proposalId();
      const before = detailRef.current?.items.find((row) => row.id === itemId);
      if (before) replaceItem(optimistic(before, body));
      markPending([itemId], true);
      try {
        const result = await patchProposalItem(host, id, itemId, body);
        if (isMounted()) replaceItem(result.item, result.counts);
        return result;
      } catch (err) {
        if (isMounted() && before) replaceItem(before);
        throw err;
      } finally {
        if (isMounted()) markPending([itemId], false);
      }
    },
    [isMounted, markPending, proposalId, replaceItem],
  );

  const bulk = useCallback(
    async (itemIds: string[], decision: BulkDecision) => {
      const id = proposalId();
      markPending(itemIds, true);
      try {
        const result = await bulkDecideProposalItems(host, id, { itemIds, decision });
        // The server decides which rows it skipped; re-read rather than guess.
        await refresh();
        return result;
      } finally {
        if (isMounted()) markPending(itemIds, false);
      }
    },
    [isMounted, markPending, proposalId, refresh],
  );

  const setSummary = useCallback((proposal: ProposalSummary) => {
    setDetail((current) => (current ? { ...current, proposal } : current));
  }, []);

  const commit = useCallback(async () => {
    const result = await commitProposal(host, proposalId());
    if (isMounted()) setSummary(result.proposal);
    return result;
  }, [isMounted, proposalId, setSummary]);

  const discard = useCallback(async () => {
    const result = await discardProposal(host, proposalId());
    if (isMounted()) setSummary(result.proposal);
    return result;
  }, [isMounted, proposalId, setSummary]);

  const revert = useCallback(
    async (confirmPartial: boolean) => {
      const result = await revertProposal(host, proposalId(), { confirmPartial });
      if (isMounted()) setSummary(result.proposal);
      return result;
    },
    [isMounted, proposalId, setSummary],
  );

  const requestExtract = useCallback(
    async (body: RequestExtractionInput = {}) => {
      const current = sourceRef.current;
      const noteId = 'noteId' in current ? current.noteId : detailRef.current?.proposal.noteId;
      if (!noteId) throw new Error('This proposal has no note to extract from');
      const result = await requestExtraction(host, noteId, body);
      await refresh();
      return result;
    },
    [refresh],
  );

  return useMemo(
    () => ({
      detail,
      isLoading: enabled && detail === undefined && error === null,
      error,
      refresh,
      decide,
      bulk,
      commit,
      discard,
      revert,
      requestExtract,
      pendingItemIds,
    }),
    [bulk, commit, decide, detail, discard, enabled, error, pendingItemIds, refresh, requestExtract, revert],
  );
}
