/**
 * The user's current text selection inside one container, resolved into
 * graph evidence (#368, epic #346; ontology.md §5.3, §19 "Add to graph").
 *
 * Listens to `selectionchange` (debounced 150 ms, so dragging a handle does
 * not re-resolve on every character) and resolves at once on `pointerup` /
 * `keyup`, which is when a selection is finished. A selection counts only
 * when it is non-collapsed and lies inside the container; `resolve` then
 * decides whether it can be evidence:
 *
 *   - a `GraphSelection` → `selection` (the "Add to graph" button is live);
 *   - a refusal (`{ refused, rect }`) → `refusal` (the button is drawn
 *     disabled with the reason — a user who selected across two paragraphs
 *     should learn why, not wonder where the button went);
 *   - `null` → nothing at all.
 *
 * Cleared by Escape, by scrolling the selection out of view, by a route
 * change, and whenever `enabled` goes false (the note entering edit mode).
 *
 * Callers must FREEZE the selection when acting on it: opening a dialog
 * moves focus and collapses the live selection, which clears this hook.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { useLocation } from 'react-router-dom';

import { rangeRect } from '../utils/graphSpans';

export const SELECTION_DEBOUNCE_MS = 150;

export interface GraphSelection {
  quote: string;
  source:
    | { kind: 'note'; noteId: string; noteVersion: number; charStart: number; charEnd: number }
    | {
        kind: 'segment';
        transcriptId: string;
        segmentId: string;
        segmentRev: number;
        charStart: number;
        charEnd: number;
      };
  /** For anchoring the floating button. */
  rect: DOMRect;
}

export interface SelectionRefusal {
  refused: string;
  rect: DOMRect;
}

export type SelectionResolution = GraphSelection | SelectionRefusal | null;

export function isRefusal(value: SelectionResolution): value is SelectionRefusal {
  return value !== null && 'refused' in value;
}

export interface UseTextSelectionReturn {
  selection: GraphSelection | null;
  refusal: SelectionRefusal | null;
  /** Forget the current selection (and collapse the document's). */
  clear: () => void;
}

export function useTextSelection(
  containerRef: RefObject<HTMLElement | null>,
  resolve: (range: Range, container: HTMLElement) => SelectionResolution,
  options: { enabled?: boolean } = {},
): UseTextSelectionReturn {
  const enabled = options.enabled ?? true;
  const [state, setState] = useState<SelectionResolution>(null);
  const resolveRef = useRef(resolve);
  resolveRef.current = resolve;
  const { pathname } = useLocation();

  const compute = useCallback(() => {
    const container = containerRef.current;
    const selection = typeof window !== 'undefined' ? window.getSelection() : null;
    if (!container || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
      setState(null);
      return;
    }
    const range = selection.getRangeAt(0);
    if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) {
      setState(null);
      return;
    }
    if (range.toString().trim() === '') {
      setState(null);
      return;
    }
    setState(resolveRef.current(range, container));
  }, [containerRef]);

  const clear = useCallback(() => {
    setState(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  useEffect(() => {
    if (!enabled) {
      setState(null);
      return;
    }
    let timer: number | undefined;
    const debounced = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(compute, SELECTION_DEBOUNCE_MS);
    };
    const immediate = () => {
      window.clearTimeout(timer);
      compute();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        window.clearTimeout(timer);
        setState((current) => {
          if (current) window.getSelection()?.removeAllRanges();
          return null;
        });
      }
    };
    const onScroll = () => {
      setState((current) => {
        if (!current) return current;
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
        const rect = rangeRect(selection.getRangeAt(0));
        if (rect.bottom < 0 || rect.top > window.innerHeight) return null;
        return { ...current, rect };
      });
    };
    document.addEventListener('selectionchange', debounced);
    document.addEventListener('pointerup', immediate);
    document.addEventListener('keyup', immediate);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('selectionchange', debounced);
      document.removeEventListener('pointerup', immediate);
      document.removeEventListener('keyup', immediate);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [compute, enabled]);

  // A route change leaves nothing selected worth offering.
  useEffect(() => {
    setState(null);
  }, [pathname]);

  return {
    selection: state && !isRefusal(state) ? state : null,
    refusal: isRefusal(state) ? state : null,
    clear,
  };
}
