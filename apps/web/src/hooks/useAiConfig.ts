/**
 * `GET /api/ai/config` — the ONE place `keyConfigured` is derived.
 *
 * Issue #55, epic #45. Every AI surface in this epic (#56, #57, #58, #59) asks
 * the same question before it renders anything: does this user have a key? The
 * answer is a single boolean on a single endpoint, and it lives here so no page
 * re-derives it — a page that inferred it from `GET /api/ai-credentials`
 * instead would be answering a subtly different question ("is a key stored for
 * SOME provider?") and would disagree with this one the moment an administrator
 * changed the active provider.
 *
 * TWO BOOLEANS, NOT ONE, AND THEY ARE NOT INTERCHANGEABLE:
 *
 *   `available`     the DEPLOYMENT can do this — AI is enabled, the provider is
 *                   registered, at least one permitted model is budgetable.
 *   `keyConfigured` the CALLER can do this — they have saved a key.
 *
 * They are independent by design, so a surface can say "your administrator has
 * not turned this on" and "you have not added a key" as the two different
 * sentences they are. `canGenerate` is the conjunction, offered here so the
 * four surfaces do not each write the `&&`.
 *
 * Shaped after `useNotificationConfig`: one read, `isMounted` after the await,
 * an error that is a string the page renders rather than an exception it has to
 * catch.
 */

import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '../services/api';
import { getAiConfig } from '../services/ai';
import type { AiConfig } from '../services/ai';
import { useIsMounted } from './useIsMounted';

function messageFor(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 403) {
      return 'You do not have permission to use AI features';
    }
    return err.message || fallback;
  }
  return fallback;
}

export interface UseAiConfigReturn {
  config: AiConfig | null;
  isLoading: boolean;
  loadError: string | null;
  /**
   * ⚠ THE GATE. False means render `AiKeyRequired` and nothing else.
   *
   * `false` while loading and after a failed load — a surface must not offer
   * generation on an unanswered question, and the loading flag is right there
   * for anything that wants to draw a spinner instead.
   */
  keyConfigured: boolean;
  /** The deployment permits AI at all. Independent of `keyConfigured`. */
  available: boolean;
  /** Both of the above. The condition an actual generation control needs. */
  canGenerate: boolean;
  refresh: () => Promise<void>;
}

export function useAiConfig(): UseAiConfigReturn {
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const isMounted = useIsMounted();

  const fetchConfig = useCallback(async () => {
    try {
      setIsLoading(true);
      setLoadError(null);
      const next = await getAiConfig();
      if (isMounted()) setConfig(next);
    } catch (err) {
      if (isMounted()) {
        setLoadError(messageFor(err, 'Failed to load AI configuration'));
        // Cleared rather than left stale: a failed refresh must not leave a
        // surface rendering the feature on a `keyConfigured` from ten minutes
        // ago. `AiKeyRequired` is the safe thing to show when we do not know.
        setConfig(null);
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    void fetchConfig();
  }, [fetchConfig]);

  return {
    config,
    isLoading,
    loadError,
    keyConfigured: config?.keyConfigured ?? false,
    available: config?.available ?? false,
    canGenerate: (config?.available ?? false) && (config?.keyConfigured ?? false),
    refresh: fetchConfig,
  };
}
