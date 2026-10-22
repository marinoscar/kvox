/**
 * "What connects these?" for the explorer (GIC-14, #675): one request at a time
 * to `POST /api/graph/connect`, the newest answer wins, an older one is aborted.
 * The result stays until `clear()` (or the next `run`), so the canvas can keep
 * the shared entities ringed while the user reads the list.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { KvoxApiError, useIsMounted, useKvoxHost } from '../../../core/headless/index.js';
import { postGraphConnect } from '../../headless/clients/graph.js';
import type { GraphConnectParams, GraphConnectResponse } from '../../headless/clients/graph.js';
import { graphErrorMessage, isAbortError } from '../../headless/hooks/graphHookUtils.js';

/**
 * What {@link useGraphConnect} returns.
 *
 * @stability experimental
 */
export interface UseGraphConnectResult {
  /** The last answer, or `null` before any request and after `clear()`. */
  result: GraphConnectResponse | null;
  /** A request is in flight. */
  isLoading: boolean;
  /** A message when the last request failed, else `null`. */
  error: string | null;
  /** The last request failed because an input is not readable (a 404). */
  notFound: boolean;
  /** Asks again; resolves with the answer, or `null` when it failed or was superseded. */
  run: (params: GraphConnectParams) => Promise<GraphConnectResponse | null>;
  /** Forgets the answer and any error, and aborts a request in flight. */
  clear: () => void;
}

/**
 * Holds the answer of `POST /api/graph/connect` for the explorer.
 *
 * @returns The answer, its status and the two actions.
 *
 * @stability experimental
 */
export function useGraphConnect(): UseGraphConnectResult {
  const host = useKvoxHost();
  const isMounted = useIsMounted();
  const controllerRef = useRef<AbortController | null>(null);
  const [result, setResult] = useState<GraphConnectResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const run = useCallback(
    async (params: GraphConnectParams): Promise<GraphConnectResponse | null> => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      setIsLoading(true);
      setError(null);
      setNotFound(false);
      try {
        const response = await postGraphConnect(host, params, controller.signal);
        if (!isMounted() || controller.signal.aborted) return null;
        setResult(response);
        return response;
      } catch (err) {
        if (isAbortError(err) || controller.signal.aborted || !isMounted()) return null;
        setResult(null);
        setNotFound(err instanceof KvoxApiError && err.status === 404);
        setError(graphErrorMessage(err, 'Could not find what these have in common'));
        return null;
      } finally {
        if (isMounted() && controllerRef.current === controller) setIsLoading(false);
      }
    },
    [host, isMounted],
  );

  const clear = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setResult(null);
    setError(null);
    setNotFound(false);
    setIsLoading(false);
  }, []);

  return { result, isLoading, error, notFound, run, clear };
}
