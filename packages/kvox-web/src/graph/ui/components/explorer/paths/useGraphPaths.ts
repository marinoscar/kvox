/**
 * `useGraphPaths` — runs `GET /graph/paths` for path mode (GIC-13, #674) and
 * reports one of four states: idle (nothing asked), loading, ready, or an
 * error (the API's 503 `graph_query_timeout` reads "try fewer hops"). A newer
 * request aborts the one in flight, so a slow answer for the previous pair
 * never lands on the next.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { KvoxApiError, useKvoxHost } from '../../../../../core/headless/index.js';
import { getGraphPaths, type GraphPathsResponse } from '../../../../headless/clients/graph.js';
import { graphErrorMessage, isAbortError } from '../../../../headless/hooks/graphHookUtils.js';
import { PATH_COUNT } from './pathModel.js';

/**
 * What a path search asks.
 *
 * @stability experimental
 */
export interface GraphPathsQuery {
  /** Start entity id. */
  from: string;
  /** End entity id. */
  to: string;
  /** Longest path in edges. */
  maxHops: number;
  /** Relation types a path may follow; empty means all. */
  relationTypes: readonly string[];
  /** Evaluate the graph as of this date, or now when `null`. */
  asOf: string | null;
}

/**
 * Why a search failed.
 *
 * @stability experimental
 */
export interface GraphPathsFailure {
  /** `timeout` is the API's 503; `not-found` its 404; anything else is `other`. */
  kind: 'timeout' | 'not-found' | 'other';
  /** The sentence to show. */
  message: string;
}

/** The sentence shown for the API's 503. */
export const PATH_TIMEOUT_MESSAGE = 'That search took too long, try fewer hops';
/** The sentence shown for a 404: one of the two is not in the caller's graph. */
export const PATH_NOT_FOUND_MESSAGE = "One of those isn't in your graph";

/**
 * The state of a path search.
 *
 * @stability experimental
 */
export interface UseGraphPathsResult {
  /** `idle` while there is no query. */
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** The answer once `ready`. */
  data: GraphPathsResponse | null;
  /** The failure once `error`. */
  failure: GraphPathsFailure | null;
  /** Repeats the search. */
  retry: () => void;
}

/** Classifies a failed request. */
export function classifyPathFailure(error: unknown): GraphPathsFailure {
  if (error instanceof KvoxApiError && error.status === 503) return { kind: 'timeout', message: PATH_TIMEOUT_MESSAGE };
  if (error instanceof KvoxApiError && error.status === 404) return { kind: 'not-found', message: PATH_NOT_FOUND_MESSAGE };
  return { kind: 'other', message: graphErrorMessage(error, 'Failed to look for a connection') };
}

/**
 * Looks for the best paths between two entities. Does nothing for a `null` query.
 *
 * @stability experimental
 */
export function useGraphPaths(query: GraphPathsQuery | null): UseGraphPathsResult {
  const host = useKvoxHost();
  const [state, setState] = useState<Omit<UseGraphPathsResult, 'retry'>>({ status: 'idle', data: null, failure: null });
  const [attempt, setAttempt] = useState(0);
  const key = query ? `${query.from}|${query.to}|${query.maxHops}|${query.relationTypes.join(',')}|${query.asOf ?? ''}` : '';
  const latest = useRef(query);
  latest.current = query;

  useEffect(() => {
    const current = latest.current;
    if (!key || !current) {
      // Already idle: keep the same object, so the page does not render again for nothing.
      setState((previous) => (previous.status === 'idle' ? previous : { status: 'idle', data: null, failure: null }));
      return undefined;
    }
    const controller = new AbortController();
    setState({ status: 'loading', data: null, failure: null });
    getGraphPaths(
      host,
      {
        from: current.from,
        to: current.to,
        k: PATH_COUNT,
        maxHops: current.maxHops,
        ...(current.relationTypes.length > 0 ? { relationTypes: current.relationTypes } : {}),
        ...(current.asOf ? { asOf: current.asOf } : {}),
      },
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted) setState({ status: 'ready', data, failure: null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        setState({ status: 'error', data: null, failure: classifyPathFailure(error) });
      });
    return () => controller.abort();
    // `host` is stable for the page's life; the key stands for the query.
  }, [key, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry };
}
