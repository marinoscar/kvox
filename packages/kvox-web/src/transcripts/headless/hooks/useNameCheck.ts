/**
 * `useNameCheck` — the latest AI name check for one transcript (#329, #330).
 *
 * STATE-DRIVEN, NOT EVENT-DRIVEN. Everything this hook knows comes from
 * `GET /name-checks/latest`: whether a check is running, what it found, how
 * many suggestions are left. Starting a check does not hand the panel its
 * results — it re-reads `latest` — so a reload, a second tab or a check started
 * on another device all render identically, and a check that finishes while
 * the page is closed is waiting there when it reopens.
 *
 * Polls every {@link NAME_CHECK_POLL_MS} through `useVisiblePolling` while the
 * run is `pending`/`running`, and not otherwise: a finished run's suggestions
 * only change when this user acts on them, and every action re-reads.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  applyNameSuggestions,
  createNameCheck,
  getLatestNameCheck,
  rejectNameSuggestions,
} from '../clients/transcriptNameChecks.js';
import type {
  ApplyNameSuggestionsResult,
  CreateNameCheckInput,
  CreateNameCheckResult,
  LatestNameCheck,
} from '../clients/transcriptNameChecks.js';
import { KvoxApiError, useIsMounted, useKvoxHost, useVisiblePolling } from '../../../core/headless/index.js';

export const NAME_CHECK_POLL_MS = 3_000;

/**
 * The options of {@link useNameCheck}.
 *
 * @stability experimental
 */
export interface UseNameCheckOptions {
  /** The transcript to read the latest check of. */
  transcriptId: string | undefined;
  /** False skips every request — a viewer, or a transcript not ready yet. */
  enabled: boolean;
  /** Overridable for tests. `<= 0` disables polling. */
  pollMs?: number;
}

/**
 * What {@link useNameCheck} returns.
 *
 * @stability experimental
 */
export interface UseNameCheckResult {
  /** The latest run with its pending suggestions, or null. */
  latest: LatestNameCheck | null;
  /** True until the first answer arrives. */
  isLoading: boolean;
  /** A sentence to show when the latest run could not be read, or null. */
  loadError: string | null;
  /** True while the latest run is `pending` or `running`. */
  isRunning: boolean;
  /** Re-reads the latest run. */
  refresh: () => Promise<void>;
  /** Throws the API's error — the start dialog branches on its 409 reasons. */
  start: (input: CreateNameCheckInput) => Promise<CreateNameCheckResult>;
  /** Throws the API's error — the page routes a 409 through conflict handling. */
  apply: (suggestionIds: string[]) => Promise<ApplyNameSuggestionsResult | null>;
  /** Rejects the given suggestions. */
  reject: (suggestionIds: string[]) => Promise<number>;
}

/**
 * The latest AI name check of a transcript, with the actions that accept, reject and refresh it.
 *
 * @stability experimental
 */
export function useNameCheck({
  transcriptId,
  enabled,
  pollMs = NAME_CHECK_POLL_MS,
}: UseNameCheckOptions): UseNameCheckResult {
  const isMounted = useIsMounted();
  const host = useKvoxHost();
  const [latest, setLatest] = useState<LatestNameCheck | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Drops an out-of-order response: only the newest request may write. */
  const requestSeq = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled || !transcriptId) return;
    const seq = ++requestSeq.current;
    setIsLoading(true);
    try {
      const next = await getLatestNameCheck(host, transcriptId);
      if (!isMounted() || seq !== requestSeq.current) return;
      setLatest(next);
      setLoadError(null);
    } catch (err) {
      if (!isMounted() || seq !== requestSeq.current) return;
      setLoadError(
        err instanceof KvoxApiError ? err.message : 'The name check could not be loaded.',
      );
    } finally {
      if (isMounted() && seq === requestSeq.current) setIsLoading(false);
    }
  }, [enabled, host, isMounted, transcriptId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const status = latest?.run?.status;
  const isRunning = status === 'pending' || status === 'running';

  useVisiblePolling(
    () => {
      void refresh();
    },
    enabled && isRunning ? pollMs : 0,
  );

  const start = useCallback(
    async (input: CreateNameCheckInput) => {
      if (!transcriptId) throw new Error('No transcript');
      const result = await createNameCheck(host, transcriptId, input);
      if (isMounted()) {
        // Shown as running at once — the next poll brings whatever else changed.
        setLatest({
          run: result.run,
          suggestions: [],
          counts: { pending: 0, accepted: 0, rejected: 0, stale: 0 },
        });
        void refresh();
      }
      return result;
    },
    [host, isMounted, refresh, transcriptId],
  );

  const apply = useCallback(
    async (suggestionIds: string[]) => {
      const checkId = latest?.run?.id;
      if (!transcriptId || !checkId || suggestionIds.length === 0) return null;
      try {
        return await applyNameSuggestions(host, transcriptId, checkId, suggestionIds);
      } finally {
        // Re-read either way: a 409 leaves some suggestions pending and may
        // have made others stale.
        void refresh();
      }
    },
    [host, latest?.run?.id, refresh, transcriptId],
  );

  const reject = useCallback(
    async (suggestionIds: string[]) => {
      const checkId = latest?.run?.id;
      if (!transcriptId || !checkId || suggestionIds.length === 0) return 0;
      // Optimistic: a rejected row leaves the panel at once. The re-read below
      // restores it if the server disagreed.
      const drop = new Set(suggestionIds);
      setLatest((current) =>
        current
          ? {
              ...current,
              suggestions: current.suggestions.filter((item) => !drop.has(item.id)),
            }
          : current,
      );
      try {
        const result = await rejectNameSuggestions(host, transcriptId, checkId, suggestionIds);
        return result.rejected;
      } finally {
        void refresh();
      }
    },
    [host, latest?.run?.id, refresh, transcriptId],
  );

  return { latest, isLoading, loadError, isRunning, refresh, start, apply, reject };
}

