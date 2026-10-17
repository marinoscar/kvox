/**
 * One graph import, read and reviewed (#387, epic #349; spec §18.3).
 *
 * An import is an ordinary `kind: import` proposal, so this is #367's
 * `useGraphProposal` for `{ proposalId }` — polling every 3 s while `kg.import`
 * is still checking the file — plus the import's own facts from
 * `proposal.stats` and the two attribute-offer actions. An offer decision
 * re-reads the proposal: accepting one rewrites rows' `props` server-side.
 */

import { useCallback, useEffect, useState } from 'react';

import { acceptAttributeOffer, importStatsOf, listProposals, rejectAttributeOffer } from '../clients/graph.js';
import type { AttributeOfferResult, GraphImportStats, ProposalStatus, ProposalSummary } from '../clients/graph.js';
import { useGraphProposal, type UseGraphProposalReturn } from './useGraphProposal.js';

import { useIsMounted, useKvoxHost } from '../../../core/headless/index.js';
/**
 * How often an import that is still extracting is re-read, in milliseconds.
 *
 * @stability experimental
 */
export const GRAPH_IMPORT_POLL_MS = 3_000;

/**
 * What {@link useGraphImport} returns: everything {@link UseGraphProposalReturn} does, plus the import's stats and offer decisions.
 *
 * @stability experimental
 */
export interface UseGraphImportReturn extends UseGraphProposalReturn {
  /** The import facts of the proposal; fields that have not been produced yet are absent. */
  stats: GraphImportStats;
  /** The offer with a decision in flight, if any. */
  busyOfferId: string | null;
  /** Adopts an unknown imported property as an attribute, optionally with a label, then re-reads the proposal. */
  acceptOffer: (offerId: string, label?: string) => Promise<AttributeOfferResult>;
  /** Turns down an unknown imported property, then re-reads the proposal. */
  rejectOffer: (offerId: string) => Promise<AttributeOfferResult>;
}

/**
 * Reads one import proposal, polls it while it extracts, and exposes the review mutations plus accept and reject of attribute offers.
 *
 * @stability experimental
 */
export function useGraphImport(proposalId: string, options: {
  /** Poll interval while the import is extracting, in milliseconds; defaults to {@link GRAPH_IMPORT_POLL_MS}. */
  pollMs?: number;
} = {}): UseGraphImportReturn {
  const host = useKvoxHost();
  const proposal = useGraphProposal({ proposalId }, { pollMs: options.pollMs ?? GRAPH_IMPORT_POLL_MS });
  const [busyOfferId, setBusyOfferId] = useState<string | null>(null);
  const isMounted = useIsMounted();
  const { refresh } = proposal;

  const decideOffer = useCallback(
    async (offerId: string, run: () => Promise<AttributeOfferResult>) => {
      setBusyOfferId(offerId);
      try {
        const result = await run();
        await refresh();
        return result;
      } finally {
        if (isMounted()) setBusyOfferId(null);
      }
    },
    [isMounted, refresh],
  );

  const acceptOffer = useCallback(
    (offerId: string, label?: string) => decideOffer(offerId, () => acceptAttributeOffer(host, proposalId, offerId, label)),
    [decideOffer, proposalId],
  );
  const rejectOffer = useCallback(
    (offerId: string) => decideOffer(offerId, () => rejectAttributeOffer(host, proposalId, offerId)),
    [decideOffer, proposalId],
  );

  return { ...proposal, stats: importStatsOf(proposal.detail?.proposal), busyOfferId, acceptOffer, rejectOffer };
}

/**
 * How many imports `/graph`'s "Imports" section lists.
 *
 * @stability experimental
 */
export const RECENT_IMPORTS_LIMIT = 5;

/** The statuses the "Imports" section shows — one listing each (the list route filters by one status). */
const RECENT_IMPORT_STATUSES: readonly ProposalStatus[] = ['extracting', 'draft', 'failed', 'committed'];

/**
 * The caller's last few imports, newest first, for `/graph`'s "Imports" section.
 * `GET /api/graph/proposals` filters by ONE status, so this asks once per
 * status and merges — four small reads rather than a new list route. Errors
 * leave the list empty: the section is a convenience, never a blocker.
 *
 * @stability experimental
 */
export function useRecentGraphImports(enabled: boolean): {
  /** The imports found, newest first. */
  imports: ProposalSummary[];
  /** The listings are loading. */
  isLoading: boolean;
} {
  const host = useKvoxHost();
  const [imports, setImports] = useState<ProposalSummary[]>([]);
  const [isLoading, setIsLoading] = useState(enabled);
  const isMounted = useIsMounted();

  useEffect(() => {
    if (!enabled) {
      setImports([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    Promise.all(
      RECENT_IMPORT_STATUSES.map((status) =>
        listProposals(host, { kind: 'import', status, limit: RECENT_IMPORTS_LIMIT }).then(
          (page) => (Array.isArray(page?.items) ? page.items : []),
          () => [] as ProposalSummary[],
        ),
      ),
    ).then((pages) => {
      if (!isMounted()) return;
      const seen = new Set<string>();
      const merged = pages
        .flat()
        .filter((p) => p?.kind === 'import' && !seen.has(p.id) && Boolean(seen.add(p.id)))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
        .slice(0, RECENT_IMPORTS_LIMIT);
      setImports(merged);
      setIsLoading(false);
    });
  }, [enabled, isMounted]);

  return { imports, isLoading };
}
