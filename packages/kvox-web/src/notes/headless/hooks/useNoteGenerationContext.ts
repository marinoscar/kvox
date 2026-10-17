import { useCallback, useEffect, useState } from 'react';

import { KvoxApiError, useIsMounted, useKvoxHost } from '../../../core/headless/index.js';
import { getNoteGenerationContext, isNoGenerationError } from '../clients/notes.js';
import type { NoteGenerationContext } from '../clients/notes.js';

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
  *
  * @stability experimental
 */
export interface UseNoteGenerationContextOptions {
  /** Read only when `true`: the prompt can be megabytes. */
  enabled: boolean;
  /** A specific generation; omit it for the current one. */
  generationId?: string;
}

/**
 * What {@link useNoteGenerationContext} returns.
 *
 * @stability experimental
 */
export interface UseNoteGenerationContextResult {
  /** The context, or `null` before it arrives or when there is no generation. */
  context: NoteGenerationContext | null;
  /** Whether the read is in flight. */
  isLoading: boolean;
  /** A message when the read failed, else `null`. */
  error: string | null;
  /** Reads the context again. */
  refresh: () => void;
}

/**
 * The exact prompt a note's generation sent, read only while `enabled`.
 *
 * @param noteId - The note.
 * @param options - Whether to read, and which generation.
 * @returns The context, its loading flag, a message on failure and a refresh.
 *
 * @stability experimental
 */
export function useNoteGenerationContext(
  noteId: string,
  { enabled, generationId }: UseNoteGenerationContextOptions,
): UseNoteGenerationContextResult {
  const [context, setContext] = useState<NoteGenerationContext | null>(null);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const host = useKvoxHost();
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
        const result = await getNoteGenerationContext(host, noteId, generationId);
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
          err instanceof KvoxApiError && err.message
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
  }, [enabled, generationId, host, isMounted, noteId, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return { context, isLoading, error, refresh };
}

