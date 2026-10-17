/**
 * `useAskAiConfig`: the viewer's AI availability for the Ask screens (the model
 * picker, the "add your key" notice, the page's "connected knowledge is off"
 * state).
 *
 * One read of `GET /api/ai-tasks/config` per mounted consumer. A failure is a
 * `null` config, never an exception: every consumer treats "unknown" as "no
 * extra information" (the composer then offers no model picker and shows no key
 * notice, exactly as before).
 */

import { useEffect, useState } from 'react';

import { useIsMounted, useKvoxHost } from '../../../core/headless/index.js';
import { getAskAiConfig } from '../clients/askAiConfig.js';
import type { AskAiConfig } from '../clients/askAiConfig.js';

/**
 * What {@link useAskAiConfig} returns.
 *
 * @stability experimental
 */
export interface UseAskAiConfigResult {
  /** The answer, or `null` while loading and after a failed read. */
  config: AskAiConfig | null;
  /** The read has not settled yet. */
  isLoading: boolean;
}

/**
 * Reads the viewer's AI availability for Ask.
 *
 * @returns The configuration and whether it is still loading.
 *
 * @stability experimental
 */
export function useAskAiConfig(): UseAskAiConfigResult {
  const host = useKvoxHost();
  const [config, setConfig] = useState<AskAiConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const isMounted = useIsMounted();

  useEffect(() => {
    const controller = new AbortController();
    setIsLoading(true);
    void getAskAiConfig(host, controller.signal)
      .then((next) => {
        if (isMounted() && !controller.signal.aborted) setConfig(next);
      })
      .catch(() => {
        if (isMounted() && !controller.signal.aborted) setConfig(null);
      })
      .finally(() => {
        if (isMounted() && !controller.signal.aborted) setIsLoading(false);
      });
    return () => controller.abort();
  }, [host, isMounted]);

  return { config, isLoading };
}
