/**
 * `useSpeakerSuggestions` — the pending voice-based name suggestions of one
 * transcript (#827, epic #820), with accept and dismiss.
 *
 * SILENT ON A FAILED READ: an empty list, never an error. A transcript page
 * must not show a graph error because an optional enhancement could not load
 * (the `useGraphTranscriptPeople` rule). A failed ACTION is different: the user
 * pressed a button, so its failure is surfaced as `error`.
 *
 * Accept and dismiss remove the suggestion at once (optimistic). A failure puts
 * it back, except a 409 `SPEAKER_ALREADY_NAMED` on accept: the speaker has been
 * named since, so the suggestion is gone for good either way.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  acceptSpeakerSuggestion,
  dismissSpeakerSuggestion,
  isSpeakerAlreadyNamed,
  listSpeakerSuggestions,
} from '../clients/voiceprints.js';
import type { SpeakerSuggestion } from '../clients/voiceprints.js';
import { isAbortError } from './graphHookUtils.js';

import { KvoxApiError, useIsMounted, useKvoxHost } from '../../../core/headless/index.js';

/**
 * What {@link useSpeakerSuggestions} returns.
 *
 * @stability experimental
 */
export interface UseSpeakerSuggestionsResult {
  /** The pending suggestions, best first; empty while disabled, loading or after a failed read. */
  suggestions: readonly SpeakerSuggestion[];
  /** The first read has not settled yet. */
  isLoading: boolean;
  /** The id of the suggestion an accept or dismiss is in flight for, else `null`. */
  busyId: string | null;
  /** Why the last accept or dismiss failed, else `null`. */
  error: string | null;
  /** Clears {@link UseSpeakerSuggestionsResult.error}. */
  clearError: () => void;
  /** Names the speaker with the suggested Person's name. Resolves `true` when it landed. */
  accept: (id: string) => Promise<boolean>;
  /** Dismisses the suggestion; the pair is never suggested again. Resolves `true` when it landed. */
  dismiss: (id: string) => Promise<boolean>;
  /** Reads the suggestions again. */
  refresh: () => Promise<void>;
}

/** Shown when an accept lost the race to a rename. */
export const SPEAKER_ALREADY_NAMED_MESSAGE = 'This speaker was named in the meantime.';

function actionMessage(err: unknown, fallback: string): string {
  if (isSpeakerAlreadyNamed(err)) return SPEAKER_ALREADY_NAMED_MESSAGE;
  if (err instanceof KvoxApiError) {
    if (err.status === 403) return 'You do not have permission to name speakers.';
    if (err.status === 404) return 'This suggestion is no longer available.';
    return err.message || fallback;
  }
  return fallback;
}

/**
 * Loads the pending speaker-name suggestions of one transcript. Does nothing
 * while `transcriptId` is undefined or `enabled` is `false`.
 *
 * @param transcriptId - The transcript, or `undefined`.
 * @param enabled - `false` to skip the read (for example while the transcript has no placeholder speaker).
 * @returns The suggestions, the action state and `accept` / `dismiss`.
 *
 * @stability experimental
 */
export function useSpeakerSuggestions(
  transcriptId: string | undefined,
  enabled = true,
): UseSpeakerSuggestionsResult {
  const host = useKvoxHost();
  const isMounted = useIsMounted();
  const [suggestions, setSuggestions] = useState<readonly SpeakerSuggestion[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    controllerRef.current?.abort();
    if (!enabled || !transcriptId) {
      setSuggestions([]);
      setIsLoading(false);
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    setIsLoading(true);
    try {
      const next = await listSpeakerSuggestions(host, transcriptId, controller.signal);
      if (!isMounted() || controller.signal.aborted) return;
      setSuggestions(next);
    } catch (err) {
      if (!isMounted() || controller.signal.aborted || isAbortError(err)) return;
      setSuggestions([]);
    } finally {
      if (isMounted() && !controller.signal.aborted) setIsLoading(false);
    }
  }, [enabled, host, isMounted, transcriptId]);

  useEffect(() => {
    void load();
    return () => controllerRef.current?.abort();
  }, [load]);

  const decide = useCallback(
    async (id: string, kind: 'accept' | 'dismiss'): Promise<boolean> => {
      const removed = suggestions.find((row) => row.id === id);
      if (!removed) return false;
      setBusyId(id);
      setError(null);
      setSuggestions((current) => current.filter((row) => row.id !== id));
      try {
        if (kind === 'accept') await acceptSpeakerSuggestion(host, id);
        else await dismissSpeakerSuggestion(host, id);
        return true;
      } catch (err) {
        if (!isMounted()) return false;
        setError(
          actionMessage(err, kind === 'accept' ? 'Could not name this speaker.' : 'Could not dismiss this suggestion.'),
        );
        const gone = isSpeakerAlreadyNamed(err) || (err instanceof KvoxApiError && err.status === 404);
        if (!gone) {
          setSuggestions((current) =>
            current.some((row) => row.id === id)
              ? current
              : [...current, removed].sort((a, b) => b.score - a.score),
          );
        }
        return false;
      } finally {
        if (isMounted()) setBusyId(null);
      }
    },
    [host, isMounted, suggestions],
  );

  const accept = useCallback((id: string) => decide(id, 'accept'), [decide]);
  const dismiss = useCallback((id: string) => decide(id, 'dismiss'), [decide]);
  const clearError = useCallback(() => setError(null), []);

  return { suggestions, isLoading, busyId, error, clearError, accept, dismiss, refresh: load };
}
