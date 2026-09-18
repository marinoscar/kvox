import { useState, useCallback } from 'react';
import type { AllowedEmailEntry, AllowlistResponse } from '../types';
import type { AllowlistSortField } from '../services/api';
import {
  getAllowlist as fetchAllowlistApi,
  addToAllowlist as addToAllowlistApi,
  removeFromAllowlist as removeFromAllowlistApi,
  sendAllowlistReminder as sendAllowlistReminderApi,
} from '../services/api';
import { useIsMounted } from './useIsMounted';

/** The query `GET /api/allowlist` accepts. See `services/api.ts`. */
export interface AllowlistParams {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: 'all' | 'pending' | 'claimed';
  sortBy?: AllowlistSortField;
  sortOrder?: 'asc' | 'desc';
}

interface UseAllowlistResult {
  entries: AllowedEmailEntry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  isLoading: boolean;
  error: string | null;
  fetchAllowlist: (params?: AllowlistParams) => Promise<void>;
  addEmail: (email: string, notes?: string) => Promise<void>;
  removeEmail: (id: string) => Promise<void>;
  /**
   * `POST /api/allowlist/{id}/reminder` (issue #301), then patch the one row
   * this changed.
   *
   * ⚠ TWO DELIBERATE DIVERGENCES FROM `addEmail`/`removeEmail` ABOVE.
   *
   * 1. **It patches instead of re-fetching.** Both of those change WHICH rows
   *    exist, so only the server can say what page 1 now contains. A reminder
   *    changes two fields of a row already on screen and moves nothing — the
   *    endpoint hands back the updated entry for exactly this reason (a 200
   *    with a body, not a 204). Re-listing would also throw away an
   *    administrator's scroll position and any in-flight filter for a change
   *    they can already see.
   * 2. **It does not write `error`, it rethrows.** A failed add or remove has
   *    one meaning — the write did not happen — so one generic sentence serves.
   *    A failed reminder has three (already claimed, gone, everything else) and
   *    the wording for each is presentation, not data. `AllowlistTable` owns
   *    that copy; see `reminderErrorMessage` there.
   */
  sendReminder: (id: string) => Promise<void>;
}

export function useAllowlist(): UseAllowlistResult {
  const [entries, setEntries] = useState<AllowedEmailEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [totalPages, setTotalPages] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Every `setState` past an `await` is guarded: a request that settles after
  // the component is gone must not schedule an update on it. Only the state
  // write is skipped — what these functions return or throw is unchanged.
  const isMounted = useIsMounted();

  const fetchAllowlist = useCallback(
    async (params?: AllowlistParams) => {
      setIsLoading(true);
      setError(null);
      try {
        const response: AllowlistResponse = await fetchAllowlistApi(params);
        if (isMounted()) {
          setEntries(response.items);
          setTotal(response.total);
          setPage(response.page);
          setPageSize(response.pageSize);
          setTotalPages(response.totalPages);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to fetch allowlist';
        if (isMounted()) {
          setError(message);
          setEntries([]);
        }
      } finally {
        if (isMounted()) setIsLoading(false);
      }
    },
    [isMounted],
  );

  const addEmail = useCallback(
    async (email: string, notes?: string) => {
      setError(null);
      try {
        await addToAllowlistApi(email, notes);
        // Refresh the list
        await fetchAllowlist({ page, pageSize });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to add email';
        if (isMounted()) setError(message);
        throw err;
      }
    },
    [fetchAllowlist, page, pageSize, isMounted],
  );

  const removeEmail = useCallback(
    async (id: string) => {
      setError(null);
      try {
        await removeFromAllowlistApi(id);
        // Refresh the list
        await fetchAllowlist({ page, pageSize });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to remove email';
        if (isMounted()) setError(message);
        throw err;
      }
    },
    [fetchAllowlist, page, pageSize, isMounted],
  );

  const sendReminder = useCallback(
    async (id: string) => {
      const updated = await sendAllowlistReminderApi(id);
      // Identity-matched rather than positional: the list may have been
      // re-fetched underneath this request (a filter change, a poll), and
      // writing by index would then stamp the reminder onto a different
      // person's row. An id that is no longer on the page maps to no row and
      // the update is simply dropped, which is correct.
      if (isMounted()) {
        setEntries((previous) =>
          previous.map((entry) => (entry.id === updated.id ? updated : entry)),
        );
      }
    },
    [isMounted],
  );

  return {
    entries,
    total,
    page,
    pageSize,
    totalPages,
    isLoading,
    error,
    fetchAllowlist,
    addEmail,
    removeEmail,
    sendReminder,
  };
}
