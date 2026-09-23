import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '../services/api';
import { getNoteGenerationContext, isNoGenerationError } from '../services/notes';
import type { NoteGenerationContext } from '../services/notes';
import { useIsMounted } from './useIsMounted';

/**
 * The exact prompt a note's generation sent — issue #308.
 *
 * ⚠ FETCHES ONLY WHEN `enabled`. The prompt can be megabytes (a long
 * transcript is in it), so merely READING a note must never download it; the
 * dialog that shows it passes `enabled: open`.
 *
 * A 404 with `details.reason: 'no_generation'` is not an error: it is the
 * ordinary answer for a note that has not been generated yet, and resolves to
 * `context: null`.
 */
export interface UseNoteGenerationContextOptions {
  enabled: boolean;
  generationId?: string;
}

export interface UseNoteGenerationContextResult {
  context: NoteGenerationContext | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useNoteGenerationContext(
  noteId: string,
  { enabled, generationId }: UseNoteGenerationContextOptions,
): UseNoteGenerationContextResult {
  const [context, setContext] = useState<NoteGenerationContext | null>(null);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const isMounted = useIsMounted();

  useEffect(() => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }

    // `cancelled` as well as `isMounted()`: the generation id can change while
    // a request is in flight, and the older answer must not win the race.
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    void (async () => {
      try {
        const result = await getNoteGenerationContext(noteId, generationId);
        if (cancelled || !isMounted()) return;
        setContext(result);
      } catch (err) {
        if (cancelled || !isMounted()) return;
        if (isNoGenerationError(err)) {
          setContext(null);
          return;
        }
        setContext(null);
        setError(
          err instanceof ApiError && err.message
            ? err.message
            : 'The context could not be loaded',
        );
      } finally {
        if (!cancelled && isMounted()) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, generationId, isMounted, noteId, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return { context, isLoading, error, refresh };
}

export default useNoteGenerationContext;
