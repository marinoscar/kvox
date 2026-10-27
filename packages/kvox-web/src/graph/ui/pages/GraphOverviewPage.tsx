/**
 * `/graph` — the shape of the caller's whole graph (#375, epic #347; spec
 * §5.7, §22.3), and since #782 the knowledge LANDING: opening Knowledge shows
 * this map first. Its old address, `/graph/overview`, redirects here with the
 * query string kept. Owned by `knowledge` (#438) through the `/graph` prefix
 * (`config/destinations.ts`), gated on `graph:read`, lazy.
 *
 * THE HEADER IS THE SHARED `KnowledgeHeader` (#782): links to Entities
 * (`/graph/entities`, the index that used to live at `/graph`), Explore,
 * Review and Possible duplicates, and the overflow menu with Synonyms,
 * "Export graph…" and (with `graph:write`) "Import graph…".
 *
 * EMPTY AND SPARSE (#782): with no snapshot yet, or no clusters, or fewer
 * than {@link SPARSE_ENTITY_COUNT} entities, the page says the map fills in
 * as notes are processed and offers Browse entities and Explore. A sparse map
 * is still drawn under the message. The caption reads "Updated" and the
 * relative time, from the snapshot's `computedAt`.
 *
 * DRAWN FROM A STORED SNAPSHOT, NEVER LAID OUT HERE. `GET /api/graph/overview`
 * returns the latest `kg.graph_layout` snapshot (#371) — clusters and 2-D
 * positions computed once on the server — with labels joined live. The page
 * draws it through the explorer's `GraphCanvas` (#374, reused, not forked)
 * with `layout="static"`: nothing on this page ever moves a node, which is
 * what makes the visual baselines deterministic.
 *
 * TWO LAYERS, ONE EXPLICIT TOGGLE (`?layer=clusters|nodes`): one node per
 * cluster, or every positioned entity (≤ 5,000) coloured by cluster. Selecting
 * a cluster (`?cluster=<id>`) dims the rest and opens its side panel; its
 * primary action, **Explore this cluster**, hands the cluster's top members —
 * already loaded, at their overview positions — to the explorer through the
 * in-memory `explorerHandoff` (spec §22.3: no second fetch before the first
 * frame), then navigates to `/graph/explore?cluster=<id>`.
 *
 * ⚠ A cluster id is only stable within ONE snapshot. It lives in this view's
 * URL and nowhere else — never persisted.
 *
 * URL STATE: `layer`, `cluster`, `view=list`. The list view is also the only
 * view without a drawing canvas, and the canvas (G6) is lazy-loaded a second time
 * inside this lazy page, so the list view never downloads it.
 */

import ViewListIcon from '@mui/icons-material/ViewList';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Paper from '@mui/material/Paper';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { alpha, useTheme } from '@mui/material/styles';
import { visuallyHidden } from '../visuallyHidden.js';
import {
  Suspense,
  lazy,
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { Link as RouterLink, useNavigate, useSearchParams } from 'react-router-dom';

import type { GraphCanvasControls } from '../components/explorer/GraphCanvas.js';
import { setExplorerHandoff } from '../../headless/utils/explorerHandoff.js';
import { nodeTypeLabel } from '../../headless/utils/explorerFilters.js';
import { canvasLoaders } from '../components/explorer/canvasLoaders.js';
import { isWebGLAvailable } from '../components/explorer/webgl.js';
import { KnowledgeHeader } from '../components/KnowledgeHeader.js';
import { GRAPH_ENTITIES_PATH } from '../paths.js';
import { ClusterListView } from '../components/overview/ClusterListView.js';
import { ClusterSidePanel } from '../components/overview/ClusterSidePanel.js';
import { OverviewBanners } from '../components/overview/OverviewBanners.js';
import {
  applyClusterFocus,
  buildClusterGraph,
  buildNodeGraph,
  clusterAnnouncement,
  clusterColor,
  clusterHandoff,
  clusterKeyboardOrder,
  clusterNodeKey,
  parseClusterParam,
  toClusterList,
} from '../components/overview/overviewModel.js';
import { useGraphEffectiveOntology } from '../../headless/hooks/useGraphAttributeDefs.js';
import { useGraphOverview } from '../../headless/hooks/useGraphOverview.js';
import type { GraphOverview } from '../../headless/clients/graph.js';
import { formatRelativeTime, useHasPermission } from '../../../core/headless/index.js';

const GraphCanvas = lazy(() => canvasLoaders.graphCanvas());

export const OVERVIEW_TITLE = 'Knowledge';
export const BUILDING_TEXT = 'Building your overview…';
export const EMPTY_TITLE = 'Your map is on its way';
/** What the empty and sparse states say (#782). */
export const FILLS_IN_TEXT =
  'The map fills in as your notes are processed and their proposals reviewed. Until then, browse your entities or explore from one.';
/** The sparse state's title: a map is drawn, but there is little on it. */
export const SPARSE_TITLE = 'Your map is just getting started';
/** Below this many entities the map is "sparse" and the page says so (#782). */
export const SPARSE_ENTITY_COUNT = 5;
export const OVERVIEW_NO_WEBGL_TEXT =
  "Your browser can't draw the graph (canvas drawing is unavailable), so it is shown as a list.";

type Layer = 'clusters' | 'nodes';

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** "Updated 3 days ago · 120 entities · 340 connections". */
export function overviewCaption(overview: GraphOverview, now: Date = new Date()): string {
  const parts: string[] = [];
  if (overview.computedAt) {
    const relative = formatRelativeTime(overview.computedAt, now);
    parts.push(`Updated ${relative.charAt(0).toLowerCase()}${relative.slice(1)}`);
  }
  parts.push(plural(overview.nodeCount, 'entity', 'entities'));
  parts.push(plural(overview.edgeCount, 'connection', 'connections'));
  return parts.join(' · ');
}

/**
 * The `/graph` page (the knowledge landing): the shape of the caller's whole graph, drawn from a stored layout snapshot as clusters or as individual nodes, with a hand-off to the explorer.
 *
 * @stability experimental
 */
export function GraphOverviewPage() {
  const theme = useTheme();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const canWrite = useHasPermission('graph:write');

  // --- URL state --------------------------------------------------------------
  const layer: Layer = searchParams.get('layer') === 'nodes' ? 'nodes' : 'clusters';
  const webgl = useMemo(() => isWebGLAvailable(), []);
  const listView = !webgl || searchParams.get('view') === 'list';
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

  // --- Data -------------------------------------------------------------------
  const {
    overview,
    isLoading,
    error,
    refresh,
    requestRecompute,
    isRequesting,
    requestError,
    pollingStopped,
  } = useGraphOverview();
  const { ontology } = useGraphEffectiveOntology();
  const typeLabel = useCallback((key: string) => nodeTypeLabel(key, ontology), [ontology]);
  const selectedId = parseClusterParam(searchParams.get('cluster'), overview);
  const selectedCluster = useMemo(
    () => (selectedId === null ? null : overview?.clusters.find((c) => c.id === selectedId) ?? null),
    [overview, selectedId],
  );

  // --- The graph ----------------------------------------------------------------
  const drawable = Boolean(overview && overview.status === 'ready' && !overview.tooLarge && overview.clusters.length > 0);
  const graph = useMemo(() => {
    if (!overview || !drawable) return null;
    return layer === 'clusters' ? buildClusterGraph(overview, theme) : buildNodeGraph(overview, theme);
  }, [overview, drawable, layer, theme]);

  // The canvas's own dimming colour, so a focused cluster reads the same way
  // the explorer's selection does.
  const dimColor = alpha(theme.palette.text.disabled, theme.palette.mode === 'dark' ? 0.4 : 0.6);
  const versionRef = useRef(0);
  // Applied during render (not in an effect) so the FIRST frame drawn for a
  // `?cluster=` URL is already focused — a baseline must never catch an
  // unfocused frame.
  const version = useMemo(() => {
    if (graph) applyClusterFocus(graph, selectedId, dimColor);
    versionRef.current += 1;
    return versionRef.current;
  }, [graph, selectedId, dimColor]);
  const visibleIds = useMemo(() => new Set(graph ? graph.nodes() : []), [graph]);

  const listRows = useMemo(() => (overview ? toClusterList(overview) : []), [overview]);
  const colorOf = useCallback((id: number) => clusterColor(id, theme), [theme]);

  // --- Selection + actions -----------------------------------------------------
  const [announcement, setAnnouncement] = useState('');
  const canvasControls = useRef<GraphCanvasControls | null>(null);

  const selectCluster = useCallback(
    (id: number | null, announce = false) => {
      updateParams((params) => {
        if (id === null) params.delete('cluster');
        else params.set('cluster', String(id));
      });
      if (announce && id !== null && overview) {
        const cluster = overview.clusters.find((c) => c.id === id);
        if (cluster) setAnnouncement(clusterAnnouncement(cluster));
      }
    },
    [overview, updateParams],
  );

  const clusterOfNode = useCallback(
    (key: string): number | null => {
      if (!graph || !graph.hasNode(key)) return null;
      return graph.getNodeAttribute(key, 'clusterId');
    },
    [graph],
  );

  const explore = useCallback(
    (clusterId: number) => {
      if (!overview) return;
      setExplorerHandoff(clusterHandoff(overview, clusterId));
      navigate(`/graph/explore?cluster=${clusterId}`);
    },
    [navigate, overview],
  );

  const setLayer = useCallback(
    (next: Layer) => {
      updateParams((params) => {
        if (next === 'nodes') params.set('layer', 'nodes');
        else params.delete('layer');
      });
    },
    [updateParams],
  );

  const toggleListView = useCallback(() => {
    if (!webgl) return;
    updateParams((params) => {
      if (params.get('view') === 'list') params.delete('view');
      else params.set('view', 'list');
    });
  }, [updateParams, webgl]);

  const onRefresh = useCallback(() => void requestRecompute(), [requestRecompute]);

  // --- Keyboard (the #374 container semantics) --------------------------------------
  const onCanvasKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || !overview) return;
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
        selectCluster(null);
        break;
      case 'ArrowRight':
      case 'ArrowDown':
      case 'ArrowLeft':
      case 'ArrowUp': {
        const order = clusterKeyboardOrder(overview);
        if (order.length === 0) return;
        const index = selectedId === null ? -1 : order.indexOf(selectedId);
        const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
        const next = forward
          ? order[(index + 1) % order.length]
          : order[index <= 0 ? order.length - 1 : index - 1];
        selectCluster(next, true);
        break;
      }
      case 'Enter':
        if (selectedId !== null) explore(selectedId);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  // --- Render -----------------------------------------------------------------------
  const header = (
    <KnowledgeHeader
      current="overview"
      title={OVERVIEW_TITLE}
      subtitle={
        overview && overview.status === 'ready' ? (
          overviewCaption(overview)
        ) : isLoading ? (
          <Skeleton width={260} aria-hidden />
        ) : undefined
      }
    />
  );
  const sparse = Boolean(
    overview && overview.status === 'ready' && !overview.tooLarge && overview.nodeCount < SPARSE_ENTITY_COUNT,
  );

  let body;
  if (!overview && isLoading) {
    body = <CenteredSpinner label="Loading the overview" />;
  } else if (!overview) {
    body = (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={() => void refresh()}>
            Retry
          </Button>
        }
      >
        {error ?? 'Failed to load the overview'}
      </Alert>
    );
  } else if (overview.status === 'none' && overview.pending) {
    body = (
      <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
        <CircularProgress aria-label={BUILDING_TEXT} sx={{ mb: 2 }} />
        <Typography variant="h6" component="h2">
          {BUILDING_TEXT}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          This page updates by itself when it is ready.
        </Typography>
        <OverviewStartActions />
      </Paper>
    );
  } else if (!overview.tooLarge && (overview.status === 'none' || overview.clusters.length === 0)) {
    body = (
      <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
        <Typography variant="h6" component="h2" gutterBottom>
          {EMPTY_TITLE}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {FILLS_IN_TEXT}
        </Typography>
        <OverviewStartActions />
      </Paper>
    );
  } else {
    const canvasHeight = isCompactWindow
      ? 'max(360px, calc(100dvh - 340px))'
      : 'max(440px, calc(100dvh - 260px))';
    body = (
      <>
        {drawable && (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, mb: 1.5 }}>
            <ToggleButtonGroup
              exclusive
              size="small"
              value={layer}
              onChange={(_, value: Layer | null) => value && setLayer(value)}
              aria-label="What to show"
              disabled={listView}
            >
              <ToggleButton value="clusters" sx={{ textTransform: 'none', px: 1.5, py: 0.25 }}>
                Clusters
              </ToggleButton>
              <ToggleButton value="nodes" sx={{ textTransform: 'none', px: 1.5, py: 0.25 }}>
                Everything
              </ToggleButton>
            </ToggleButtonGroup>
            <ToggleButton
              value="list"
              size="small"
              selected={listView}
              aria-pressed={listView}
              onChange={toggleListView}
              disabled={!webgl}
              sx={{ textTransform: 'none', px: 1, py: 0.25, whiteSpace: 'nowrap' }}
            >
              <ViewListIcon fontSize="small" sx={{ mr: 0.5 }} />
              List view
            </ToggleButton>
            {canWrite && (
              <Button
                size="small"
                variant="outlined"
                sx={{ ml: 'auto' }}
                onClick={onRefresh}
                disabled={overview.pending || isRequesting}
              >
                Refresh
              </Button>
            )}
          </Box>
        )}
        {sparse && (
          <Paper
            variant="outlined"
            component="section"
            aria-labelledby="overview-sparse-heading"
            sx={{ p: { xs: 2, sm: 2.5 }, mb: 1.5 }}
          >
            <Typography id="overview-sparse-heading" variant="subtitle1" component="h2" sx={{ fontWeight: 600 }}>
              {SPARSE_TITLE}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              {FILLS_IN_TEXT}
            </Typography>
            <OverviewStartActions align="start" />
          </Paper>
        )}
        <OverviewBanners
          overview={overview}
          layer={listView ? 'clusters' : layer}
          canWrite={canWrite}
          isRequesting={isRequesting}
          requestError={requestError}
          pollingStopped={pollingStopped}
          onRefresh={onRefresh}
        />
        {drawable && !webgl && (
          <Alert severity="info" sx={{ mb: 1.5 }}>
            {OVERVIEW_NO_WEBGL_TEXT}
          </Alert>
        )}
        {drawable && graph &&
          (listView ? (
            <ClusterListView
              rows={listRows}
              colorOf={colorOf}
              typeLabel={typeLabel}
              selectedId={selectedId}
              onSelect={(id) => selectCluster(id)}
              onExplore={explore}
            />
          ) : (
            <Box
              tabIndex={0}
              role="application"
              aria-label={`Graph overview, ${plural(overview.clusters.length, 'cluster', 'clusters')}. Arrow keys move between clusters, Enter explores one. Press L for list view.`}
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
              <Suspense fallback={<CenteredSpinner label="Loading the overview" overlay />}>
                <GraphCanvas
                  graph={graph}
                  version={version}
                  visibleIds={visibleIds}
                  selectedId={layer === 'clusters' && selectedId !== null ? clusterNodeKey(selectedId) : null}
                  layout="static"
                  onNodeClick={(key) => selectCluster(clusterOfNode(key))}
                  onNodeDoubleClick={(key) => {
                    const id = clusterOfNode(key);
                    if (id !== null) explore(id);
                  }}
                  onStageClick={() => selectCluster(null)}
                  height="100%"
                  controlsRef={canvasControls}
                />
              </Suspense>
              <ClusterSidePanel
                cluster={selectedCluster}
                color={selectedCluster ? colorOf(selectedCluster.id) : null}
                typeLabel={typeLabel}
                onExplore={explore}
                onClose={() => selectCluster(null)}
              />
            </Box>
          ))}
      </>
    );
  }

  return (
    <Box sx={{ py: { xs: 1, sm: 2 }, minWidth: 0 }}>
      {header}
      {body}
      <Box role="status" aria-live="polite" sx={visuallyHidden}>
        {announcement}
      </Box>
    </Box>
  );
}

/** "Browse entities" and "Explore": where to go while the map is empty or sparse (#782). */
function OverviewStartActions({ align = 'center' }: { align?: 'center' | 'start' }) {
  return (
    <Stack
      direction="row"
      spacing={1}
      useFlexGap
      sx={{ flexWrap: 'wrap', justifyContent: align === 'center' ? 'center' : 'flex-start' }}
    >
      <Button component={RouterLink} to={GRAPH_ENTITIES_PATH} variant="contained">
        Browse entities
      </Button>
      <Button component={RouterLink} to="/graph/explore" variant="outlined">
        Explore
      </Button>
    </Stack>
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
