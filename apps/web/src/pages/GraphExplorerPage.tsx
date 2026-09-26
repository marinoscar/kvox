/**
 * `/graph/explore` — the bounded, interactive graph explorer (#374, epic #347;
 * spec §22.2). Owned by `home` (`config/destinations.ts`), gated on
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
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import visuallyHidden from '@mui/utils/visuallyHidden';
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { Link as RouterLink, useNavigate, useSearchParams } from 'react-router-dom';

import { CapWarning } from '../components/graph/explorer/CapWarning';
import {
  ExplorerSidePanel,
  type ExplorerSelection,
} from '../components/graph/explorer/ExplorerSidePanel';
import { ExplorerListView } from '../components/graph/explorer/ExplorerListView';
import { ExplorerToolbar, ExplorerToolbarSkeleton } from '../components/graph/explorer/ExplorerToolbar';
import type { GraphCanvasControls } from '../components/graph/explorer/GraphCanvas';
import { SeedSearch } from '../components/graph/explorer/SeedSearch';
import { peekExplorerHandoff, takeExplorerHandoff } from '../components/graph/explorer/explorerHandoff';
import {
  domainOptions,
  hiddenFromShown,
  nodeTypeLabel,
  nodeTypeOptions,
  parseAsOfParam,
  relationTypeOptions,
  shownParamFromHidden,
  type DomainOption,
} from '../components/graph/explorer/explorerFilters';
import {
  keyboardOrder,
  remainingCapacity,
  toListModel,
  visibleNodeIds,
} from '../components/graph/explorer/explorerModel';
import { isWebGLAvailable } from '../components/graph/explorer/webgl';
import { GRAPH_NOT_FOUND_MESSAGE } from '../hooks/graphHookUtils';
import { useGraphOntology } from '../hooks/useGraphAttributeDefs';
import { useGraphExplorer } from '../hooks/useGraphExplorer';
import { getGraphEntity, listGraphEntities } from '../services/graph';
import { relationTypeLabel } from '../utils/graphDisplay';

const GraphCanvas = lazy(() => import('../components/graph/explorer/GraphCanvas'));

/** The most seeds `?seed=` carries (the issue's URL contract). */
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

export default function GraphExplorerPage() {
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
  const webgl = useMemo(() => isWebGLAvailable(), []);
  const listView = !webgl || searchParams.get('view') === 'list';
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const layout = searchParams.get('layout') === 'static' || reducedMotion ? 'static' : 'forceatlas';
  // Page-level, not an app-chrome gate: how tall the canvas is on a phone.
  const isCompactWindow = useMediaQuery(theme.breakpoints.down('sm'));

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
  const { ontology, isLoading: ontologyLoading } = useGraphOntology();
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
  const explorer = useGraphExplorer({ nodeTypes: nodeTypeKeys, relationTypes: relationKeys, palette: theme });
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
    listGraphEntities({ sort: 'viewed', limit: 5 }, controller.signal)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ontologyLoading, seedKey, handoff, clusterParam, load, loadHandoff, updateParams]);

  // The slider starts at the earliest `firstSeenAt` among the seeds.
  const [asOfMin, setAsOfMin] = useState(fiveYearsAgo);
  const stateSeedKey = state.seedIds.slice(0, 5).join(',');
  useEffect(() => {
    if (!stateSeedKey) return undefined;
    const controller = new AbortController();
    Promise.all(
      stateSeedKey.split(',').map((id) => getGraphEntity(id, controller.signal).catch(() => null)),
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
  const [announcement, setAnnouncement] = useState('');
  const canvasControls = useRef<GraphCanvasControls | null>(null);

  const graph = state.graph;
  const visibleIds = useMemo(
    () => new Set(visibleNodeIds(state)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, version],
  );
  const atCap = remainingCapacity(state) === 0;
  const nodeCount = graph.order;

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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const deselect = useCallback(() => setSelected(null), []);

  // --- Actions -------------------------------------------------------------------------
  const onExpand = useCallback((id: string) => void expand(id), [expand]);

  const onHide = useCallback(
    (id: string) => {
      hide(id);
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
    const current = state.seedIds.length > 0 ? state.seedIds : seeds;
    if (current.length > 0) void load(current);
  }, [load, seeds, state]);

  const toggleListView = useCallback(() => {
    if (!webgl) return;
    updateParams((params) => {
      if (params.get('view') === 'list') params.delete('view');
      else params.set('view', 'list');
    });
  }, [updateParams, webgl]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, version],
  );

  const hasGraph = nodeCount > 0;
  const showSeedSearch =
    !hasGraph && !explorer.isLoading && !explorer.notFound && !explorer.error && seeds.length === 0 &&
    (noRecent || Boolean(clusterParam && !handoff));
  const initialLoading = !hasGraph && !showSeedSearch && !explorer.notFound && !explorer.error;

  let body;
  if (explorer.notFound && !hasGraph) {
    body = (
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
    body = (
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
    body = <SeedSearch onChoose={chooseSeed} hint={clusterParam && !handoff ? CLUSTER_HINT : undefined} />;
  } else {
    const canvasHeight = isCompactWindow
      ? 'max(360px, calc(100dvh - 340px))'
      : 'max(440px, calc(100dvh - 260px))';
    body = (
      <>
        {initialLoading || ontologyLoading ? (
          <ExplorerToolbarSkeleton />
        ) : (
          <ExplorerToolbar
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
            onFit={() => canvasControls.current?.fit()}
            onReset={onReset}
            listView={listView}
            listViewForced={!webgl}
            onToggleListView={toggleListView}
            nodeCount={nodeCount}
          />
        )}
        {!webgl && (
          <Alert severity="info" sx={{ mb: 1.5 }}>
            {NO_WEBGL_TEXT}
          </Alert>
        )}
        <CapWarning capped={explorer.capped} truncated={explorer.truncated} onDismiss={explorer.dismissCap} />
        {explorer.error && hasGraph && (
          <Alert severity="error" sx={{ mb: 1.5 }}>
            {explorer.error}
          </Alert>
        )}
        {listView ? (
          hasGraph ? (
            <ExplorerListView
              rows={listRows}
              typeLabel={typeLabel}
              atCap={atCap}
              expandingId={explorer.expandingId}
              onExpand={onExpand}
              onHide={onHide}
            />
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
              height: canvasHeight,
              border: 1,
              borderColor: 'divider',
              borderRadius: 2,
              overflow: 'hidden',
              bgcolor: 'background.paper',
              '&:focus-visible': { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 2 },
            }}
          >
            {hasGraph && (
              <Suspense fallback={<CenteredSpinner label="Loading the graph" />}>
                <GraphCanvas
                  graph={graph}
                  version={version}
                  visibleIds={visibleIds}
                  selectedId={selected?.kind === 'node' ? selected.id : null}
                  layout={layout}
                  onNodeClick={(id) => selectNode(id)}
                  onNodeDoubleClick={onExpand}
                  onStageClick={deselect}
                  onEdgeClick={(id) => setSelected({ kind: 'edge', id })}
                  height="100%"
                  controlsRef={canvasControls}
                />
              </Suspense>
            )}
            {(initialLoading || explorer.isLoading) && <CenteredSpinner label="Loading the graph" overlay />}
            <ExplorerSidePanel
              selection={selection}
              atCap={atCap}
              expanding={selection?.kind === 'node' && explorer.expandingId === selection.id}
              onExpand={onExpand}
              onHide={onHide}
              onMakeSeed={onMakeSeed}
              onClose={deselect}
            />
          </Box>
        )}
      </>
    );
  }

  return (
    <Box sx={{ py: { xs: 1, sm: 2 }, minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, mb: 1.5, flexWrap: 'wrap' }}>
        <Typography variant="h5" component="h1">
          Explore
        </Typography>
        {handoff?.title && (
          <Typography variant="body2" color="text.secondary">
            {handoff.title}
          </Typography>
        )}
      </Box>
      {body}
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

