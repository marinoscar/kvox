/**
 * `useGraphReviewQueue` — the proposals waiting for review
 * (`GET /api/graph/proposals?status=draft`), newest first, a page at a time:
 * what the Review page lists.
 *
 * Note extractions and imports only: a `resolution` proposal (merge
 * suggestions) has no page of its own to review it on, so it is left out.
 * Like every graph hook it resolves rather than throws: a failure is `error`.
 */

import { useCallback, useEffect, useState } from 'react';

import { listProposals } from '../clients/graph.js';
import type { ProposalSummary } from '../clients/graph.js';
import { graphErrorMessage } from './graphHookUtils.js';

import { useIsMounted, useKvoxHost } from '../../../core/headless/index.js';

/**
 * Proposals per page of {@link useGraphReviewQueue}.
 *
 * @stability experimental
 */
export const REVIEW_QUEUE_PAGE_SIZE = 20;

/**
 * What {@link useGraphReviewQueue} returns.
 *
 * @stability experimental
 */
export interface UseGraphReviewQueueResult {
  /** The draft proposals loaded so far (extractions and imports). */
  items: ProposalSummary[];
  /** The first page is loading. */
  isLoading: boolean;
  /** A further page is loading. */
  isLoadingMore: boolean;
  /** The last failure's message, or `null`. */
  error: string | null;
  /** More proposals exist past the loaded ones. */
  hasMore: boolean;
  /** Loads the next page. */
  loadMore: () => Promise<void>;
  /** Reloads from the first page. */
  refresh: () => Promise<void>;
}

/**
 * The review queue.
 *
 * @stability experimental
 */
export function useGraphReviewQueue(): UseGraphReviewQueueResult {
  const host = useKvoxHost();
  const isMounted = useIsMounted();
  const [items, setItems] = useState<ProposalSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const page = useCallback(
    async (after: string | null) => {
      const result = await listProposals(host, {
        status: 'draft',
        limit: REVIEW_QUEUE_PAGE_SIZE,
        ...(after ? { cursor: after } : {}),
      });
      const rows = (Array.isArray(result?.items) ? result.items : []).filter((p) => p.kind !== 'resolution');
      return { rows, next: result?.nextCursor ?? null };
    },
    [host],
  );

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const { rows, next } = await page(null);
      if (!isMounted()) return;
      setItems(rows);
      setCursor(next);
    } catch (err) {
      if (isMounted()) setError(graphErrorMessage(err, 'Failed to load what is waiting for review'));
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted, page]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    setIsLoadingMore(true);
    setError(null);
    try {
      const { rows, next } = await page(cursor);
      if (!isMounted()) return;
      setItems((current) => {
        const seen = new Set(current.map((p) => p.id));
        return [...current, ...rows.filter((p) => !seen.has(p.id))];
      });
      setCursor(next);
    } catch (err) {
      if (isMounted()) setError(graphErrorMessage(err, 'Failed to load more'));
    } finally {
      if (isMounted()) setIsLoadingMore(false);
    }
  }, [cursor, isMounted, page]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { items, isLoading, isLoadingMore, error, hasMore: cursor !== null, loadMore, refresh };
}
