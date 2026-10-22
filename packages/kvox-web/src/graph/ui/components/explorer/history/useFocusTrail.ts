/**
 * The focus trail (GIC-17, #678): the nodes the user has focused, in order, as
 * breadcrumbs and as Back / Forward.
 *
 * FOCUS is a node the user selects. Each NEW focus adds ONE browser history
 * entry (`?focus=<id>`, a router navigation without `replace`) and nothing else does: filter,
 * layout, tab and edge changes all use `replace`, so the browser's Back button
 * walks the focus trail and does not spam. `[` and `]` and the toolbar arrows
 * call the same `navigate(-1)` / `navigate(1)`.
 *
 * The trail is a list with a cursor. A focus that arrives from the URL (the
 * browser's Back or Forward, a reload, a shared link) is matched against the
 * neighbours of the cursor, so the cursor follows the browser; any other id is
 * a new push and cuts the forward part, exactly as the browser does.
 *
 * Pure functions (`pushFocus`, `followFocus`) hold the rules; the hook only
 * binds them to the router.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

/** Most focus steps kept in the trail. */
export const FOCUS_TRAIL_LIMIT = 50;

/**
 * The trail and where the user is on it.
 *
 * @stability experimental
 */
export interface FocusTrail {
  /** Node ids in the order they were focused. */
  ids: string[];
  /** Index of the current focus in `ids`; `-1` when nothing is focused. */
  cursor: number;
}

/** A trail with nothing in it. */
export const EMPTY_TRAIL: FocusTrail = { ids: [], cursor: -1 };

/** A new focus: cuts everything after the cursor, appends `id`, bounds the trail. */
export function pushFocus(trail: FocusTrail, id: string): FocusTrail {
  if (trail.ids[trail.cursor] === id) return trail;
  const ids = [...trail.ids.slice(0, trail.cursor + 1), id];
  while (ids.length > FOCUS_TRAIL_LIMIT) ids.shift();
  return { ids, cursor: ids.length - 1 };
}

/** A focus that arrived from the URL: moves the cursor when `id` is its neighbour, else it is a new push. */
export function followFocus(trail: FocusTrail, id: string): FocusTrail {
  if (trail.ids[trail.cursor] === id) return trail;
  if (trail.cursor > 0 && trail.ids[trail.cursor - 1] === id) return { ...trail, cursor: trail.cursor - 1 };
  if (trail.ids[trail.cursor + 1] === id) return { ...trail, cursor: trail.cursor + 1 };
  return pushFocus(trail, id);
}

/**
 * What {@link useFocusTrail} returns.
 *
 * @stability experimental
 */
export interface UseFocusTrailResult {
  /** The trail up to and including the current focus, oldest first. */
  crumbs: string[];
  /** There is an earlier focus to go back to. */
  canGoBack: boolean;
  /** There is a later focus to go forward to. */
  canGoForward: boolean;
  /** Back one focus. */
  goBack: () => void;
  /** Forward one focus. */
  goForward: () => void;
  /** Jump to the crumb at this index of `crumbs`. */
  goTo: (index: number) => void;
}

/**
 * Keeps the selected node and the `?focus=` parameter in step and exposes the trail. A
 * selection writes the URL through `useInspectorUrlState`; this hook reads it back (Back,
 * Forward, a reload, a shared link) and selects the node.
 *
 * @param input - The selected node's id (or `null`), a way to select a node from the URL, and whether the graph has arrived.
 * @returns The trail and its navigation.
 *
 * @stability experimental
 */
export function useFocusTrail(input: {
  /** The id of the selected node; `null` for none or for an edge. */
  focusedId: string | null;
  /** Selects a node because the URL asked for it. */
  focusNode: (id: string) => void;
  /** The graph has arrived, so a `?focus=` can be looked up. */
  ready: boolean;
  /** Whether the graph holds this node. */
  hasNode: (id: string) => boolean;
}): UseFocusTrailResult {
  const { focusedId, focusNode, ready, hasNode } = input;
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const focusParam = searchParams.get('focus');
  const [trail, setTrail] = useState<FocusTrail>(() => (focusParam ? pushFocus(EMPTY_TRAIL, focusParam) : EMPTY_TRAIL));
  const trailRef = useRef(trail);
  trailRef.current = trail;
  // The focus this hook last saw or applied, so a selection it made is not read back as navigation.
  // It starts empty: a `?focus=` in the URL on load is navigation and must select its node.
  const settled = useRef<string | null>(null);
  const lookup = useRef({ focusNode, hasNode });
  lookup.current = { focusNode, hasNode };

  // Selection -> trail. The URL entry itself is added by `useInspectorUrlState`, in the same
  // call that writes `sel`.
  useEffect(() => {
    if (!focusedId || focusedId === settled.current) return;
    settled.current = focusedId;
    setTrail((current) => pushFocus(current, focusedId));
  }, [focusedId]);

  // URL -> selection: the browser's Back / Forward, a reload or a shared link.
  useEffect(() => {
    if (!focusParam || focusParam === settled.current || !ready) return;
    if (!lookup.current.hasNode(focusParam)) return;
    settled.current = focusParam;
    setTrail((current) => followFocus(current, focusParam));
    lookup.current.focusNode(focusParam);
  }, [focusParam, ready]);

  const cursor = trail.cursor;
  const goBack = useCallback(() => {
    if (trailRef.current.cursor > 0) navigate(-1);
  }, [navigate]);
  const goForward = useCallback(() => {
    const current = trailRef.current;
    if (current.cursor < current.ids.length - 1) navigate(1);
  }, [navigate]);
  const goTo = useCallback(
    (index: number) => {
      const delta = index - trailRef.current.cursor;
      if (delta !== 0 && index >= 0 && index < trailRef.current.ids.length) navigate(delta);
    },
    [navigate],
  );

  return {
    crumbs: trail.ids.slice(0, cursor + 1),
    canGoBack: cursor > 0,
    canGoForward: cursor >= 0 && cursor < trail.ids.length - 1,
    goBack,
    goForward,
    goTo,
  };
}
