/**
 * `useGraphActivity` — the evidence activity of the visible graph over time
 * (GIC-15, #676), for the explorer's TimeBar.
 *
 * Debounced: a change of the node set (an expand, a hide) is one request after
 * it settles, not one per step. The previous answer stays in `data` while the
 * next one loads, so the histogram does not flash empty. At most
 * {@link GRAPH_ACTIVITY_MAX_IDS} ids are asked about.
 */

import { useEffect, useState } from 'react';

import { useKvoxHost } from '../../../core/headless/index.js';
import {
  GRAPH_ACTIVITY_MAX_IDS,
  getGraphActivity,
  type GraphActivityBucket,
  type GraphActivityResponse,
} from '../clients/graph.js';
import { graphErrorMessage, isAbortError } from './graphHookUtils.js';

/**
 * The pause after the last change before a request goes out, in ms.
 *
 * @stability experimental
 */
export const GRAPH_ACTIVITY_DEBOUNCE_MS = 250;

/**
 * What {@link useGraphActivity} returns.
 *
 * @stability experimental
 */
export interface UseGraphActivityResult {
  /** The last answer, or `null` before the first. */
  data: GraphActivityResponse | null;
  /** A request is in flight or waiting out its debounce. */
  isLoading: boolean;
  /** A message when the last request failed, else `null`. */
  error: string | null;
}

/**
 * Reads the activity of `ids` in `bucket` buckets. Does nothing without ids.
 *
 * @stability experimental
 */
export function useGraphActivity(ids: readonly string[], bucket: GraphActivityBucket): UseGraphActivityResult {
  const host = useKvoxHost();
  const key = [...new Set(ids)].sort().slice(0, GRAPH_ACTIVITY_MAX_IDS).join(',');
  const [state, setState] = useState<UseGraphActivityResult>({ data: null, isLoading: false, error: null });

  useEffect(() => {
    if (!key) {
      setState({ data: null, isLoading: false, error: null });
      return undefined;
    }
    const controller = new AbortController();
    setState((previous) => ({ ...previous, isLoading: true }));
    const timer = setTimeout(() => {
      getGraphActivity(host, { ids: key.split(','), bucket }, controller.signal)
        .then((data) => {
          if (!controller.signal.aborted) setState({ data, isLoading: false, error: null });
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted || isAbortError(err)) return;
          setState((previous) => ({
            data: previous.data,
            isLoading: false,
            error: graphErrorMessage(err, 'Failed to load the activity'),
          }));
        });
    }, GRAPH_ACTIVITY_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // `host` is stable for the provider's lifetime.
  }, [key, bucket]);

  return state;
}
