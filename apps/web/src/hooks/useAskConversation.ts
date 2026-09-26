/**
 * `useAskConversation` — one saved conversation, its messages, and the live
 * turn (#380; reused unchanged by the entity panel, #381).
 *
 * `send(content, model?)` posts the question (#378's 202 carries BOTH new
 * rows), appends them at once — the user sees their question and a "Thinking…"
 * bubble before the job has even been claimed — and the running assistant
 * message is then attached to {@link useAskStream}. When the stream settles
 * the message is updated in place from the frame and the conversation is
 * re-read quietly, so tokens, `finishReason` and the row's own steps replace
 * the stream's view without a loading flash.
 *
 * Errors are STRINGS the caller renders (the `useNotes` contract), except
 * `send`, which REJECTS with the `ApiError` so the composer can keep its text
 * and show the 409's own copy (`askConflictReason`).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getAskConversation, isAskNotFound, postAskMessage } from '../services/ask';
import type { AskConversationDetail, AskMessage, PostAskMessageResponse } from '../services/ask';
import { ApiError } from '../services/api';
import { isAbortError, useAbortControllers } from './graphHookUtils';
import { isRunningAssistantMessage, useAskStream } from './useAskStream';
import type { AskStreamState } from './useAskStream';
import { useIsMounted } from './useIsMounted';

export const ASK_CONVERSATION_LOAD_ERROR = 'Could not load this conversation';

export interface UseAskConversationOptions {
  /**
   * Rows already known — the page that just created the conversation and
   * posted its first question hands them over, so the new page renders them
   * immediately instead of waiting for its first `GET`.
   */
  seed?: AskConversationDetail | null;
  /** A turn finished (answered or failed). The list refreshes on this. */
  onTurnSettled?: (conversationId: string) => void;
}

export interface UseAskConversationResult {
  conversation: AskConversationDetail | null;
  isLoading: boolean;
  /** A load failure's copy; `null` when fine or when {@link notFound}. */
  error: string | null;
  /** The conversation does not exist, or is not the caller's (one 404). */
  notFound: boolean;
  isLoadingEarlier: boolean;
  /** The running assistant turn's live state (idle when none). */
  stream: AskStreamState;
  /** Whether a turn is pending or streaming right now. */
  running: boolean;
  refresh: () => Promise<void>;
  loadEarlier: () => Promise<void>;
  /** Rejects with the `ApiError` (409s included) — see the header. */
  send: (content: string, model?: string) => Promise<PostAskMessageResponse>;
}

/**
 * Combine a fresh page of the conversation with what is already held.
 *
 * A re-read returns the newest 100 messages; anything OLDER that "Load
 * earlier" fetched is kept in front of them rather than thrown away.
 */
export function mergeConversation(
  held: AskConversationDetail | null,
  fresh: AskConversationDetail,
): AskConversationDetail {
  if (!held || held.id !== fresh.id || fresh.messages.length === 0) return fresh;
  // A turn this client already saw settle (its stream said `done`/`error`)
  // never goes back to running because a read raced the row's own update —
  // that would re-attach the stream to a finished answer.
  const heldById = new Map(held.messages.map((m) => [m.id, m]));
  const settled = (m: AskMessage) => m.status === 'complete' || m.status === 'failed';
  const messages = fresh.messages.map((m) => {
    const known = heldById.get(m.id);
    return known && settled(known) && !settled(m) ? known : m;
  });
  const freshIds = new Set(messages.map((m) => m.id));
  const firstFresh = messages[0];
  const olderHeld = held.messages.filter((m) => !freshIds.has(m.id) && m.createdAt < firstFresh.createdAt);
  if (olderHeld.length === 0) return { ...fresh, messages };
  return { ...fresh, messages: [...olderHeld, ...messages], hasEarlier: held.hasEarlier };
}

function withMessage(
  detail: AskConversationDetail | null,
  id: string,
  patch: Partial<AskMessage>,
): AskConversationDetail | null {
  if (!detail) return detail;
  return { ...detail, messages: detail.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)) };
}

export function useAskConversation(
  conversationId: string | null | undefined,
  options: UseAskConversationOptions = {},
): UseAskConversationResult {
  const id = conversationId ?? null;
  const seed = options.seed && options.seed.id === id ? options.seed : null;

  const [conversation, setConversation] = useState<AskConversationDetail | null>(seed);
  const [isLoading, setIsLoading] = useState(Boolean(id) && !seed);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [isLoadingEarlier, setIsLoadingEarlier] = useState(false);
  const [reconnectKey, setReconnectKey] = useState(0);

  const isMounted = useIsMounted();
  const nextController = useAbortControllers();
  const onTurnSettledRef = useRef(options.onTurnSettled);
  onTurnSettledRef.current = options.onTurnSettled;
  const seedRef = useRef(seed);
  seedRef.current = seed;

  const load = useCallback(
    async (quiet: boolean) => {
      if (!id) return;
      const controller = nextController();
      if (!quiet) {
        setIsLoading(true);
        setError(null);
        setNotFound(false);
      }
      try {
        const fresh = await getAskConversation(id, {}, controller.signal);
        if (!isMounted() || controller.signal.aborted) return;
        setConversation((held) => mergeConversation(held, fresh));
        setError(null);
        setNotFound(false);
      } catch (err) {
        if (isAbortError(err) || !isMounted() || controller.signal.aborted) return;
        if (isAskNotFound(err)) {
          setNotFound(true);
          setConversation(null);
        } else if (!quiet) {
          setError(err instanceof ApiError && err.message ? err.message : ASK_CONVERSATION_LOAD_ERROR);
        }
      } finally {
        if (isMounted() && !controller.signal.aborted) setIsLoading(false);
      }
    },
    [id, isMounted, nextController],
  );

  // A new conversation id is a new question: reset, then read it (quietly
  // when a seed already put its rows on screen).
  useEffect(() => {
    setNotFound(false);
    setError(null);
    if (!id) {
      setConversation(null);
      setIsLoading(false);
      return;
    }
    const known = seedRef.current;
    setConversation(known);
    setIsLoading(!known);
    void load(Boolean(known));
  }, [id, load]);

  const refresh = useCallback(() => load(true), [load]);

  const activeMessage = useMemo(() => {
    const messages = conversation?.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (isRunningAssistantMessage(messages[i])) return messages[i];
    }
    return null;
  }, [conversation]);

  const stream = useAskStream(activeMessage, {
    reconnectKey,
    onDone: (messageId, done) => {
      setConversation((held) =>
        withMessage(held, messageId, {
          status: 'complete',
          content: done.content,
          citations: done.citations,
          finishReason: done.finishReason,
        }),
      );
      void load(true);
      if (id) onTurnSettledRef.current?.(id);
    },
    onError: (messageId, failure) => {
      if (failure.errorClass === 'timeout' && failure.reason === 'stream_duration_cap') {
        // The READER gave up; the job may still be running. Re-read the row
        // and, if it is still going, attach again.
        void load(true).then(() => {
          if (isMounted()) setReconnectKey((key) => key + 1);
        });
        return;
      }
      if (failure.errorClass === 'gone') {
        // The conversation was deleted (elsewhere). The re-read 404s.
        void load(true);
        return;
      }
      setConversation((held) =>
        withMessage(held, messageId, {
          status: 'failed',
          content: failure.content,
          errorClass: failure.errorClass === 'gone' ? 'other' : failure.errorClass,
        }),
      );
      void load(true);
      if (id) onTurnSettledRef.current?.(id);
    },
  });

  const loadEarlier = useCallback(async () => {
    const held = conversation;
    if (!id || !held || !held.hasEarlier || held.messages.length === 0) return;
    setIsLoadingEarlier(true);
    try {
      const page = await getAskConversation(id, { before: held.messages[0].id });
      if (!isMounted()) return;
      setConversation((current) => {
        if (!current || current.id !== id) return current;
        const known = new Set(current.messages.map((m) => m.id));
        const older = page.messages.filter((m) => !known.has(m.id));
        return { ...current, messages: [...older, ...current.messages], hasEarlier: page.hasEarlier };
      });
    } catch {
      // "Load earlier" stays on screen; pressing it again is the retry.
    } finally {
      if (isMounted()) setIsLoadingEarlier(false);
    }
  }, [conversation, id, isMounted]);

  const send = useCallback(
    async (content: string, model?: string) => {
      if (!id) throw new Error('No conversation to send to');
      const result = await postAskMessage(id, { content, model });
      if (isMounted()) {
        setConversation((held) => {
          if (!held || held.id !== id) return held;
          const known = new Set(held.messages.map((m) => m.id));
          const added = [result.userMessage, result.assistantMessage].filter((m) => !known.has(m.id));
          return {
            ...held,
            title: held.title ?? content.slice(0, 80),
            running: true,
            messages: [...held.messages, ...added],
          };
        });
      }
      return result;
    },
    [id, isMounted],
  );

  return {
    conversation,
    isLoading,
    error,
    notFound,
    isLoadingEarlier,
    stream,
    running: activeMessage !== null,
    refresh,
    loadEarlier,
    send,
  };
}

export default useAskConversation;
