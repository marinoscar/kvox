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

import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '../services/api';
import { getTranscriptVersions } from '../services/transcriptEditing';
import type { TranscriptVersionSummary } from '../services/transcriptEditing';
import { useIsMounted } from './useIsMounted';

export interface UseTranscriptVersionsResult {
  versions: TranscriptVersionSummary[];
  currentVersion: number | null;
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;
  nextCursor: string | null;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
}

function messageFor(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 404) {
      return 'This transcript does not exist, or you no longer have access to it';
    }
    return err.message || fallback;
  }
  return fallback;
}

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

  const load = useCallback(
    async (showLoading: boolean) => {
      if (!id) return;
      if (showLoading) setIsLoading(true);
      try {
        const response = await getTranscriptVersions(id, { limit: 50 });
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
    [id, isMounted],
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
      const response = await getTranscriptVersions(id, { cursor: nextCursor, limit: 50 });
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
  }, [id, isLoadingMore, isMounted, nextCursor]);

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

export default useTranscriptVersions;
