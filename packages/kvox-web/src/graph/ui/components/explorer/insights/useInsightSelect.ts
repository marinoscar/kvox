/**
 * `useInsightSelect` — what the explorer does when an Insights item is tapped
 * (GIC-16, #677; epic #661), kept out of `GraphExplorerPage` so the page only
 * wires it.
 *
 * A tap starts the canvas from the item's seeds (through the page's own
 * `setSeeds`, i.e. the `?seed=` URL parameter), rings the entities it marked,
 * and selects and flies to the focus entity as soon as it is drawn: at once when
 * the canvas already shows every seed, after the load otherwise.
 */

import { useCallback, useEffect, useState } from 'react';

import type { InsightSeeds } from './insightsModel.js';

/**
 * What {@link useInsightSelect} needs from the page.
 *
 * @stability experimental
 */
export interface UseInsightSelectOptions {
  /** Whether a node is on the canvas right now. */
  hasNode: (id: string) => boolean;
  /** Replaces the canvas's seeds. */
  setSeeds: (ids: string[]) => void;
  /** Rings exactly these entities. */
  setMarked: (ids: Set<string>) => void;
  /** Selects the node and flies the camera to it. */
  focusNode: (id: string) => void;
  /** Says something in the page's live region. */
  announce: (text: string) => void;
}

/**
 * Returns the handler for {@link InsightsPanel}'s `onSelect`.
 *
 * @stability experimental
 */
export function useInsightSelect(options: UseInsightSelectOptions): (seeds: InsightSeeds, announce: string) => void {
  const { hasNode, setSeeds, setMarked, focusNode, announce } = options;
  const [pending, setPending] = useState<string | null>(null);
  const present = pending !== null && hasNode(pending);

  // The page re-renders as the canvas fills, so `present` flips when the focus entity is drawn.
  useEffect(() => {
    if (pending !== null && present) {
      focusNode(pending);
      setPending(null);
    }
    // `focusNode` is read, not reacted to.
  }, [pending, present]);

  return useCallback(
    (seeds: InsightSeeds, text: string) => {
      setMarked(new Set(seeds.markIds));
      if (seeds.seedIds.every((id) => hasNode(id))) {
        announce(text);
        if (seeds.focusId) focusNode(seeds.focusId);
        return;
      }
      setPending(seeds.focusId);
      setSeeds(seeds.seedIds);
    },
    [hasNode, setSeeds, setMarked, focusNode, announce],
  );
}
