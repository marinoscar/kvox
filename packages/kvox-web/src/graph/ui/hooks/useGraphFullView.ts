/**
 * `useGraphFullView` — the explorer's full-graph mode (#768): the WHOLE graph
 * from the stored layout snapshot, `GET /api/graph/overview?edges=true`, as an
 * explorer state the same canvas, inspector and list view read.
 *
 * Rules:
 *
 *   - The type filter and the time range go to the SERVER (`types`, `from`,
 *     `to`): the snapshot is capped at the 5,000 best-connected entities, so a
 *     filter applied to the server's answer, not to an already-trimmed one, is
 *     the only way "show me the Products" finds them all. Positions are the
 *     snapshot's, stable across requests, so a filter change redraws the same
 *     map, thinner.
 *   - `typeCounts` (live, time-filtered, not type-filtered) is kept with the
 *     window it was counted for, so the chips can say "Products (0)".
 *   - `status: 'none'` with a layout job pending is "building": re-read every
 *     `OVERVIEW_POLL_MS` while the tab is visible, and on Retry.
 *   - A newer request aborts the one in flight; the previous graph stays drawn
 *     until the new one arrives.
 *   - Nothing is fetched while `enabled` is false (a focused view, Start here).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { getGraphOverview, type GraphOverview } from '../../headless/clients/graph.js';
import { graphErrorMessage, isAbortError } from '../../headless/hooks/graphHookUtils.js';
import { OVERVIEW_POLL_MS } from '../../headless/hooks/useGraphOverview.js';
import {
  buildFullGraphState,
  restyleFullGraph,
} from '../components/explorer/fullGraphModel.js';
import {
  createExplorerState,
  mergeSlice,
  removeNode,
  type ExplorerPalette,
  type ExplorerState,
} from '../components/explorer/explorerModel.js';
import { FULL_VIEW_NODE_CAP } from '../components/explorer/fullGraphModel.js';
import type { GraphSlice } from '../../headless/clients/graph.js';
import { useIsMounted, useKvoxHost, useVisiblePolling } from '../../../core/headless/index.js';

/**
 * What the full view's last answer said about itself.
 *
 * @stability experimental
 */
export type FullViewStatus = 'idle' | 'loading' | 'ready' | 'building' | 'empty' | 'tooLarge' | 'error';

/**
 * Options of {@link useGraphFullView}.
 *
 * @stability experimental
 */
export interface UseGraphFullViewOptions {
  /** Fetch only while the page shows the full view. */
  enabled: boolean;
  /** The selected node types; empty = every type. */
  types: readonly string[];
  /** The time range, `YYYY-MM-DD` each end, or absent for All time. */
  from?: string | null;
  to?: string | null;
  /** Colour tokens; a change recolours in place. */
  palette?: ExplorerPalette;
}

/**
 * What {@link useGraphFullView} returns.
 *
 * @stability experimental
 */
export interface UseGraphFullViewResult {
  /** The whole graph as an explorer state. Mutated in place by `hide` and `addSlice`; re-read on `version`. */
  state: ExplorerState;
  /** Increments on every change of `state` or its graph. */
  version: number;
  status: FullViewStatus;
  /** A request is in flight (the first one, or a refetch after a filter change). */
  isLoading: boolean;
  error: string | null;
  /** The last answer, without its nodes and edges (they are in `state`). */
  overview: Omit<GraphOverview, 'nodes' | 'edges' | 'clusters' | 'clusterEdges'> | null;
  /** The live per-type counts of the last answer, and the window (`from|to`) they were counted for. */
  typeCounts: Readonly<Record<string, number>> | null;
  countsWindow: string | null;
  /** Repeats the last request. */
  retry: () => void;
  /** Takes a node off this view (until the next request). */
  hide: (id: string) => void;
  /** Merges a slice from another request (path mode, connect) into the full graph. */
  addSlice: (slice: GraphSlice) => { added: string[]; capped: boolean };
}

/** The key the counts are remembered under. */
export function countsWindowKey(from?: string | null, to?: string | null): string {
  return `${from ?? ''}|${to ?? ''}`;
}

/**
 * Loads and holds the full-graph view: the whole graph at its snapshot positions, filtered server-side.
 *
 * @stability experimental
 */
export function useGraphFullView(options: UseGraphFullViewOptions): UseGraphFullViewResult {
  const host = useKvoxHost();
  const { enabled, types, from = null, to = null, palette } = options;
  const typesKey = [...types].join(',');

  const stateRef = useRef<ExplorerState>(createExplorerState(FULL_VIEW_NODE_CAP));
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState<FullViewStatus>('idle');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overview, setOverview] = useState<UseGraphFullViewResult['overview']>(null);
  const [typeCounts, setTypeCounts] = useState<Record<string, number> | null>(null);
  const [countsWindow, setCountsWindow] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const isMounted = useIsMounted();
  const paletteRef = useRef(palette);
  paletteRef.current = palette;
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  useEffect(() => {
    if (!enabled) return undefined;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setIsLoading(true);
    setError(null);
    setStatus((current) => (current === 'ready' || current === 'building' ? current : 'loading'));
    getGraphOverview(host, controller.signal, {
      edges: true,
      ...(typesKey ? { types: typesKey.split(',') } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    })
      .then((answer) => {
        if (!isMounted() || controller.signal.aborted) return;
        const { nodes, edges, clusters: _clusters, clusterEdges: _clusterEdges, ...meta } = answer;
        stateRef.current = buildFullGraphState({ nodes, edges }, paletteRef.current);
        setOverview(meta);
        setTypeCounts(answer.typeCounts ?? {});
        setCountsWindow(countsWindowKey(from, to));
        const filtered = typesKey !== '' || Boolean(from) || Boolean(to);
        if (answer.status === 'none') setStatus(answer.pending ? 'building' : 'empty');
        else if (answer.tooLarge) setStatus('tooLarge');
        else if (nodes.length === 0 && !filtered) setStatus('empty');
        else setStatus('ready');
        setVersion((v) => v + 1);
      })
      .catch((err: unknown) => {
        if (isAbortError(err) || controller.signal.aborted || !isMounted()) return;
        setError(graphErrorMessage(err, 'Failed to load the graph'));
        setStatus('error');
      })
      .finally(() => {
        if (isMounted() && controllerRef.current === controller) setIsLoading(false);
      });
    return () => controller.abort();
    // `attempt` re-runs it (Retry, the building poll).
  }, [enabled, typesKey, from, to, attempt, host, isMounted]);

  // A theme change recolours in place.
  useEffect(() => {
    if (!palette) return;
    restyleFullGraph(stateRef.current, palette);
    setVersion((v) => v + 1);
  }, [palette]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  // While the first map is being built, look again now and then (never in a hidden tab).
  useVisiblePolling(retry, enabled && status === 'building' && !isLoading ? OVERVIEW_POLL_MS : 0);

  const hide = useCallback((id: string) => {
    if (removeNode(stateRef.current, id)) setVersion((v) => v + 1);
  }, []);

  const addSlice = useCallback((slice: GraphSlice) => {
    const result = mergeSlice(stateRef.current, slice, { palette: paletteRef.current });
    setVersion((v) => v + 1);
    return result;
  }, []);

  return {
    state: stateRef.current,
    version,
    status,
    isLoading,
    error,
    overview,
    typeCounts,
    countsWindow,
    retry,
    hide,
    addSlice,
  };
}
