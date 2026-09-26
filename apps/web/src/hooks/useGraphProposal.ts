/**
 * One graph proposal, read and reviewed (#367, epic #346).
 *
 * `source` is either the note the sheet is mounted on (`GET
 * /api/graph/notes/:noteId/proposal`, which answers `null` when nothing was
 * ever extracted) or a proposal opened directly (#368's Home card).
 *
 * - `detail` is `undefined` until the first answer, `null` for "no proposal".
 * - While the proposal is `extracting`, it is re-read every 2 s through
 *   `useVisiblePolling` (paused in a hidden tab) and polling stops the moment
 *   it settles.
 * - `decide` is OPTIMISTIC: the row's checkbox moves at once and moves back if
 *   the PATCH is refused (the error is re-thrown for the sheet's snackbar).
 *   `pendingItemIds` names the rows with a write in flight.
 * - Every mutation resolves with the server's answer and rejects with its
 *   `ApiError`; the hook never swallows one.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ApiError } from '../services/api';
import {
  bulkDecideProposalItems,
  commitProposal,
  discardProposal,
  getNoteProposal,
  getProposal,
  patchProposalItem,
  requestExtraction,
  revertProposal,
} from '../services/graph';
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
} from '../services/graph';
import { useIsMounted } from './useIsMounted';
import { useVisiblePolling } from './useVisiblePolling';

export const PROPOSAL_POLL_MS = 2_000;

export type GraphProposalSource = { noteId: string } | { proposalId: string };

export interface UseGraphProposalReturn {
  detail: ProposalDetail | null | undefined;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  decide: (itemId: string, body: PatchProposalItemInput) => Promise<PatchProposalItemResult>;
  bulk: (itemIds: string[], decision: BulkDecision) => Promise<BulkDecideResult>;
  commit: () => Promise<{ proposal: ProposalSummary; result: CommitResult }>;
  discard: () => Promise<{ proposal: ProposalSummary }>;
  revert: (confirmPartial: boolean) => Promise<{ proposal: ProposalSummary; result: RevertResult }>;
  requestExtract: (body?: RequestExtractionInput) => Promise<RequestExtractionResult>;
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

export function useGraphProposal(
  source: GraphProposalSource,
  options: { enabled?: boolean } = {},
): UseGraphProposalReturn {
  const enabled = options.enabled ?? true;
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
        'noteId' in current ? await getNoteProposal(current.noteId) : await getProposal(current.proposalId);
      if (!isMounted() || sourceKey(sourceRef.current) !== sourceKey(current)) return;
      setDetail(next);
      setError(null);
    } catch (err) {
      if (!isMounted()) return;
      setError(err instanceof ApiError ? err.message : 'This proposal could not be loaded');
    }
  }, [isMounted]);

  useEffect(() => {
    setDetail(undefined);
    setError(null);
    setPendingItemIds(new Set());
    if (enabled) void refresh();
  }, [enabled, key, refresh]);

  const extracting = detail?.proposal.status === 'extracting';
  useVisiblePolling(() => void refresh(), enabled && extracting ? PROPOSAL_POLL_MS : 0);

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
        const result = await patchProposalItem(id, itemId, body);
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
        const result = await bulkDecideProposalItems(id, { itemIds, decision });
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
    const result = await commitProposal(proposalId());
    if (isMounted()) setSummary(result.proposal);
    return result;
  }, [isMounted, proposalId, setSummary]);

  const discard = useCallback(async () => {
    const result = await discardProposal(proposalId());
    if (isMounted()) setSummary(result.proposal);
    return result;
  }, [isMounted, proposalId, setSummary]);

  const revert = useCallback(
    async (confirmPartial: boolean) => {
      const result = await revertProposal(proposalId(), { confirmPartial });
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
      const result = await requestExtraction(noteId, body);
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
