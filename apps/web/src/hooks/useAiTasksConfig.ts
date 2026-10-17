/**
 * `GET /api/ai-tasks/config` — the ONE place `keyConfigured` is derived
 * (issue #477, epic #472; the former AI config hook, moved).
 *
 * Every AI surface asks the same question before it renders anything: does this
 * user have a key? The answer is a single boolean on a single endpoint, and it
 * lives here so no page re-derives it. A page that inferred it from the key
 * list instead would be answering a subtly different question ("is a key stored
 * for SOME provider?").
 *
 * TWO BOOLEANS, NOT ONE, AND THEY ARE NOT INTERCHANGEABLE:
 *
 *   `available`     the DEPLOYMENT can do this: AI is enabled, a provider is
 *                   active, at least one model is permitted.
 *   `keyConfigured` the CALLER can do this: they have saved a key (on the
 *                   platform's AI Provider page, `/settings/ai`).
 *
 * They are independent by design, so a surface can say "your administrator has
 * not turned this on" and "you have not added a key" as the two different
 * sentences they are. `canGenerate` is the conjunction, offered here so the
 * surfaces do not each write the `&&`.
 *
 * The platform's own AI config hook (`@marinoscar/platform-web/ai/headless`)
 * answers a different question (is AI on, which providers) from a different
 * endpoint (`GET /api/ai/config`). It drives the settings feature gate; this
 * hook drives the app's own surfaces and never replaces it.
 *
 * Shaped after `useNotificationConfig`: one read, `isMounted` after the await,
 * an error that is a string the page renders rather than an exception it has to
 * catch.
 */

import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '../services/api';
import { getAiTasksConfig } from '../services/aiTasks';
import type { AiTasksConfig } from '../services/aiTasks';
import { useIsMounted } from '@marinoscar/kvox-web/core/headless';

function messageFor(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 403) {
      return 'You do not have permission to use AI features';
    }
    return err.message || fallback;
  }
  return fallback;
}

export interface UseAiTasksConfigReturn {
  config: AiTasksConfig | null;
  isLoading: boolean;
  loadError: string | null;
  /**
   * ⚠ THE GATE. False means render `AiKeyRequired` and nothing else.
   *
   * `false` while loading and after a failed load: a surface must not offer
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

export interface UseAiTasksConfigOptions {
  /**
   * Do not read (and drop any answer already held). For a mount that exists
   * before anybody is signed in: `GET /api/ai-tasks/config` is authenticated, so
   * reading it on the login page buys a guaranteed 401.
   */
  skip?: boolean;
}

export function useAiTasksConfig(options: UseAiTasksConfigOptions = {}): UseAiTasksConfigReturn {
  const skip = options.skip === true;
  const [config, setConfig] = useState<AiTasksConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const isMounted = useIsMounted();

  const fetchConfig = useCallback(async () => {
    try {
      setIsLoading(true);
      setLoadError(null);
      const next = await getAiTasksConfig();
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
    if (skip) {
      setConfig(null);
      setLoadError(null);
      setIsLoading(false);
      return;
    }
    void fetchConfig();
  }, [skip, fetchConfig]);

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
