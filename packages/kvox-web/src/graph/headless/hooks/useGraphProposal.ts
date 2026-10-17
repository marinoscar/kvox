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
 * The PROPOSAL POLL MS.
 *
 * @stability experimental
 */
export const PROPOSAL_POLL_MS = 2_000;

/**
 * The graph proposal source.
 *
 * @stability experimental
 */
export type GraphProposalSource = {
  /** The id of the note. */
  noteId: string;
} | {
  /** The id of the proposal. */
  proposalId: string;
};

/**
 * What use graph proposal returns.
 *
 * @stability experimental
 */
export interface UseGraphProposalReturn {
  /** The detail. */
  detail: ProposalDetail | null | undefined;
  /** Whether it is loading. */
  isLoading: boolean;
  /** The error. */
  error: string | null;
  /** The refresh. */
  refresh: () => Promise<void>;
  /** The decide. */
  decide: (itemId: string, body: PatchProposalItemInput) => Promise<PatchProposalItemResult>;
  /** The bulk. */
  bulk: (itemIds: string[], decision: BulkDecision) => Promise<BulkDecideResult>;
  /** The commit. */
  commit: () => Promise<{
    /** The proposal. */
    proposal: ProposalSummary;
    /** The result. */
    result: CommitResult;
  }>;
  /** The discard. */
  discard: () => Promise<{
    /** The proposal. */
    proposal: ProposalSummary;
  }>;
  /** The revert. */
  revert: (confirmPartial: boolean) => Promise<{
    /** The proposal. */
    proposal: ProposalSummary;
    /** The result. */
    result: RevertResult;
  }>;
  /** The request extract. */
  requestExtract: (body?: RequestExtractionInput) => Promise<RequestExtractionResult>;
  /** The pending item ids. */
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
 * Hook: reads graph proposal.
 *
 * @stability experimental
 */
export function useGraphProposal(
  source: GraphProposalSource,
  options: {
    /** Whether enabled applies. */
    enabled?: boolean;
    /** The poll ms. */
    pollMs?: number;
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

  const extracting = detail?.proposal.status === 'extracting';
  useVisiblePolling(() => void refresh(), enabled && extracting ? pollMs : 0);

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
