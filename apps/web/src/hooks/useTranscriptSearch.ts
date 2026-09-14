/**
 * Find, as the panel needs it — issue #31, epic #19.
 *
 * A thin hook over `GET /:id/search`, debounced, with the two properties that
 * make a find box usable rather than merely functional:
 *
 *   • **A stale answer never wins.** Typing "budget" issues a request per
 *     keystroke-burst, and a slow `bud` settling after a fast `budget` would
 *     leave the match count describing a search the user has moved past. Every
 *     request carries a token and a settled response whose token is stale drops
 *     itself — the same guard `useTranscripts` uses on the library's filter,
 *     for the same reason.
 *
 *   • **Matching is the SERVER's, not a second implementation here.** The whole
 *     point of `GET /:id/search` is that the preview and the replacement agree:
 *     whole-word boundaries are Unicode-aware server-side (so `os` does not
 *     match inside `José`), and a client-side `indexOf` preview would quietly
 *     disagree with the `transcript.find_replace` that follows it — showing a
 *     count of 7 and then rewriting 5.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '../services/api';
import { searchTranscript } from '../services/transcriptEditing';
import type { TranscriptSearchResult } from '../services/transcriptEditing';
import { useIsMounted } from './useIsMounted';

/** Idle time before a keystroke becomes a request. */
export const SEARCH_DEBOUNCE_MS = 250;

export interface FindQuery {
  find: string;
  replace: string;
  matchCase: boolean;
  wholeWord: boolean;
  /** Restrict matching to one speaker's lines. Empty means every speaker. */
  speakerId: string;
}

export const EMPTY_FIND_QUERY: FindQuery = {
  find: '',
  replace: '',
  matchCase: false,
  wholeWord: false,
  speakerId: '',
};

export interface UseTranscriptSearchResult {
  result: TranscriptSearchResult | null;
  isSearching: boolean;
  error: string | null;
  /** Re-run the current query — what a save calls, since matches move. */
  refresh: () => void;
}

export function useTranscriptSearch(
  transcriptId: string | undefined,
  query: FindQuery,
  enabled: boolean,
  debounceMs = SEARCH_DEBOUNCE_MS,
): UseTranscriptSearchResult {
  const [result, setResult] = useState<TranscriptSearchResult | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isMounted = useIsMounted();
  const token = useRef(0);
  const [nonce, setNonce] = useState(0);

  const { find, matchCase, wholeWord, speakerId } = query;

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    if (!transcriptId || !enabled || !find) {
      // An empty box is not a search with no results — it is no search, and
      // "0 matches" over an empty field reads as a failure.
      setResult(null);
      setIsSearching(false);
      setError(null);
      return;
    }

    const mine = (token.current += 1);
    setIsSearching(true);

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await searchTranscript(transcriptId, {
            q: find,
            matchCase,
            wholeWord,
            speakerId: speakerId || null,
          });
          if (!isMounted() || mine !== token.current) return;
          setResult(response);
          setError(null);
        } catch (err) {
          if (!isMounted() || mine !== token.current) return;
          setResult(null);
          setError(err instanceof ApiError ? err.message : 'The search failed.');
        } finally {
          if (isMounted() && mine === token.current) setIsSearching(false);
        }
      })();
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [debounceMs, enabled, find, isMounted, matchCase, nonce, speakerId, transcriptId, wholeWord]);

  return { result, isSearching, error, refresh };
}

export default useTranscriptSearch;
