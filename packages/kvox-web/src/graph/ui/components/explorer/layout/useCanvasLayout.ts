/**
 * `useCanvasLayout` (GIC-07, #668): the layout effect of `GraphCanvas`, as a hook
 * with no sigma in it.
 *
 * Each `version` bump decides what to lay out: with `force`, ONLY the nodes that
 * were never laid out (new ones, seeded on a ring around their parent) move and
 * everything else is fixed; "Re-layout all", or a change of layout, moves every
 * unpinned node. `concentric` recomputes the rings. `static` moves nothing. The
 * run happens in the same-origin worker (`layoutClient.ts`) and its frames are
 * tweened onto the graph, or jump under `prefers-reduced-motion`.
 */

import type { MultiDirectedGraph, UndirectedGraph } from 'graphology';
import { useCallback, useEffect, useRef, useState } from 'react';

import { concentricPositions } from './concentric.js';
import { applyLayoutPositions, buildLayoutRequest, planLayout } from './incremental.js';
import { startLayout, type LayoutHandle, type StartLayoutOptions } from './layoutClient.js';
import { loadPins, savePins, type Pin } from './pins.js';
import { createPositionTweener, type PositionTweener } from './tween.js';

type AnyGraph = MultiDirectedGraph | UndirectedGraph;

/**
 * The layouts the canvas offers.
 *
 * @stability experimental
 */
export type CanvasLayout = 'forceatlas' | 'concentric' | 'static';

/** Inputs of the hook. */
export interface UseCanvasLayoutOptions {
  graph: AnyGraph;
  /** Increments on every mutation of `graph`. */
  version: number;
  layout: CanvasLayout;
  /** The seeds, for the concentric layout. */
  seedIds?: readonly string[];
  /** Time box of a run in milliseconds. */
  budgetMs: number;
  /** `prefers-reduced-motion`: no tween, no intermediate frames. */
  reducedMotion: boolean;
  /** Identifies the view for pin persistence; absent means pins are not persisted. */
  pinsKey?: string;
  /** Test seam for the worker. */
  startOptions?: StartLayoutOptions;
}

/** What the hook gives the canvas. */
export interface CanvasLayoutControls {
  /** Moves every unpinned node again ("Re-layout all"). */
  relayoutAll: () => void;
  /** Pins a node where it is, or unpins it when it is pinned. */
  togglePin: (id: string) => void;
  /** Pins a node at a position (a drag ended). */
  pin: (id: string, position: Pin) => void;
  /** Releases one pin. */
  unpin: (id: string) => void;
  /** Releases every pin. */
  unpinAll: () => void;
  /** Whether a node is pinned. */
  isPinned: (id: string) => boolean;
  /** How many nodes are pinned. */
  pinnedCount: number;
}

/**
 * Runs the layout of an explorer or overview canvas.
 *
 * @param options - The graph, the layout and the motion preference.
 * @returns Re-layout and pin controls.
 */
export function useCanvasLayout(options: UseCanvasLayoutOptions): CanvasLayoutControls {
  const { graph, version, layout, seedIds, budgetMs, reducedMotion, pinsKey } = options;

  const [pinnedCount, setPinnedCount] = useState(0);
  const [relayoutToken, setRelayoutToken] = useState(0);
  const pins = useRef(new Map<string, Pin>());
  const laidOut = useRef<{ graph: AnyGraph; ids: Set<string> } | null>(null);
  const unsettled = useRef(new Set<string>());
  const lastLayout = useRef<CanvasLayout | null>(null);
  const lastToken = useRef(0);
  const handle = useRef<LayoutHandle | null>(null);
  const tweener = useRef<PositionTweener | null>(null);
  const latest = useRef({ seedIds, budgetMs, reducedMotion, startOptions: options.startOptions });
  latest.current = { seedIds, budgetMs, reducedMotion, startOptions: options.startOptions };

  // Pins of this view: read once per key, applied to nodes as they appear.
  const loadedKey = useRef<string | undefined>(undefined);
  if (loadedKey.current !== pinsKey) {
    loadedKey.current = pinsKey;
    pins.current = pinsKey ? loadPins(pinsKey) : new Map();
  }

  const persist = useCallback(() => {
    setPinnedCount(pins.current.size);
    if (pinsKey) savePins(pinsKey, pins.current);
  }, [pinsKey]);

  const stopRun = useCallback(() => {
    handle.current?.cancel();
    handle.current = null;
    tweener.current?.cancel();
    tweener.current = null;
  }, []);

  useEffect(() => {
    setPinnedCount(pins.current.size);
  }, [pinsKey]);

  useEffect(() => {
    // A new graph object starts a new history.
    if (!laidOut.current || laidOut.current.graph !== graph) {
      stopRun();
      laidOut.current = { graph, ids: new Set() };
      unsettled.current = new Set();
      lastLayout.current = null;
    }
    const known = laidOut.current.ids;

    // Pins override positions and fix their nodes.
    for (const [id, pin] of pins.current) {
      if (graph.hasNode(id)) graph.mergeNodeAttributes(id, { x: pin.x, y: pin.y, fixed: true });
    }

    const layoutChanged = lastLayout.current !== null && lastLayout.current !== layout;
    const relayout = lastToken.current !== relayoutToken;
    lastLayout.current = layout;
    lastToken.current = relayoutToken;

    if (layout === 'static') {
      stopRun();
      graph.forEachNode((id) => known.add(id));
      return undefined;
    }

    const all = relayout || layoutChanged;
    const hasNew = graph.someNode((id) => !known.has(id));
    if (!all && !hasNew) return undefined;

    const { seedIds: seeds, budgetMs: budget, reducedMotion: reduced, startOptions } = latest.current;
    const carry = new Set(unsettled.current);
    stopRun();
    const plan = planLayout(graph, known, { all, carry });
    graph.forEachNode((id) => known.add(id));
    if (plan.movable.size === 0) return undefined;

    const tween = createPositionTweener(graph, { reducedMotion: reduced });
    tweener.current = tween;

    if (layout === 'concentric') {
      const targets = concentricPositions(graph, seeds ?? []);
      for (const id of [...targets.keys()]) if (!plan.movable.has(id)) targets.delete(id);
      // Concentric is a whole-picture layout: with no run to wait for, nothing is unsettled.
      unsettled.current = new Set();
      tween.retarget(targets);
      return undefined;
    }

    if (graph.order < 2) return undefined;
    const request = buildLayoutRequest(graph, plan, budget);
    unsettled.current = new Set(plan.movable);
    const toMap = (positions: Float32Array) => {
      const targets = new Map<string, { x: number; y: number }>();
      request.nodes.forEach((node, index) => {
        if (!node.fixed) targets.set(node.id, { x: positions[index * 2]!, y: positions[index * 2 + 1]! });
      });
      return targets;
    };
    handle.current = startLayout(
      request,
      {
        // Under reduced motion only the final picture is shown, in one jump.
        onFrame: (positions) => {
          if (!reduced) tween.retarget(toMap(positions));
        },
        onDone: (result) => {
          tween.cancel();
          if (reduced) {
            applyLayoutPositions(graph, request, result.positions);
          } else {
            tween.retarget(toMap(result.positions));
          }
          unsettled.current = new Set();
          handle.current = null;
        },
      },
      startOptions,
    );
    return undefined;
    // `pins`, `laidOut` and the rest are refs; the dependencies are the inputs.
  }, [graph, version, layout, relayoutToken, stopRun]);

  // On unmount stop everything and forget the history, so a StrictMode remount
  // lays the graph out again rather than finding it "already done".
  useEffect(
    () => () => {
      stopRun();
      laidOut.current = null;
    },
    [stopRun],
  );

  const relayoutAll = useCallback(() => setRelayoutToken((n) => n + 1), []);

  const pin = useCallback(
    (id: string, position: Pin) => {
      pins.current.set(id, position);
      if (graph.hasNode(id)) graph.mergeNodeAttributes(id, { fixed: true });
      persist();
    },
    [graph, persist],
  );

  const unpin = useCallback(
    (id: string) => {
      if (!pins.current.delete(id)) return;
      if (graph.hasNode(id)) graph.mergeNodeAttributes(id, { fixed: false });
      persist();
    },
    [graph, persist],
  );

  const unpinAll = useCallback(() => {
    for (const id of pins.current.keys()) {
      if (graph.hasNode(id)) graph.mergeNodeAttributes(id, { fixed: false });
    }
    pins.current = new Map();
    persist();
  }, [graph, persist]);

  const togglePin = useCallback(
    (id: string) => {
      if (!graph.hasNode(id)) return;
      if (pins.current.has(id)) {
        unpin(id);
        return;
      }
      const attrs = graph.getNodeAttributes(id);
      pin(id, { x: attrs.x as number, y: attrs.y as number });
    },
    [graph, pin, unpin],
  );

  const isPinned = useCallback((id: string) => pins.current.has(id), []);

  return { relayoutAll, togglePin, pin, unpin, unpinAll, isPinned, pinnedCount };
}
