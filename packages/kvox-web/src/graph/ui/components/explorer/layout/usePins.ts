/**
 * `usePins` (GIC-07, #668; #775): the canvas's pinned nodes. A pinned node is
 * `fixed` in the model, so no layout moves it, and the pins of a view survive a
 * reload of the tab (`pins.ts`, `sessionStorage`).
 */

import type { MultiDirectedGraph, UndirectedGraph } from 'graphology';
import { useCallback, useEffect, useRef, useState } from 'react';

import { loadPins, savePins, type Pin } from './pins.js';

type AnyGraph = MultiDirectedGraph | UndirectedGraph;

/** What the hook gives the canvas. */
export interface PinControls {
  /** The pins in force, by node id. */
  pins: { readonly current: Map<string, Pin> };
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
  /** Writes every pin onto the graph (`x`, `y`, `fixed`) for the nodes it has. */
  applyPins: () => void;
  /** How many nodes are pinned. */
  pinnedCount: number;
}

/**
 * Keeps the pins of a canvas.
 *
 * @param graph - The graph the pins apply to.
 * @param pinsKey - Identifies the view for persistence; absent: pins are not persisted.
 */
export function usePins(graph: AnyGraph, pinsKey: string | undefined): PinControls {
  const [pinnedCount, setPinnedCount] = useState(0);
  const pins = useRef(new Map<string, Pin>());
  const loadedKey = useRef<string | undefined | null>(null);
  if (loadedKey.current !== pinsKey) {
    loadedKey.current = pinsKey;
    pins.current = pinsKey ? loadPins(pinsKey) : new Map();
  }

  useEffect(() => {
    setPinnedCount(pins.current.size);
  }, [pinsKey]);

  const persist = useCallback(() => {
    setPinnedCount(pins.current.size);
    if (pinsKey) savePins(pinsKey, pins.current);
  }, [pinsKey]);

  const applyPins = useCallback(() => {
    for (const [id, pin] of pins.current) {
      if (graph.hasNode(id)) graph.mergeNodeAttributes(id, { x: pin.x, y: pin.y, fixed: true });
    }
  }, [graph]);

  const pin = useCallback(
    (id: string, position: Pin) => {
      pins.current.set(id, position);
      if (graph.hasNode(id)) graph.mergeNodeAttributes(id, { x: position.x, y: position.y, fixed: true });
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

  return { pins, togglePin, pin, unpin, unpinAll, isPinned, applyPins, pinnedCount };
}
