/**
 * The version history, paginated — issue #31, epic #19.
 *
 * Shaped like `useTranscripts`'s list hook and for the same reasons: cursor
 * paging (never offset), `loadMore` APPENDS while `refresh` resets, and every
 * function resolves rather than throws so a failure is a STRING the page
 * renders.
 *
 * It deliberately does NOT poll. A transcript's history is append-only and a
 * user reading it is reading the past; re-fetching it every few seconds would
 * reshuffle a list somebody is scrolling through in order to tell them about a
 * row at the top they did not ask for. `refresh` exists for the one moment it
 * genuinely changed — a restore this page itself performed.
 */

import { KvoxApiError, useIsMounted, useKvoxHost } from '../../../core/headless/index.js';
import { useCallback, useEffect, useState } from 'react';

import { getTranscriptVersions } from '../clients/transcriptEditing.js';
import type { TranscriptVersionSummary } from '../clients/transcriptEditing.js';

/**
 * What {@link useTranscriptVersions} returns.
 *
 * @stability experimental
 */
export interface UseTranscriptVersionsResult {
  /** The loaded rows of the history, newest first. */
  versions: TranscriptVersionSummary[];
  /** The transcript's current version. */
  currentVersion: number | null;
  /** True until the first page lands. */
  isLoading: boolean;
  /** True while a further page is loading. */
  isLoadingMore: boolean;
  /** A sentence to render, or null. */
  error: string | null;
  /** The cursor of the next page, or null at the end. */
  nextCursor: string | null;
  /** Loads the next page. */
  loadMore: () => Promise<void>;
  /** Re-reads the first page. */
  refresh: () => Promise<void>;
}

function messageFor(err: unknown, fallback: string): string {
  if (err instanceof KvoxApiError) {
    if (err.status === 404) {
      return 'This transcript does not exist, or you no longer have access to it';
    }
    return err.message || fallback;
  }
  return fallback;
}

/**
 * The version history of a transcript, a page at a time.
 *
 * @stability experimental
 */
export function useTranscriptVersions(
  id: string | undefined,
): UseTranscriptVersionsResult {
  const [versions, setVersions] = useState<TranscriptVersionSummary[]>([]);
  const [currentVersion, setCurrentVersion] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isMounted = useIsMounted();
  const host = useKvoxHost();

  const load = useCallback(
    async (showLoading: boolean) => {
      if (!id) return;
      if (showLoading) setIsLoading(true);
      try {
        const response = await getTranscriptVersions(host, id, { limit: 50 });
        if (!isMounted()) return;
        setVersions(response.items);
        setCurrentVersion(response.currentVersion);
        setNextCursor(response.nextCursor);
        setError(null);
      } catch (err) {
        if (isMounted()) setError(messageFor(err, 'Failed to load the version history'));
      } finally {
        if (isMounted()) setIsLoading(false);
      }
    },
    [id, host, isMounted],
  );

  useEffect(() => {
    setVersions([]);
    setCurrentVersion(null);
    setNextCursor(null);
    if (!id) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    void load(true);
  }, [id, load]);

  const loadMore = useCallback(async () => {
    if (!id || !nextCursor || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const response = await getTranscriptVersions(host, id, { cursor: nextCursor, limit: 50 });
      if (!isMounted()) return;
      // Deduped on append, exactly as the library list is: a version cannot
      // move, but a page boundary can still repeat a row, and React would warn
      // about the duplicate key while rendering it twice.
      setVersions((current) => {
        const seen = new Set(current.map((item) => item.version));
        return [...current, ...response.items.filter((item) => !seen.has(item.version))];
      });
      setNextCursor(response.nextCursor);
      setError(null);
    } catch (err) {
      if (isMounted()) setError(messageFor(err, 'Failed to load more versions'));
    } finally {
      if (isMounted()) setIsLoadingMore(false);
    }
  }, [id, isLoadingMore, host, isMounted, nextCursor]);

  const refresh = useCallback(() => load(false), [load]);

  return {
    versions,
    currentVersion,
    isLoading,
    isLoadingMore,
    error,
    nextCursor,
    loadMore,
    refresh,
  };
}

