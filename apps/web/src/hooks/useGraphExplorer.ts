/**
 * `useGraphExplorer` — the explorer's state and its requests (#374, epic #347;
 * spec §22.2).
 *
 * The graph itself is a mutable graphology object held in a ref (the canvas
 * renders it in place); `version` increments on EVERY mutation so React — and
 * `GraphCanvas`'s layout effect — know to re-sync. Every rule about WHAT the
 * graph may hold lives in `components/graph/explorer/explorerModel.ts`; this
 * hook only decides WHEN to ask the API and applies the answer.
 *
 * Rules (from the issue, each pinned by `useGraphExplorer.test.ts`):
 *
 *   - `expand(id)` at the cap sends NOTHING and sets `capped` — §22.2:
 *     expansion is refused, never silently degraded. Otherwise it asks for at
 *     most `remainingCapacity` nodes.
 *   - Filters are SERVER-SIDE: every request carries the allowed `types` and
 *     `relationTypes` (omitted while nothing is hidden), so a filtered-out type
 *     is never fetched. Changing a filter prunes what no longer qualifies
 *     (seeds excepted); re-enabling one does not refetch retroactively.
 *   - `setAsOf` rebuilds from scratch from the seeds and every expanded node
 *     (≤ 50), keeping the positions of nodes that survive.
 *   - A newer request aborts the one in flight.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  EXPLORER_MAX_REQUEST_SEEDS,
  EXPLORER_NODE_CAP,
  applyFilters,
  createExplorerState,
  makeSeed as makeSeedInModel,
  mergeSlice,
  positionsOf,
  remainingCapacity,
  removeNode,
  restyle,
  seedFromNodes,
  type ExplorerPalette,
  type ExplorerState,
} from '../components/graph/explorer/explorerModel';
import type { ExplorerHandoff } from '../components/graph/explorer/explorerHandoff';
import { ApiError } from '../services/api';
import { expandGraph } from '../services/graph';
import type { GraphSlice } from '../services/graph';
import { graphErrorMessage, isAbortError } from './graphHookUtils';
import { useIsMounted } from './useIsMounted';

export interface UseGraphExplorerOptions {
  /** Every node type the caller's ontology knows: entity type keys and item kinds. */
  nodeTypes: readonly string[];
  /** Every relation type key the caller's ontology knows. */
  relationTypes: readonly string[];
  palette?: ExplorerPalette;
}

export interface UseGraphExplorerResult {
  state: ExplorerState;
  version: number;
  /** A load or an `as_of` rebuild is in flight. */
  isLoading: boolean;
  /** The node an expand is in flight for. */
  expandingId: string | null;
  error: string | null;
  /** The seed(s) are not (or no longer) in the caller's graph — #370's one 404. */
  notFound: boolean;
  /** An expand was refused, or a merge dropped nodes, at the cap. */
  capped: boolean;
  /** The last slice had more than it returned. */
  truncated: boolean;
  load: (seedIds: readonly string[]) => Promise<void>;
  loadHandoff: (handoff: ExplorerHandoff) => Promise<void>;
  expand: (nodeId: string) => Promise<void>;
  setAsOf: (date: string | null) => Promise<void>;
  setHiddenTypes: (types: Iterable<string>) => void;
  setHiddenRelationTypes: (types: Iterable<string>) => void;
  hide: (nodeId: string) => void;
  makeSeed: (nodeId: string) => void;
  /** Dismiss the cap warning (it returns on the next refusal). */
  dismissCap: () => void;
  retry: () => Promise<void>;
  reset: () => void;
}

function allowedList(universe: readonly string[], hidden: ReadonlySet<string>): string[] | undefined {
  if (hidden.size === 0) return undefined;
  return universe.filter((key) => !hidden.has(key));
}

export function useGraphExplorer(options: UseGraphExplorerOptions): UseGraphExplorerResult {
  const { nodeTypes, relationTypes, palette } = options;

  const stateRef = useRef<ExplorerState>(createExplorerState());
  const [version, setVersion] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [expandingId, setExpandingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [capped, setCapped] = useState(false);
  const [truncated, setTruncated] = useState(false);

  const isMounted = useIsMounted();
  const controllerRef = useRef<AbortController | null>(null);
  const lastActionRef = useRef<(() => Promise<void>) | null>(null);

  // Read the latest options inside callbacks without re-creating them.
  const optionsRef = useRef({ nodeTypes, relationTypes, palette });
  optionsRef.current = { nodeTypes, relationTypes, palette };

  const bump = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
    },
    [],
  );

  // A theme change recolours in place.
  useEffect(() => {
    if (!palette) return;
    restyle(stateRef.current, palette);
    bump();
  }, [palette, bump]);

  const nextController = useCallback(() => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    return controller;
  }, []);

  const filtersFor = useCallback((state: ExplorerState) => {
    const opts = optionsRef.current;
    return {
      types: allowedList(opts.nodeTypes, state.hiddenTypes),
      relationTypes: allowedList(opts.relationTypes, state.hiddenRelationTypes),
      asOf: state.asOf ?? undefined,
    };
  }, []);

  const fail = useCallback((err: unknown, fallback: string) => {
    if (err instanceof ApiError && err.status === 404) setNotFound(true);
    setError(graphErrorMessage(err, fallback));
  }, []);

  /** Fetch a fresh slice for `seedIds` and install it as a NEW state. */
  const rebuild = useCallback(
    async (
      seedIds: readonly string[],
      base: ExplorerState,
      expandFrom: readonly string[],
      carryPositions: boolean,
    ) => {
      const controller = nextController();
      setIsLoading(true);
      setError(null);
      setNotFound(false);
      const requested = [...new Set(expandFrom)].slice(0, EXPLORER_MAX_REQUEST_SEEDS);
      try {
        const slice = await expandGraph(
          { nodeIds: requested, ...filtersFor(base), cap: EXPLORER_NODE_CAP },
          controller.signal,
        );
        if (!isMounted() || controller.signal.aborted) return;
        const next = createExplorerState();
        next.asOf = base.asOf;
        next.hiddenTypes = new Set(base.hiddenTypes);
        next.hiddenRelationTypes = new Set(base.hiddenRelationTypes);
        const { capped: wasCapped } = mergeSlice(next, orderSeedsFirst(slice, seedIds), {
          palette: optionsRef.current.palette,
          previousPositions: carryPositions ? positionsOf(base) : undefined,
        });
        next.seedIds = [...new Set(seedIds)].filter((id) => next.graph.hasNode(id));
        for (const id of requested) if (next.graph.hasNode(id)) next.expanded.add(id);
        stateRef.current = next;
        setCapped(wasCapped);
        setTruncated(slice.truncated);
        bump();
      } catch (err) {
        if (isAbortError(err) || controller.signal.aborted || !isMounted()) return;
        fail(err, 'Failed to load the graph');
      } finally {
        if (isMounted() && controllerRef.current === controller) setIsLoading(false);
      }
    },
    [bump, fail, filtersFor, isMounted, nextController],
  );

  const load = useCallback(
    async (seedIds: readonly string[]) => {
      const base = createExplorerState();
      base.asOf = stateRef.current.asOf;
      base.hiddenTypes = new Set(stateRef.current.hiddenTypes);
      base.hiddenRelationTypes = new Set(stateRef.current.hiddenRelationTypes);
      const seeds = [...new Set(seedIds)].slice(0, EXPLORER_MAX_REQUEST_SEEDS);
      const action = () => rebuild(seeds, base, seeds, false);
      lastActionRef.current = action;
      await action();
    },
    [rebuild],
  );

  const loadHandoff = useCallback(
    async (handoff: ExplorerHandoff) => {
      // Render the overview's nodes NOW, at their overview positions.
      const next = createExplorerState();
      seedFromNodes(next, handoff.seedIds, handoff.nodes, optionsRef.current.palette);
      stateRef.current = next;
      setCapped(false);
      setTruncated(false);
      bump();

      const seeds = next.seedIds.slice(0, EXPLORER_MAX_REQUEST_SEEDS);
      const action = async () => {
        const controller = nextController();
        setIsLoading(true);
        setError(null);
        setNotFound(false);
        try {
          const slice = await expandGraph(
            { nodeIds: seeds, ...filtersFor(stateRef.current), cap: EXPLORER_NODE_CAP },
            controller.signal,
          );
          if (!isMounted() || controller.signal.aborted) return;
          const state = stateRef.current;
          const { capped: wasCapped } = mergeSlice(state, slice, { palette: optionsRef.current.palette });
          for (const id of seeds) state.expanded.add(id);
          setCapped(wasCapped);
          setTruncated(slice.truncated);
          bump();
        } catch (err) {
          if (isAbortError(err) || controller.signal.aborted || !isMounted()) return;
          fail(err, 'Failed to load the graph');
        } finally {
          if (isMounted() && controllerRef.current === controller) setIsLoading(false);
        }
      };
      lastActionRef.current = action;
      await action();
    },
    [bump, fail, filtersFor, isMounted, nextController],
  );

  const expand = useCallback(
    async (nodeId: string) => {
      const state = stateRef.current;
      if (!state.graph.hasNode(nodeId)) return;
      const capacity = remainingCapacity(state);
      if (capacity === 0) {
        setCapped(true);
        return;
      }
      const controller = nextController();
      setExpandingId(nodeId);
      setError(null);
      try {
        const slice = await expandGraph(
          { nodeIds: [nodeId], ...filtersFor(state), cap: capacity },
          controller.signal,
        );
        if (!isMounted() || controller.signal.aborted || stateRef.current !== state) return;
        const { capped: wasCapped } = mergeSlice(state, slice, {
          parentId: nodeId,
          palette: optionsRef.current.palette,
        });
        state.expanded.add(nodeId);
        if (wasCapped) setCapped(true);
        setTruncated(slice.truncated);
        bump();
      } catch (err) {
        if (isAbortError(err) || controller.signal.aborted || !isMounted()) return;
        // A 404 here means one node went away (forgotten, merged) — not that
        // the whole explorer is gone, so it is an error, not the 404 state.
        setError(graphErrorMessage(err, 'Failed to expand this node'));
      } finally {
        if (isMounted() && controllerRef.current === controller) setExpandingId(null);
      }
    },
    [bump, filtersFor, isMounted, nextController],
  );

  const setAsOf = useCallback(
    async (date: string | null) => {
      const current = stateRef.current;
      if ((current.asOf ?? null) === date) return;
      current.asOf = date;
      if (current.seedIds.length === 0) {
        bump();
        return;
      }
      const seeds = [...current.seedIds];
      const from = [...seeds, ...[...current.expanded].filter((id) => !seeds.includes(id))];
      const action = () => rebuild(seeds, current, from, true);
      lastActionRef.current = action;
      await action();
    },
    [bump, rebuild],
  );

  const refilter = useCallback(() => {
    const state = stateRef.current;
    const present = new Set<string>(optionsRef.current.nodeTypes);
    state.graph.forEachNode((_id, attrs) => present.add(attrs.entityType));
    const allowedTypes = new Set([...present].filter((key) => !state.hiddenTypes.has(key)));
    const allowedRelations =
      state.hiddenRelationTypes.size === 0
        ? null
        : new Set(optionsRef.current.relationTypes.filter((key) => !state.hiddenRelationTypes.has(key)));
    applyFilters(state, allowedTypes, allowedRelations);
    bump();
  }, [bump]);

  const setHiddenTypes = useCallback(
    (types: Iterable<string>) => {
      stateRef.current.hiddenTypes = new Set(types);
      refilter();
    },
    [refilter],
  );

  const setHiddenRelationTypes = useCallback(
    (types: Iterable<string>) => {
      stateRef.current.hiddenRelationTypes = new Set(types);
      refilter();
    },
    [refilter],
  );

  const hide = useCallback(
    (nodeId: string) => {
      if (removeNode(stateRef.current, nodeId)) {
        // Room again: the refusal no longer applies.
        if (remainingCapacity(stateRef.current) > 0) setCapped(false);
        bump();
      }
    },
    [bump],
  );

  const makeSeed = useCallback(
    (nodeId: string) => {
      if (makeSeedInModel(stateRef.current, nodeId)) bump();
    },
    [bump],
  );

  const dismissCap = useCallback(() => {
    setCapped(false);
    setTruncated(false);
  }, []);

  const retry = useCallback(async () => {
    await lastActionRef.current?.();
  }, []);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    const next = createExplorerState();
    next.hiddenTypes = new Set(stateRef.current.hiddenTypes);
    next.hiddenRelationTypes = new Set(stateRef.current.hiddenRelationTypes);
    next.asOf = stateRef.current.asOf;
    stateRef.current = next;
    lastActionRef.current = null;
    setIsLoading(false);
    setExpandingId(null);
    setError(null);
    setNotFound(false);
    setCapped(false);
    setTruncated(false);
    bump();
  }, [bump]);

  return {
    state: stateRef.current,
    version,
    isLoading,
    expandingId,
    error,
    notFound,
    capped,
    truncated,
    load,
    loadHandoff,
    expand,
    setAsOf,
    setHiddenTypes,
    setHiddenRelationTypes,
    hide,
    makeSeed,
    dismissCap,
    retry,
    reset,
  };
}

/** The API returns seeds at depth 0; make sure the slice's own seed list names ours. */
function orderSeedsFirst(slice: GraphSlice, seedIds: readonly string[]): GraphSlice {
  const seeds = [...new Set([...seedIds, ...slice.seedIds])];
  return { ...slice, seedIds: seeds };
}
