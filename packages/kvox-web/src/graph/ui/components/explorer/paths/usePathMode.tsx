/**
 * `usePathMode` — everything "Connect A and B" needs, in one hook, so the
 * explorer page only wires slots (GIC-13, #674; epic #661).
 *
 * WHAT IT OWNS
 *   - the URL: `?pathFrom=&pathTo=` (+ `pathHops`, `pathRel`), so a path is
 *     shareable and a reload restores it;
 *   - the search (`useGraphPaths`) and the quotes (`useHopQuotes`);
 *   - the picker (a full-screen sheet on a phone, a popover elsewhere);
 *   - where the results live, by window class:
 *       compact   a VERTICAL strip inside the bottom sheet (`sheet`);
 *       medium    a HORIZONTAL scroll-snap strip in an overlay on the canvas,
 *                 above the time bar (`overlay`);
 *       expanded  the same overlay, docked at the bottom and collapsible;
 *       list view the panel inline above the list (`inline`).
 *   - "Show on canvas": merges the active path into the graph (never past the
 *     node cap), highlights it with the canvas's path reducers (everything else
 *     dims) and fits the camera to it.
 *
 * ENTRY POINTS it hands the page: `connectButton` (top bar), `pathToAction`
 * (the inspector's NodeActions), `contextMenuItems` (the node menu) and
 * `openPicker(fromId?)`. The command palette and the Start-here card call
 * `openPicker` too (see the graph README); until they exist, `?pathFrom=<id>`
 * opens the picker with A filled in, which is the same entry point as a link.
 */

import AltRouteIcon from '@mui/icons-material/AltRoute';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import { useCallback, useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react';

import { useKvoxHost } from '../../../../../core/headless/index.js';
import { getGraphEntity, type GraphOntology, type GraphSlice } from '../../../../headless/clients/graph.js';
import type { CanvasInsets } from '../shell/InsightCanvasLayout.js';
import type { InputModality } from '../shell/useInputModality.js';
import type { WindowClass } from '../shell/useWindowClass.js';
import type { GraphCanvasControls } from '../GraphCanvas.js';
import type { ExplorerMode } from '../explorerEncoding.js';
import type { ExplorerGraph } from '../explorerModel.js';
import { PathPanel } from './PathPanel.js';
import { PathPickerHost, type PathEndpoint, type PathRelationOption } from './PathPicker.js';
import {
  MAX_PATH_HOPS,
  buildPathViews,
  clearPathRequest,
  pathIds,
  readPathRequest,
  writePathRequest,
  type PathRequest,
  type PathView,
} from './pathModel.js';
import { useGraphPaths } from './useGraphPaths.js';
import { useHopQuotes } from './useHopQuotes.js';

/**
 * What {@link usePathMode} reads from the page.
 *
 * @stability experimental
 */
export interface UsePathModeInput {
  /** The page's URL parameters. */
  params: URLSearchParams;
  /** Writes the URL (replace, not push). */
  updateParams: (mutate: (params: URLSearchParams) => void) => void;
  /** The shell's window class. */
  windowClass: WindowClass;
  /** The shell's input modality. */
  inputModality: InputModality;
  /** Light or dark. */
  mode: ExplorerMode;
  /** The caller's ontology, for relation labels. */
  ontology: GraphOntology | null;
  /** Every relation type, for the picker's chips. */
  relationOptions: readonly PathRelationOption[];
  /** The explorer's `as of` date, so a path is read at the same time as the canvas. */
  asOf: string | null;
  /** The explorer's graph (mutated in place). */
  graph: ExplorerGraph;
  /** Changes whenever the graph does. */
  version: number;
  /** Merges a slice into the graph under the node cap. */
  mergeSlice: (slice: GraphSlice) => { added: string[]; capped: boolean };
  /** The canvas's camera controls. */
  controls: RefObject<GraphCanvasControls | null>;
  /** The page already has seeds (`?seed=`). */
  hasSeed: boolean;
  /** The inspector has something to show (a node, an edge or a multi-selection). */
  hasSelection: boolean;
  /** The list view is showing instead of the canvas. */
  listView: boolean;
  /** Selects an edge in the inspector, on its Evidence tab. */
  openEdge: (edgeId: string) => void;
  /** Says something to a screen reader. */
  announce: (message: string) => void;
}

/**
 * What {@link usePathMode} gives the page.
 *
 * @stability experimental
 */
export interface UsePathModeResult {
  /** A search is on: both ends are in the URL. */
  active: boolean;
  /** Opens the picker, with A filled in when `fromId` is given. The entry point of the palette, the Start-here card and any other surface. */
  openPicker: (fromId?: string) => void;
  /** The top bar's button. */
  connectButton: ReactNode;
  /** The inspector's "Path to…" action for a node. */
  pathToAction: (nodeId: string) => ReactNode;
  /** The node menu's "Path to…" item; `close` closes the menu. */
  contextMenuItems: (target: { id: string; label: string } | null, close: () => void) => ReactNode;
  /** The picker; render it once, anywhere. */
  picker: ReactNode;
  /** The panel as a canvas overlay (medium and expanded, graph view), or `null`. Takes the part of the canvas the inspector covers. */
  overlay: (insets: CanvasInsets) => ReactNode;
  /** The panel above the list (list view), or `null`. */
  inline: ReactNode;
  /** The panel for the bottom sheet (compact, graph view, nothing selected), or `null`. */
  sheet: ReactNode;
  /** The bottom sheet should be open for the path. */
  sheetWanted: boolean;
  /** Called when the sheet is dismissed; closes the path sheet when no selection is what it shows. */
  onSheetDismiss: () => void;
  /** Nodes of the path drawn on the canvas, or an empty set. */
  pathNodeIds: ReadonlySet<string>;
  /** Edges of the path drawn on the canvas, or an empty set. */
  pathEdgeIds: ReadonlySet<string>;
}

const NONE: ReadonlySet<string> = new Set();

/** Label and type of one entity, from the API; `null` until it arrives. */
function useEndpoint(id: string | null, known: PathEndpoint | null): PathEndpoint | null {
  const host = useKvoxHost();
  const [fetched, setFetched] = useState<PathEndpoint | null>(null);
  useEffect(() => {
    if (!id || known?.id === id) return undefined;
    const controller = new AbortController();
    getGraphEntity(host, id, controller.signal)
      .then((detail) => {
        if (!controller.signal.aborted) setFetched({ id, label: detail.label, type: detail.type });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [id, known?.id]);
  if (!id) return null;
  if (known?.id === id) return known;
  return fetched?.id === id ? fetched : null;
}

/**
 * Path mode for the explorer page.
 *
 * @param input - See {@link UsePathModeInput}.
 * @returns See {@link UsePathModeResult}.
 *
 * @stability experimental
 */
export function usePathMode(input: UsePathModeInput): UsePathModeResult {
  const { params, updateParams, windowClass, inputModality, mode, ontology, relationOptions, asOf, graph, version } = input;
  const { mergeSlice, controls, hasSeed, hasSelection, listView, openEdge, announce } = input;
  const touch = inputModality === 'touch';
  const compact = windowClass === 'compact';

  const request: PathRequest = useMemo(() => readPathRequest(params), [params]);
  const active = request.from !== null && request.to !== null && request.from !== request.to;

  // --- The search ---------------------------------------------------------------
  const relationKey = request.relationTypes.join(',');
  const query = useMemo(
    () =>
      active
        ? { from: request.from!, to: request.to!, maxHops: request.maxHops, relationTypes: request.relationTypes, asOf }
        : null,
    [active, request.from, request.to, request.maxHops, relationKey, asOf],
  );
  const search = useGraphPaths(query);
  const paths: PathView[] = useMemo(
    () => (search.data ? buildPathViews(search.data, ontology) : []),
    [search.data, ontology],
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const [shown, setShown] = useState(false);
  const [capNotice, setCapNotice] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const current = paths[Math.min(activeIndex, Math.max(paths.length - 1, 0))] ?? null;
  const quotes = useHopQuotes(current?.hops ?? []);

  // A new pair, or new filters: back to the best path, undrawn, sheet open.
  const requestKey = query ? `${query.from}|${query.to}|${query.maxHops}|${relationKey}|${asOf ?? ''}` : '';
  useEffect(() => {
    setActiveIndex(0);
    setShown(false);
    setCapNotice(null);
    setSheetOpen(true);
  }, [requestKey]);

  // The explorer needs seeds to draw anything; a link with only a path opens on its first end.
  useEffect(() => {
    if (hasSeed || !request.from) return;
    updateParams((next) => {
      if (!next.get('seed')) next.set('seed', [request.from, request.to].filter(Boolean).join(','));
    });
  }, [hasSeed, request.from, request.to, updateParams]);

  // Say what came back.
  useEffect(() => {
    if (search.status !== 'ready') return;
    announce(
      paths.length === 0
        ? `No connection within ${request.maxHops} hops`
        : `${paths.length} ${paths.length === 1 ? 'connection' : 'connections'} found`,
    );
  }, [search.status, search.data]);

  // --- The picker ---------------------------------------------------------------
  const [pickerOpen, setPickerOpen] = useState(() => request.from !== null && request.to === null);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [known, setKnown] = useState<{ from: PathEndpoint | null; to: PathEndpoint | null }>({ from: null, to: null });
  const fromEndpoint = useEndpoint(request.from, known.from);
  const toEndpoint = useEndpoint(request.to, known.to);

  const openPicker = useCallback(
    (fromId?: string) => {
      if (fromId) updateParams((next) => writePathRequest(next, { from: fromId, to: null }));
      setPickerOpen(true);
    },
    [updateParams],
  );

  // --- Show on canvas -------------------------------------------------------------
  const mergePath = useCallback(
    (path: PathView) => {
      if (!search.data) return { missing: 0 };
      const ids = pathIds(path);
      const { slice } = search.data;
      // Only the chosen path's part of the slice: the cap is for what the user is looking at.
      mergeSlice({
        ...slice,
        nodes: slice.nodes.filter((node) => ids.nodeIds.has(node.id)),
        edges: slice.edges.filter((edge) => ids.edgeIds.has(edge.id)),
      });
      const missing = [...ids.nodeIds].filter((id) => !graph.hasNode(id)).length;
      return { missing };
    },
    [search.data, mergeSlice, graph],
  );

  const showPath = useCallback(
    (path: PathView) => {
      const { missing } = mergePath(path);
      setCapNotice(
        missing > 0
          ? `${missing} ${missing === 1 ? 'node' : 'nodes'} of this path did not fit under the node limit. Hide some nodes, then show it again.`
          : null,
      );
      setShown(true);
      const ids = path.nodes.map((node) => node.id);
      // The merge lands in the next render; fit once the canvas has the nodes.
      requestAnimationFrame(() => controls.current?.fitTo?.(ids));
      announce(`Showing path ${path.index + 1} on the canvas`);
    },
    [mergePath, controls, announce],
  );

  const onShowOnCanvas = useCallback(() => {
    if (!current) return;
    showPath(current);
    // A phone: the sheet gives way to the drawing.
    if (compact) setSheetOpen(false);
  }, [current, showPath, compact]);

  const onActiveChange = useCallback(
    (index: number) => {
      setActiveIndex(index);
      if (shown && paths[index]) showPath(paths[index]);
    },
    [shown, paths, showPath],
  );

  const onOpenEdge = useCallback(
    (edgeId: string) => {
      if (current && !graph.hasEdge(edgeId)) mergePath(current);
      openEdge(edgeId);
    },
    [current, graph, mergePath, openEdge],
  );

  // --- The URL ----------------------------------------------------------------------
  const close = useCallback(() => {
    updateParams(clearPathRequest);
    setShown(false);
    setCapNotice(null);
  }, [updateParams]);

  const onSubmit = useCallback(
    (next: Pick<PathRequest, 'from' | 'to' | 'maxHops' | 'relationTypes'>, endpoints: { from: PathEndpoint; to: PathEndpoint }) => {
      setKnown(endpoints);
      updateParams((p) => writePathRequest(p, next));
      setPickerOpen(false);
    },
    [updateParams],
  );

  // --- What is drawn where ---------------------------------------------------------------
  const highlighted = useMemo(() => {
    if (!shown || !current) return { nodes: NONE, edges: NONE };
    const ids = pathIds(current);
    return {
      nodes: new Set([...ids.nodeIds].filter((id) => graph.hasNode(id))),
      edges: new Set([...ids.edgeIds].filter((id) => graph.hasEdge(id))),
    };
    // The graph is mutated in place: `version` is what changes.
  }, [shown, current, graph, version]);

  const title =
    fromEndpoint && toEndpoint
      ? `${fromEndpoint.label} ↔ ${toEndpoint.label}`
      : search.data
        ? `${search.data.slice.nodes.find((n) => n.id === request.from)?.label ?? 'A'} ↔ ${search.data.slice.nodes.find((n) => n.id === request.to)?.label ?? 'B'}`
        : 'Connection';

  const renderPanel = (orientation: 'horizontal' | 'vertical', collapse?: { collapsed: boolean; onToggle: () => void }) => (
    <PathPanel
      title={title}
      status={search.status}
      failure={search.failure}
      paths={paths}
      truncated={search.data?.truncated ?? false}
      maxHops={request.maxHops}
      hasRelationFilter={request.relationTypes.length > 0}
      strip={{ activeIndex, onActiveChange, orientation, quotes, mode, touch, onOpenEdge }}
      shown={shown}
      capNotice={capNotice}
      touch={touch}
      onShowOnCanvas={onShowOnCanvas}
      onChange={() => setPickerOpen(true)}
      onClose={close}
      onRaiseHops={() => updateParams((p) => writePathRequest(p, { maxHops: Math.min(request.maxHops + 1, MAX_PATH_HOPS) }))}
      onClearRelations={() => updateParams((p) => writePathRequest(p, { relationTypes: [] }))}
      onRetry={search.retry}
      collapse={collapse}
    />
  );

  const showSheet = active && compact && !listView && sheetOpen && !hasSelection;
  const showOverlay = active && !compact && !listView;
  const showInline = active && listView;
  const expanded = windowClass === 'expanded';

  const overlay = (insets: CanvasInsets): ReactNode =>
    showOverlay ? (
      <PathOverlay insets={insets}>
        {renderPanel('horizontal', expanded ? { collapsed, onToggle: () => setCollapsed((on) => !on) } : undefined)}
      </PathOverlay>
    ) : null;

  const onConnectClick = () => {
    if (active && compact && !sheetOpen) setSheetOpen(true);
    else openPicker();
  };
  const connectLabel = active ? 'Connection' : 'Connect';
  const connectButton: ReactNode = compact ? (
    <IconButton
      ref={setAnchorEl}
      aria-label={active ? 'Show the connection' : 'Connect two things'}
      onClick={onConnectClick}
      color={active ? 'primary' : 'default'}
      sx={{ width: 44, height: 44 }}
    >
      <AltRouteIcon />
    </IconButton>
  ) : (
    <Button
      ref={setAnchorEl}
      size="small"
      startIcon={<AltRouteIcon />}
      onClick={onConnectClick}
      aria-label={active ? 'Change the connection' : 'Connect two things'}
      variant={active ? 'contained' : 'text'}
      sx={{ whiteSpace: 'nowrap' }}
    >
      {connectLabel}
    </Button>
  );

  const picker = (
    <PathPickerHost
      open={pickerOpen}
      fullScreen={compact}
      anchorEl={anchorEl}
      onClose={() => setPickerOpen(false)}
      from={fromEndpoint}
      to={toEndpoint}
      maxHops={request.maxHops}
      relationTypes={request.relationTypes}
      relationOptions={relationOptions}
      touch={touch}
      onSubmit={onSubmit}
    />
  );

  const isStub = (id: string) => graph.hasNode(id) && graph.getNodeAttribute(id, 'isStub') === true;

  return {
    active,
    openPicker,
    connectButton,
    pathToAction: (nodeId) =>
      isStub(nodeId) ? null : (
        <Button
          size="small"
          variant="outlined"
          startIcon={<AltRouteIcon />}
          onClick={() => openPicker(nodeId)}
          sx={{ minHeight: touch ? 44 : undefined, textTransform: 'none' }}
        >
          Path to…
        </Button>
      ),
    contextMenuItems: (target, closeMenu) =>
      target && !isStub(target.id) ? (
        <MenuItem
          key="path-to"
          onClick={() => {
            closeMenu();
            openPicker(target.id);
          }}
        >
          Path to…
        </MenuItem>
      ) : null,
    picker,
    overlay,
    inline: showInline ? renderPanel('horizontal') : null,
    sheet: showSheet ? renderPanel('vertical') : null,
    sheetWanted: active && compact && !listView && sheetOpen,
    onSheetDismiss: () => {
      if (!hasSelection) setSheetOpen(false);
    },
    pathNodeIds: highlighted.nodes,
    pathEdgeIds: highlighted.edges,
  };
}

/** The canvas overlay of medium and expanded windows: docked at the bottom, clear of the inspector overlay. */
function PathOverlay({ insets, children }: { insets: CanvasInsets; children: ReactNode }) {
  return (
    <Paper
      elevation={4}
      data-testid="path-overlay"
      sx={{
        position: 'absolute',
        left: 8 + insets.left,
        right: 8 + insets.right,
        bottom: 8 + insets.bottom,
        maxHeight: '55%',
        overflowY: 'auto',
        zIndex: 5,
        p: 1.5,
        borderRadius: 2,
      }}
    >
      {children}
    </Paper>
  );
}
