/**
 * The inspector's URL state (GIC-11, #672): `?sel=n:<nodeId>` or
 * `?sel=e:<edgeId>` for the selection and `?tab=` for the open tab.
 *
 * Why it is in the URL: "Open at source" leaves the explorer for a note or a
 * transcript, and Back must land on the same canvas state — the same seeds,
 * the same selection, the same tab — not an empty canvas. The seeds were
 * already in `?seed=`; this adds the selection.
 *
 * The URL is written with `replace`, so selecting does not fill the history.
 * On load the selection is restored ONCE, when the graph has arrived and
 * contains it; a selection the graph no longer has is dropped from the URL.
 * Picking another node or edge resets the tab to that selection's default.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

import { parseInspectorTab, type InspectorTab } from './inspectorModel.js';

/** The selection handle the explorer page keeps. */
export interface InspectorHandle {
  kind: 'node' | 'edge';
  id: string;
}

/** `n:<id>` or `e:<id>`. */
export function encodeSelection(selected: InspectorHandle | null): string | null {
  return selected ? `${selected.kind === 'node' ? 'n' : 'e'}:${selected.id}` : null;
}

/** The inverse of {@link encodeSelection}; `null` for anything malformed. */
export function decodeSelection(raw: string | null): InspectorHandle | null {
  if (!raw) return null;
  const cut = raw.indexOf(':');
  if (cut < 0) return null;
  const id = raw.slice(cut + 1);
  if (!id) return null;
  const kind = raw.slice(0, cut);
  if (kind === 'n') return { kind: 'node', id };
  if (kind === 'e') return { kind: 'edge', id };
  return null;
}

/**
 * Keeps the explorer's selection and the open tab in the URL, and restores them once the graph is ready.
 *
 * @param input - The selection, its setter, whether the graph has arrived and what it contains.
 * @returns The open tab (`null` for the selection's default) and its setter.
 */
export function useInspectorUrlState(input: {
  selected: InspectorHandle | null;
  setSelected: (next: InspectorHandle | null) => void;
  /** The graph has arrived: restoring can look for the selection in it. */
  ready: boolean;
  hasNode: (id: string) => boolean;
  hasEdge: (id: string) => boolean;
}): { tab: InspectorTab | null; setTab: (tab: InspectorTab) => void } {
  const { selected, setSelected, ready, hasNode, hasEdge } = input;
  const [searchParams, setSearchParams] = useSearchParams();
  const restored = useRef(false);
  const latest = useRef(searchParams);
  latest.current = searchParams;
  const lookup = useRef({ hasNode, hasEdge, setSelected });
  lookup.current = { hasNode, hasEdge, setSelected };

  useEffect(() => {
    if (restored.current || !ready) return;
    restored.current = true;
    const wanted = decodeSelection(latest.current.get('sel'));
    if (!wanted) return;
    const present = wanted.kind === 'node' ? lookup.current.hasNode(wanted.id) : lookup.current.hasEdge(wanted.id);
    if (present) {
      lookup.current.setSelected(wanted);
      return;
    }
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete('sel');
        next.delete('tab');
        return next;
      },
      { replace: true },
    );
  }, [ready, setSearchParams]);

  useEffect(() => {
    // Until the restore has looked, the URL's selection is the truth, not the empty state.
    if (!restored.current) return;
    const encoded = encodeSelection(selected);
    if ((latest.current.get('sel') ?? null) === encoded) return;
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (encoded) next.set('sel', encoded);
        else next.delete('sel');
        next.delete('tab');
        return next;
      },
      { replace: true },
    );
  }, [selected, setSearchParams]);

  const setTab = useCallback(
    (tab: InspectorTab) => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          next.set('tab', tab);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  return { tab: parseInspectorTab(searchParams.get('tab')), setTab };
}
