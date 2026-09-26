/**
 * `useAskConversations` — the caller's saved Ask conversations, newest first
 * (#380; the entity panel, #381, passes `scopeEntityId`).
 *
 * Keyset-paginated (`nextCursor`), so `loadMore` appends and a new question
 * (a different scope) resets. `create`/`rename`/`remove` call the API and
 * update the list in place; each REJECTS with the `ApiError` so a dialog can
 * show it, while a failed load is a string the page renders.
 */

import { useCallback, useEffect, useState } from 'react';

import {
  createAskConversation,
  deleteAskConversation,
  listAskConversations,
  renameAskConversation,
} from '../services/ask';
import type { AskConversationSummary, CreateAskConversationInput } from '../services/ask';
import { ApiError } from '../services/api';
import { isAbortError, useAbortControllers } from './graphHookUtils';
import { useIsMounted } from './useIsMounted';

export const ASK_CONVERSATIONS_LOAD_ERROR = 'Could not load your conversations';
export const ASK_CONVERSATIONS_PAGE_SIZE = 20;

export interface UseAskConversationsOptions {
  scopeEntityId?: string;
  limit?: number;
  /** `false` issues no request (Ask turned off, or no permission). */
  enabled?: boolean;
}

export interface UseAskConversationsResult {
  items: AskConversationSummary[];
  nextCursor: string | null;
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
  create: (body?: CreateAskConversationInput) => Promise<AskConversationSummary>;
  rename: (id: string, title: string) => Promise<AskConversationSummary>;
  remove: (id: string) => Promise<void>;
  /** Replace one row with a fresher summary (or insert it at the top). */
  upsert: (summary: AskConversationSummary) => void;
}

function loadMessage(err: unknown): string {
  return err instanceof ApiError && err.message ? err.message : ASK_CONVERSATIONS_LOAD_ERROR;
}

export function useAskConversations(options: UseAskConversationsOptions = {}): UseAskConversationsResult {
  const { scopeEntityId, limit = ASK_CONVERSATIONS_PAGE_SIZE, enabled = true } = options;

  const [items, setItems] = useState<AskConversationSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(enabled);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isMounted = useIsMounted();
  const nextController = useAbortControllers();

  const load = useCallback(
    async (quiet: boolean) => {
      if (!enabled) {
        setIsLoading(false);
        return;
      }
      const controller = nextController();
      if (!quiet) {
        setIsLoading(true);
        setError(null);
      }
      try {
        const page = await listAskConversations({ scopeEntityId, limit }, controller.signal);
        if (!isMounted() || controller.signal.aborted) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
        setError(null);
      } catch (err) {
        if (isAbortError(err) || !isMounted() || controller.signal.aborted) return;
        if (!quiet) setError(loadMessage(err));
      } finally {
        if (isMounted() && !controller.signal.aborted) setIsLoading(false);
      }
    },
    [enabled, isMounted, limit, nextController, scopeEntityId],
  );

  useEffect(() => {
    setItems([]);
    setNextCursor(null);
    void load(false);
  }, [load]);

  const refresh = useCallback(() => load(true), [load]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const page = await listAskConversations({ scopeEntityId, limit, cursor: nextCursor });
      if (!isMounted()) return;
      setItems((current) => {
        const known = new Set(current.map((row) => row.id));
        return [...current, ...page.items.filter((row) => !known.has(row.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (isMounted()) setError(loadMessage(err));
    } finally {
      if (isMounted()) setIsLoadingMore(false);
    }
  }, [isLoadingMore, isMounted, limit, nextCursor, scopeEntityId]);

  const upsert = useCallback((summary: AskConversationSummary) => {
    setItems((current) => {
      const rest = current.filter((row) => row.id !== summary.id);
      const existing = current.find((row) => row.id === summary.id);
      return existing ? current.map((row) => (row.id === summary.id ? { ...row, ...summary } : row)) : [summary, ...rest];
    });
  }, []);

  const create = useCallback(
    async (body: CreateAskConversationInput = {}) => {
      const created = await createAskConversation(scopeEntityId ? { scopeEntityId, ...body } : body);
      if (isMounted()) upsert(created);
      return created;
    },
    [isMounted, scopeEntityId, upsert],
  );

  const rename = useCallback(
    async (id: string, title: string) => {
      const renamed = await renameAskConversation(id, title);
      if (isMounted()) {
        setItems((current) => current.map((row) => (row.id === id ? { ...row, ...renamed } : row)));
      }
      return renamed;
    },
    [isMounted],
  );

  const remove = useCallback(
    async (id: string) => {
      await deleteAskConversation(id);
      if (isMounted()) setItems((current) => current.filter((row) => row.id !== id));
    },
    [isMounted],
  );

  return { items, nextCursor, isLoading, isLoadingMore, error, loadMore, refresh, create, rename, remove, upsert };
}

export default useAskConversations;
