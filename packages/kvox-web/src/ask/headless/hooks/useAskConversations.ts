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

import { KvoxApiError, useIsMounted, useKvoxHost } from '../../../core/headless/index.js';
import { isAbortError, useAbortControllers } from '../../../graph/headless/index.js';
import {
  createAskConversation,
  deleteAskConversation,
  listAskConversations,
  renameAskConversation,
} from '../clients/ask.js';
import type { AskConversationSummary, CreateAskConversationInput } from '../clients/ask.js';

/**
 * The copy of a conversation list that could not be read.
 *
 * @stability experimental
 */
export const ASK_CONVERSATIONS_LOAD_ERROR = 'Could not load your conversations';
/**
 * How many conversations one page of the list holds.
 *
 * @stability experimental
 */
export const ASK_CONVERSATIONS_PAGE_SIZE = 20;

/**
 * Options of {@link useAskConversations}.
 *
 * @stability experimental
 */
export interface UseAskConversationsOptions {
  /** Lists only the conversations scoped to this entity (the entity panel). */
  scopeEntityId?: string;
  /** Page size; default {@link ASK_CONVERSATIONS_PAGE_SIZE}. */
  limit?: number;
  /** `false` issues no request (Ask turned off, or no permission). */
  enabled?: boolean;
}

/**
 * What {@link useAskConversations} returns.
 *
 * @stability experimental
 */
export interface UseAskConversationsResult {
  /** The conversations loaded so far, newest first. */
  items: AskConversationSummary[];
  /** The cursor of the next page, or `null` on the last one. */
  nextCursor: string | null;
  /** The first page is loading. */
  isLoading: boolean;
  /** A later page is loading. */
  isLoadingMore: boolean;
  /** A load failure's copy, or `null`. */
  error: string | null;
  /** Appends the next page. */
  loadMore: () => Promise<void>;
  /** Re-reads the first page without a loading flash. */
  refresh: () => Promise<void>;
  /** Creates a conversation; rejects with the `KvoxApiError`. */
  create: (body?: CreateAskConversationInput) => Promise<AskConversationSummary>;
  /** Renames a conversation; rejects with the `KvoxApiError`. */
  rename: (id: string, title: string) => Promise<AskConversationSummary>;
  /** Deletes a conversation; rejects with the `KvoxApiError`. */
  remove: (id: string) => Promise<void>;
  /** Replace one row with a fresher summary (or insert it at the top). */
  upsert: (summary: AskConversationSummary) => void;
}

function loadMessage(err: unknown): string {
  return err instanceof KvoxApiError && err.message ? err.message : ASK_CONVERSATIONS_LOAD_ERROR;
}

/**
 * The caller's saved Ask conversations, newest first.
 *
 * @param options - Scope, page size and the enabled switch.
 * @returns The list and its actions.
 *
 * @stability experimental
 */
export function useAskConversations(options: UseAskConversationsOptions = {}): UseAskConversationsResult {
  const { scopeEntityId, limit = ASK_CONVERSATIONS_PAGE_SIZE, enabled = true } = options;
  const host = useKvoxHost();

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
        const page = await listAskConversations(host, { scopeEntityId, limit }, controller.signal);
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
    [enabled, host, isMounted, limit, nextController, scopeEntityId],
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
      const page = await listAskConversations(host, { scopeEntityId, limit, cursor: nextCursor });
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
  }, [host, isLoadingMore, isMounted, limit, nextCursor, scopeEntityId]);

  const upsert = useCallback((summary: AskConversationSummary) => {
    setItems((current) => {
      const rest = current.filter((row) => row.id !== summary.id);
      const existing = current.find((row) => row.id === summary.id);
      return existing ? current.map((row) => (row.id === summary.id ? { ...row, ...summary } : row)) : [summary, ...rest];
    });
  }, []);

  const create = useCallback(
    async (body: CreateAskConversationInput = {}) => {
      const created = await createAskConversation(host, scopeEntityId ? { scopeEntityId, ...body } : body);
      if (isMounted()) upsert(created);
      return created;
    },
    [host, isMounted, scopeEntityId, upsert],
  );

  const rename = useCallback(
    async (id: string, title: string) => {
      const renamed = await renameAskConversation(host, id, title);
      if (isMounted()) {
        setItems((current) => current.map((row) => (row.id === id ? { ...row, ...renamed } : row)));
      }
      return renamed;
    },
    [host, isMounted],
  );

  const remove = useCallback(
    async (id: string) => {
      await deleteAskConversation(host, id);
      if (isMounted()) setItems((current) => current.filter((row) => row.id !== id));
    },
    [host, isMounted],
  );

  return { items, nextCursor, isLoading, isLoadingMore, error, loadMore, refresh, create, rename, remove, upsert };
}
