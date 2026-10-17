/**
 * `useGraphAiConfig` — the viewer's AI availability for the connected-knowledge
 * screens (the extract dialog's model picker and key notice, the review sheet's
 * model label, the Knowledge graph settings banners).
 *
 * One read of `GET /api/ai-tasks/config` per mounted consumer, as before. A
 * failure is a `null` config, never an exception: every consumer treats "unknown"
 * as "no key", the safe direction.
 */

import { useEffect, useState } from 'react';

import { useIsMounted, useKvoxHost } from '../../../core/headless/index.js';
import { getGraphAiConfig } from '../clients/graph.js';
import type { GraphAiConfig } from '../clients/graph.js';

/**
 * What {@link useGraphAiConfig} returns.
 *
 * @stability experimental
 */
export interface UseGraphAiConfigResult {
  /** The answer, or `null` while loading and after a failed read. */
  config: GraphAiConfig | null;
  /** The read has not settled yet. */
  isLoading: boolean;
}

/**
 * Reads the viewer's AI availability.
 *
 * @returns The configuration and whether it is still loading.
 *
 * @stability experimental
 */
export function useGraphAiConfig(): UseGraphAiConfigResult {
  const host = useKvoxHost();
  const [config, setConfig] = useState<GraphAiConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const isMounted = useIsMounted();

  useEffect(() => {
    const controller = new AbortController();
    setIsLoading(true);
    void getGraphAiConfig(host, controller.signal)
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
