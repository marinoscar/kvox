/**
 * The inspector's URL state (GIC-11, #672): `?sel=n:<nodeId>` or
 * `?sel=e:<edgeId>` for the selection and `?tab=` for the open tab.
 *
 * Why it is in the URL: "Open at source" leaves the explorer for a note or a
 * transcript, and Back must land on the same canvas state — the same seeds,
 * the same selection, the same tab — not an empty canvas. The seeds were
 * already in `?seed=`; this adds the selection.
 *
 * The URL is written with `replace`, so selecting does not fill the history. The ONE exception
 * is a NEW node focus (GIC-17, #678): selecting a node that `?focus=` does not already name
 * adds a history entry carrying `focus=<id>`, so the browser's Back walks the focus trail
 * (`useFocusTrail`). It is written here, in the same call as `sel`, because two
 * `setSearchParams` in one tick would each start from the same stale params and one would
 * erase the other.
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
  // `setSearchParams` changes identity with every URL change. The writer below must run when the
  // SELECTION changes and never because the URL did: otherwise a Back (URL first, selection a render
  // later) would be read as a new focus and written over.
  const setSearchParamsRef = useRef(setSearchParams);
  setSearchParamsRef.current = setSearchParams;

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
    const focusId = selected?.kind === 'node' ? selected.id : null;
    const newFocus = focusId !== null && (latest.current.get('focus') ?? null) !== focusId;
    if (!newFocus && (latest.current.get('sel') ?? null) === encoded) return;
    setSearchParamsRef.current(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (encoded) next.set('sel', encoded);
        else next.delete('sel');
        next.delete('tab');
        if (newFocus && focusId) next.set('focus', focusId);
        return next;
      },
      { replace: !newFocus },
    );
  }, [selected]);

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
