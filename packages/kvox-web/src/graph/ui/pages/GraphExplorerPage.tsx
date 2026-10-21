/**
 * `/graph/explore` — the bounded, interactive graph explorer (#374, epic #347;
 * spec §22.2). Owned by `knowledge` (#438, `config/destinations.ts`), gated on
 * `graph:read`, lazy.
 *
 * WHERE IT STARTS, in order:
 *   1. a hand-off from the whole-graph overview (`?cluster=` + an in-memory
 *      `explorerHandoff`, #375): the cluster's nodes render at once at their
 *      overview positions, then one expand adds their edges and neighbours;
 *   2. `?seed=<id>[,<id>…]` (≤ 10) — the entity page, a search result, a chip;
 *   3. a bare visit: the caller's most recently viewed entities (§22.2), put
 *      into `?seed=` so the view is shareable;
 *   4. nothing viewed yet: a centred seed search.
 *   A reload with `?cluster=` has no hand-off (it is in memory only), so it
 *   falls through to the search with a hint to reopen it from the overview.
 *
 * URL STATE: `seed`, `asOf` (YYYY-MM-DD), `types` (the SHOWN node types —
 * absent means all), `view=list`, `layout=static` (tests/visual only), and
 * `cluster`. The URL is the source of truth for all of them; a control writes
 * the URL and an effect applies it.
 *
 * LAYOUT (GIC-08, #669; epic #661): everything but the early states (not found,
 * error, seed search) renders through `InsightCanvasLayout` — the responsive
 * Insight Canvas shell. The filters are its `facets` slot, the title and view
 * controls its `topBar`, the drawing its `canvas`, and `ExplorerSidePanel` its
 * `inspector` (GIC-11 replaces it). The page reads the window class, the input
 * modality and the budgets from the shell's hooks and owns none of the layout.
 * `view=graph` is written when the user asks for the graph where the list was
 * the default (a phone with more than 120 nodes).
 *
 * TOUCH: the first tap on a node previews it (its neighbours light up), the
 * second tap on the same node opens the inspector; a long-press (touch) or a
 * right-click (pointer) opens the node's menu; "Select" mode marks nodes by
 * tapping. A pointer keeps hover = preview and click = open.
 *
 * The canvas (sigma, WebGL) is lazy-loaded a second time inside this lazy
 * page, so the list view — and a browser without WebGL — never downloads it.
 * Every rule about the graph itself lives in `explorerModel.ts`.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import { visuallyHidden } from '../visuallyHidden.js';
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Link as RouterLink, useNavigate, useSearchParams } from 'react-router-dom';

import { CapWarning } from '../components/explorer/CapWarning.js';
import {
  ExplorerContextMenu,
  type ExplorerContextTarget,
} from '../components/explorer/ExplorerContextMenu.js';
import {
  ExplorerFilters,
  ExplorerFiltersSkeleton,
  activeFilterCount,
} from '../components/explorer/ExplorerFilters.js';
import { InsightCanvasLayout } from '../components/explorer/shell/InsightCanvasLayout.js';
import { explorerBudgets } from '../components/explorer/shell/explorerBudgets.js';
import { useInputModality } from '../components/explorer/shell/useInputModality.js';
import { useReducedMotion } from '../components/explorer/shell/useReducedMotion.js';
import { useWindowClass } from '../components/explorer/shell/useWindowClass.js';
import {
  ExplorerSidePanel,
  type ExplorerSelection,
} from '../components/explorer/ExplorerSidePanel.js';
import { GraphLegend } from '../components/explorer/GraphLegend.js';
import { ExplorerListView } from '../components/explorer/ExplorerListView.js';
import { ExplorerToolbar, ExplorerToolbarSkeleton } from '../components/explorer/ExplorerToolbar.js';
import type { GraphCanvasControls, NodeContextMenuEvent } from '../components/explorer/GraphCanvas.js';
import { SeedSearch } from '../components/explorer/SeedSearch.js';
import { peekExplorerHandoff, takeExplorerHandoff } from '../../headless/utils/explorerHandoff.js';
import {
  domainOptions,
  hiddenFromShown,
  nodeTypeLabel,
  nodeTypeOptions,
  parseAsOfParam,
  relationTypeOptions,
  shownParamFromHidden,
  type DomainOption,
} from '../../headless/utils/explorerFilters.js';
import {
  keyboardOrder,
  legendModel,
  realNodeCount,
  remainingCapacity,
  toListModel,
  visibleNodeIds,
} from '../components/explorer/explorerModel.js';
import { canvasLoaders } from '../components/explorer/canvasLoaders.js';
import { isWebGLAvailable } from '../components/explorer/webgl.js';
import { GRAPH_NOT_FOUND_MESSAGE } from '../../headless/hooks/graphHookUtils.js';
import { useGraphEffectiveOntology } from '../../headless/hooks/useGraphAttributeDefs.js';
import { useGraphExplorer } from '../hooks/useGraphExplorer.js';
import { getGraphEntity, listGraphEntities } from '../../headless/clients/graph.js';
import { relationPropsDisplay, relationTypeLabel } from '../../headless/utils/graphDisplay.js';

import { useKvoxHost } from '../../../core/headless/index.js';
const GraphCanvas = lazy(() => canvasLoaders.graphCanvas());

/** The most seed ids `?seed=` may carry. */
export const MAX_URL_SEEDS = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const NOT_IN_GRAPH_TITLE = "That entity isn't in your graph";
export const CLUSTER_HINT =
  'This view was opened from the graph overview. Open the cluster again from the overview, or start from someone below.';
export const NO_WEBGL_TEXT =
  "Your browser can't draw the graph (WebGL is unavailable), so it is shown as a list.";

export function parseSeeds(param: string | null): string[] {
  if (!param) return [];
  const ids = param
    .split(',')
    .map((id) => id.trim())
    .filter((id) => UUID.test(id));
  return [...new Set(ids)].slice(0, MAX_URL_SEEDS);
}

function fiveYearsAgo(): string {
  const now = new Date();
  return `${now.getUTCFullYear() - 5}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/**
 * The `/graph/explore` page: a bounded, interactive exploration of the graph with filters, an `as of` date, a canvas view and a list view, whose state lives in the URL.
 *
 * @stability experimental
 */
export function GraphExplorerPage() {
  const host = useKvoxHost();
  const theme = useTheme();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // --- URL state --------------------------------------------------------------
  const seedParam = searchParams.get('seed');
  const seeds = useMemo(() => parseSeeds(seedParam), [seedParam]);
  const seedKey = seeds.join(',');
  const asOf = parseAsOfParam(searchParams.get('asOf'));
  const typesParam = searchParams.get('types');
  const clusterParam = searchParams.get('cluster');
  const viewParam = searchParams.get('view');
  const webgl = useMemo(() => isWebGLAvailable(), []);
  const reducedMotion = useReducedMotion();
  const layout = searchParams.get('layout') === 'static' || reducedMotion ? 'static' : 'forceatlas';
  // The shell's window class and input modality, and the budgets they imply (GIC-08).
  const windowClass = useWindowClass();
  const inputModality = useInputModality();
  const budgets = useMemo(() => explorerBudgets({ windowClass, inputModality }), [windowClass, inputModality]);

  const updateParams = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          mutate(next);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // --- Ontology-derived filter options ------------------------------------------
  const { ontology, isLoading: ontologyLoading } = useGraphEffectiveOntology();
  const nodeTypes = useMemo(() => nodeTypeOptions(ontology), [ontology]);
  const relationTypes = useMemo(() => relationTypeOptions(ontology), [ontology]);
  const domains = useMemo(() => domainOptions(ontology), [ontology]);
  const nodeTypeKeys = useMemo(() => nodeTypes.map((t) => t.key), [nodeTypes]);
  const relationKeys = useMemo(() => relationTypes.map((r) => r.key), [relationTypes]);
  const hiddenTypes = useMemo(() => hiddenFromShown(typesParam, nodeTypeKeys), [typesParam, nodeTypeKeys]);
  const hiddenTypesKey = [...hiddenTypes].sort().join(',');
  const [hiddenRelations, setHiddenRelations] = useState<Set<string>>(() => new Set());

  const typeLabel = useCallback((key: string) => nodeTypeLabel(key, ontology), [ontology]);

  // --- The explorer ------------------------------------------------------------
  const explorer = useGraphExplorer({
    nodeTypes: nodeTypeKeys,
    relationTypes: relationKeys,
    palette: theme,
    nodeCap: budgets.visibleNodeCap,
  });
  const {
    state,
    version,
    load,
    loadHandoff,
    setAsOf,
    setHiddenTypes,
    setHiddenRelationTypes,
    expand,
    hide,
    makeSeed,
  } = explorer;

  // Applied BEFORE the seeding effect below (effects run in order), so the
  // first request already carries the URL's date and filters.
  useEffect(() => {
    void setAsOf(asOf);
  }, [asOf, setAsOf]);

  useEffect(() => {
    setHiddenTypes(hiddenTypesKey ? hiddenTypesKey.split(',') : []);
  }, [hiddenTypesKey, setHiddenTypes]);

  useEffect(() => {
    setHiddenRelationTypes(hiddenRelations);
  }, [hiddenRelations, setHiddenRelationTypes]);

  // --- Seeding ---------------------------------------------------------------------
  // Peek during render (StrictMode-safe), take once in the effect.
  const [handoff] = useState(() => (clusterParam ? peekExplorerHandoff() : null));
  const handoffUsed = useRef(false);
  const [noRecent, setNoRecent] = useState(false);

  useEffect(() => {
    if (ontologyLoading) return undefined;
    if (handoff && !handoffUsed.current) {
      handoffUsed.current = true;
      takeExplorerHandoff();
      void loadHandoff(handoff);
      return undefined;
    }
    if (seeds.length > 0) {
      setNoRecent(false);
      // Already showing exactly these seeds ("Make seed" wrote them to the URL).
      if (state.seedIds.join(',') === seedKey && state.graph.order > 0) return undefined;
      void load(seeds);
      return undefined;
    }
    if (handoff || clusterParam) return undefined;

    // A bare visit: seed from what the caller viewed most recently (§22.2).
    const controller = new AbortController();
    listGraphEntities(host, { sort: 'viewed', limit: 5 }, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        if (response.items.length === 0) {
          setNoRecent(true);
          return;
        }
        updateParams((params) => params.set('seed', response.items.map((item) => item.id).join(',')));
      })
      .catch(() => {
        if (!controller.signal.aborted) setNoRecent(true);
      });
    return () => controller.abort();
    // `state` is read, not reacted to: the seeds in the URL are the trigger.
  }, [ontologyLoading, seedKey, handoff, clusterParam, load, loadHandoff, updateParams]);

  // The slider starts at the earliest `firstSeenAt` among the seeds.
  const [asOfMin, setAsOfMin] = useState(fiveYearsAgo);
  const stateSeedKey = state.seedIds.slice(0, 5).join(',');
  useEffect(() => {
    if (!stateSeedKey) return undefined;
    const controller = new AbortController();
    Promise.all(
      stateSeedKey.split(',').map((id) => getGraphEntity(host, id, controller.signal).catch(() => null)),
    ).then((details) => {
      if (controller.signal.aborted) return;
      const dates = details
        .map((detail) => detail?.firstSeenAt)
        .filter((date): date is string => Boolean(date))
        .sort();
      setAsOfMin(dates[0] ?? fiveYearsAgo());
    });
    return () => controller.abort();
  }, [stateSeedKey]);

  // --- Selection -------------------------------------------------------------------
  const [selected, setSelected] = useState<{ kind: 'node' | 'edge'; id: string } | null>(null);
  // Touch: the node a first tap previewed (lit with its neighbours, not yet open).
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [marked, setMarked] = useState<Set<string>>(() => new Set());
  const [contextTarget, setContextTarget] = useState<ExplorerContextTarget | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const canvasControls = useRef<GraphCanvasControls | null>(null);

  const graph = state.graph;
  const visibleIds = useMemo(
    () => new Set(visibleNodeIds(state)),
    [state, version],
  );
  const atCap = remainingCapacity(state) === 0;
  // Real nodes: a "+N more" stub is not one, and is outside the cap.
  const nodeCount = realNodeCount(state);
  // A phone offers the list as the default for a graph too big to read; `view=graph` overrides it.
  const autoList = viewParam === null && webgl && nodeCount > budgets.listViewDefaultAbove;
  const listView = !webgl || viewParam === 'list' || autoList;

  const selection: ExplorerSelection | null = useMemo(() => {
    if (!selected) return null;
    if (selected.kind === 'node') {
      if (!graph.hasNode(selected.id)) return null;
      const attrs = graph.getNodeAttributes(selected.id);
      return {
        kind: 'node',
        id: selected.id,
        label: attrs.label,
        typeLabel: typeLabel(attrs.entityType),
        nodeKind: attrs.nodeKind,
        degree: attrs.degree,
        status: attrs.status,
        occurredAt: attrs.occurredAt,
        isSeed: state.seedIds.includes(selected.id),
        expanded: state.expanded.has(selected.id),
      };
    }
    if (!graph.hasEdge(selected.id)) return null;
    const attrs = graph.getEdgeAttributes(selected.id);
    const [source, target] = graph.extremities(selected.id);
    const sourceAttrs = graph.getNodeAttributes(source);
    const targetAttrs = graph.getNodeAttributes(target);
    const pageEnd =
      sourceAttrs.nodeKind === 'entity'
        ? { id: source, label: sourceAttrs.label }
        : targetAttrs.nodeKind === 'entity'
          ? { id: target, label: targetAttrs.label }
          : null;
    return {
      kind: 'edge',
      id: selected.id,
      relationLabel: relationTypeLabel(attrs.relationType, ontology),
      fromLabel: sourceAttrs.label,
      toLabel: targetAttrs.label,
      pageId: pageEnd?.id ?? null,
      pageLabel: pageEnd?.label ?? null,
      valid: attrs.valid,
      confidence: attrs.confidence,
      virtual: attrs.virtual,
      props: relationPropsDisplay(attrs.relationType, attrs.props, ontology),
    };
  }, [selected, graph, version, ontology, typeLabel, state]);

  const selectNode = useCallback(
    (id: string, announce = false) => {
      setSelected({ kind: 'node', id });
      if (announce && graph.hasNode(id)) {
        const attrs = graph.getNodeAttributes(id);
        const connections = attrs.degree === 1 ? '1 connection' : `${attrs.degree} connections`;
        setAnnouncement(`${attrs.label}, ${typeLabel(attrs.entityType)}, ${connections}`);
      }
    },
    [graph, typeLabel],
  );

  const deselect = useCallback(() => {
    setSelected(null);
    setPreviewId(null);
  }, []);

  /** A tap or click on a node, in the canvas's own words: what it MEANS depends on the input and the mode. */
  const onNodeActivate = useCallback(
    (id: string) => {
      if (selectMode) {
        setMarked((previous) => {
          const next = new Set(previous);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
        return;
      }
      if (inputModality === 'touch') {
        const open = previewId === id || (selected?.kind === 'node' && selected.id === id);
        if (!open) {
          setPreviewId(id);
          if (graph.hasNode(id)) {
            const attrs = graph.getNodeAttributes(id);
            setAnnouncement(`${attrs.label}, ${typeLabel(attrs.entityType)}. Tap again to open details.`);
          }
          return;
        }
        setPreviewId(null);
      }
      selectNode(id, inputModality === 'touch');
    },
    [selectMode, inputModality, previewId, selected, graph, typeLabel, selectNode],
  );

  const onNodeContextMenu = useCallback(
    (event: NodeContextMenuEvent) => {
      if (!graph.hasNode(event.id)) return;
      setContextTarget({
        id: event.id,
        label: graph.getNodeAttribute(event.id, 'label'),
        clientX: event.clientX,
        clientY: event.clientY,
        isSeed: state.seedIds.includes(event.id),
        pinned: Boolean(graph.getNodeAttribute(event.id, 'fixed')),
      });
    },
    [graph, state],
  );

  const onPin = useCallback(
    (id: string) => {
      if (!graph.hasNode(id)) return;
      graph.setNodeAttribute(id, 'fixed', !graph.getNodeAttribute(id, 'fixed'));
    },
    [graph],
  );

  // --- Actions -------------------------------------------------------------------------
  const onExpand = useCallback((id: string) => void expand(id), [expand]);

  const onHide = useCallback(
    (id: string) => {
      hide(id);
      setMarked((previous) => {
        if (!previous.has(id)) return previous;
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
      setSelected((current) => (current?.kind === 'node' && current.id === id ? null : current));
    },
    [hide],
  );

  const onMakeSeed = useCallback(
    (id: string) => {
      makeSeed(id);
      const next = [...new Set([...state.seedIds, id])];
      if (next.length <= MAX_URL_SEEDS) {
        updateParams((params) => {
          params.set('seed', next.join(','));
          params.delete('cluster');
        });
      }
    },
    [makeSeed, state, updateParams],
  );

  const onReset = useCallback(() => {
    setSelected(null);
    setPreviewId(null);
    setMarked(new Set());
    const current = state.seedIds.length > 0 ? state.seedIds : seeds;
    if (current.length > 0) void load(current);
  }, [load, seeds, state]);

  const toggleListView = useCallback(() => {
    if (!webgl) return;
    updateParams((params) => {
      if (listView) {
        // Asking for the graph where the list was the default must say so, or the default wins again.
        if (autoList) params.set('view', 'graph');
        else params.delete('view');
      } else params.set('view', 'list');
    });
  }, [updateParams, webgl, listView, autoList]);

  const setShownTypes = useCallback(
    (hidden: Set<string>) => {
      const shown = shownParamFromHidden(hidden, nodeTypeKeys);
      updateParams((params) => {
        if (shown === null) params.delete('types');
        else params.set('types', shown);
      });
    },
    [nodeTypeKeys, updateParams],
  );

  const onToggleType = useCallback(
    (key: string) => {
      const next = new Set(hiddenTypes);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      setShownTypes(next);
    },
    [hiddenTypes, setShownTypes],
  );

  const onToggleDomain = useCallback(
    (domain: DomainOption) => {
      const shown =
        domain.nodeTypes.every((key) => !hiddenTypes.has(key)) &&
        domain.relationTypes.every((key) => !hiddenRelations.has(key));
      const types = new Set(hiddenTypes);
      const relations = new Set(hiddenRelations);
      for (const key of domain.nodeTypes) {
        if (shown) types.add(key);
        else types.delete(key);
      }
      for (const key of domain.relationTypes) {
        if (shown) relations.add(key);
        else relations.delete(key);
      }
      setHiddenRelations(relations);
      setShownTypes(types);
    },
    [hiddenRelations, hiddenTypes, setShownTypes],
  );

  const onToggleRelationType = useCallback((key: string) => {
    setHiddenRelations((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const onAsOfChange = useCallback(
    (value: string | null) => {
      updateParams((params) => {
        if (value) params.set('asOf', value);
        else params.delete('asOf');
      });
    },
    [updateParams],
  );

  const chooseSeed = useCallback(
    (id: string) => {
      updateParams((params) => {
        params.set('seed', id);
        params.delete('cluster');
      });
    },
    [updateParams],
  );

  // --- Keyboard ---------------------------------------------------------------------------
  const onCanvasKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const selectedNode = selected?.kind === 'node' && graph.hasNode(selected.id) ? selected.id : null;
    switch (event.key) {
      case '+':
      case '=':
        canvasControls.current?.zoomIn();
        break;
      case '-':
      case '_':
        canvasControls.current?.zoomOut();
        break;
      case '0':
        canvasControls.current?.fit();
        break;
      case 'l':
      case 'L':
        toggleListView();
        break;
      case 'Escape':
        deselect();
        break;
      case 'ArrowRight':
      case 'ArrowLeft': {
        const order = keyboardOrder(state);
        if (order.length === 0) return;
        const index = selectedNode ? order.indexOf(selectedNode) : -1;
        const next =
          event.key === 'ArrowRight'
            ? order[(index + 1) % order.length]
            : order[index <= 0 ? order.length - 1 : index - 1];
        selectNode(next, true);
        break;
      }
      case 'Enter':
        if (selectedNode) onExpand(selectedNode);
        break;
      case 'o':
      case 'O':
        if (selectedNode && graph.getNodeAttribute(selectedNode, 'nodeKind') === 'entity') {
          navigate(`/graph/entities/${encodeURIComponent(selectedNode)}`);
        }
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  // --- Render -----------------------------------------------------------------------------------
  const listRows = useMemo(
    () => toListModel(state),
    [state, version],
  );

  const hasGraph = nodeCount > 0;
  const showSeedSearch =
    !hasGraph && !explorer.isLoading && !explorer.notFound && !explorer.error && seeds.length === 0 &&
    (noRecent || Boolean(clusterParam && !handoff));
  const initialLoading = !hasGraph && !showSeedSearch && !explorer.notFound && !explorer.error;

  const title = (
    <>
      <Typography variant="h5" component="h1">
        Explore
      </Typography>
      {handoff?.title && (
        <Typography variant="body2" color="text.secondary" noWrap>
          {handoff.title}
        </Typography>
      )}
    </>
  );

  /** The early states have no graph yet, so no shell: a heading and one panel. */
  let earlyBody: ReactNode = null;
  if (explorer.notFound && !hasGraph) {
    earlyBody = (
      <Paper variant="outlined" sx={{ p: 3, textAlign: 'center' }}>
        <Typography variant="h6" component="h2" gutterBottom>
          {NOT_IN_GRAPH_TITLE}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {GRAPH_NOT_FOUND_MESSAGE}.
        </Typography>
        <Button component={RouterLink} to="/graph" variant="contained">
          Back to Knowledge
        </Button>
      </Paper>
    );
  } else if (explorer.error && !hasGraph) {
    earlyBody = (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={() => void explorer.retry()}>
            Retry
          </Button>
        }
      >
        {explorer.error}
      </Alert>
    );
  } else if (showSeedSearch) {
    earlyBody = <SeedSearch onChoose={chooseSeed} hint={clusterParam && !handoff ? CLUSTER_HINT : undefined} />;
  }

  const loadingFacets = initialLoading || ontologyLoading;
  const compactLayout = windowClass === 'compact';

  const topBar = (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
      {loadingFacets ? (
        <ExplorerToolbarSkeleton />
      ) : (
        <ExplorerToolbar
          title={title}
          windowClass={windowClass}
          inputModality={inputModality}
          onFit={() => canvasControls.current?.fit()}
          onReset={onReset}
          listView={listView}
          listViewForced={!webgl}
          onToggleListView={toggleListView}
          nodeCount={nodeCount}
          nodeCap={budgets.visibleNodeCap}
          selectMode={selectMode}
          onToggleSelectMode={() => setSelectMode((on) => !on)}
          markedCount={marked.size}
          onClearMarked={() => setMarked(new Set())}
        />
      )}
      {!webgl && <Alert severity="info">{NO_WEBGL_TEXT}</Alert>}
      {autoList && (
        <Alert severity="info">
          This graph has more than {budgets.listViewDefaultAbove} nodes, so it opens as a list on a small screen.
        </Alert>
      )}
      <CapWarning
        capped={explorer.capped}
        truncated={explorer.truncated}
        cap={budgets.visibleNodeCap}
        onDismiss={explorer.dismissCap}
      />
      {explorer.error && hasGraph && <Alert severity="error">{explorer.error}</Alert>}
    </Box>
  );

  // What the colours and pictograms mean, and a second way to toggle a type (the same `types` URL
  // parameter as the chips). `version` and the hidden sets are the dependencies: the state is mutated in place.
  const legend = useMemo(
    () => legendModel(state, nodeTypes, relationTypes, theme.palette.mode),
    [state, version, nodeTypes, relationTypes, hiddenTypesKey, hiddenRelations, theme.palette.mode],
  );

  const facets = loadingFacets ? (
    <ExplorerFiltersSkeleton />
  ) : (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <ExplorerFilters
        domains={domains}
        nodeTypes={nodeTypes}
        relationTypes={relationTypes}
        hiddenTypes={hiddenTypes}
        hiddenRelationTypes={hiddenRelations}
        onToggleType={onToggleType}
        onToggleDomain={onToggleDomain}
        onToggleRelationType={onToggleRelationType}
        asOf={asOf}
        asOfMin={asOfMin}
        onAsOfChange={onAsOfChange}
      />
      {hasGraph && (
        <GraphLegend
          model={legend}
          mode={theme.palette.mode}
          onToggleType={onToggleType}
          onToggleRelation={onToggleRelationType}
        />
      )}
    </Box>
  );

  const markedVisible = useMemo(
    () => new Set([...marked].filter((id) => graph.hasNode(id))),
    [marked, graph, version],
  );

  return (
    <Box sx={{ py: { xs: 1, sm: 2 }, minWidth: 0 }}>
      {earlyBody ? (
        <>
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, mb: 1.5, flexWrap: 'wrap' }}>{title}</Box>
          {earlyBody}
        </>
      ) : (
        <InsightCanvasLayout
          windowClass={windowClass}
          inputModality={inputModality}
          fillHeight={!listView}
          topBar={topBar}
          facets={facets}
          facetsActiveCount={activeFilterCount({ hiddenTypes, hiddenRelationTypes: hiddenRelations, asOf })}
          inspectorOpen={!listView && selection !== null}
          onInspectorOpenChange={(open) => {
            if (!open) deselect();
          }}
          inspector={
            <ExplorerSidePanel
              selection={selection}
              atCap={atCap}
              expanding={selection?.kind === 'node' && explorer.expandingId === selection.id}
              onExpand={onExpand}
              onHide={onHide}
              onMakeSeed={onMakeSeed}
              onClose={deselect}
              actionsFirst={compactLayout}
            />
          }
          canvas={({ canvasInsets }) =>
            listView ? (
              hasGraph ? (
                <Box sx={{ height: '100%', overflowY: 'auto', p: { xs: 1, sm: 1.5 } }}>
                  <ExplorerListView
                    rows={listRows}
                    typeLabel={typeLabel}
                    atCap={atCap}
                    expandingId={explorer.expandingId}
                    onExpand={onExpand}
                    onHide={onHide}
                  />
                </Box>
              ) : (
                <CenteredSpinner label="Loading the graph" />
              )
            ) : (
              <Box
                tabIndex={0}
                role="application"
                aria-label={`Graph explorer, ${nodeCount} nodes. Press L for list view.`}
                aria-busy={explorer.isLoading || undefined}
                onKeyDown={onCanvasKeyDown}
                sx={{
                  position: 'relative',
                  height: '100%',
                  '&:focus-visible': { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: -2 },
                }}
              >
                {hasGraph && (
                  <Suspense fallback={<CenteredSpinner label="Loading the graph" />}>
                    <GraphCanvas
                      graph={graph}
                      version={version}
                      visibleIds={visibleIds}
                      selectedId={selected?.kind === 'node' ? selected.id : null}
                      previewId={previewId}
                      markedIds={markedVisible}
                      layout={layout}
                      inputModality={inputModality}
                      budgets={budgets}
                      revealInsets={canvasInsets}
                      onNodeClick={onNodeActivate}
                      onNodeDoubleClick={onExpand}
                      onNodeContextMenu={onNodeContextMenu}
                      onStageClick={deselect}
                      onEdgeClick={(id) => {
                        setPreviewId(null);
                        setSelected({ kind: 'edge', id });
                      }}
                      height="100%"
                      controlsRef={canvasControls}
                    />
                  </Suspense>
                )}
                {(initialLoading || explorer.isLoading) && <CenteredSpinner label="Loading the graph" overlay />}
              </Box>
            )
          }
        />
      )}
      <ExplorerContextMenu
        target={contextTarget}
        atCap={atCap}
        onClose={() => setContextTarget(null)}
        onOpen={(id) => selectNode(id, true)}
        onExpand={onExpand}
        onPin={onPin}
        onHide={onHide}
        onMakeSeed={onMakeSeed}
      />
      <Box role="status" aria-live="polite" sx={visuallyHidden}>
        {announcement}
      </Box>
    </Box>
  );
}

function CenteredSpinner({ label, overlay = false }: { label: string; overlay?: boolean }) {
  return (
    <Box
      sx={{
        position: overlay ? 'absolute' : 'relative',
        inset: overlay ? 0 : undefined,
        minHeight: overlay ? undefined : 240,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1,
        pointerEvents: 'none',
      }}
    >
      <CircularProgress aria-label={label} />
    </Box>
  );
}

