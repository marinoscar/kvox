/**
 * `/graph/overview` — the shape of the caller's whole graph (#375, epic #347;
 * spec §5.7, §22.3). Owned by `home` through the `/graph` prefix
 * (`config/destinations.ts`), gated on `graph:read`, lazy.
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
 * view without WebGL, and the canvas (sigma) is lazy-loaded a second time
 * inside this lazy page, so the list view never downloads it.
 */

import ViewListIcon from '@mui/icons-material/ViewList';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Paper from '@mui/material/Paper';
import Skeleton from '@mui/material/Skeleton';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { alpha, useTheme } from '@mui/material/styles';
import visuallyHidden from '@mui/utils/visuallyHidden';
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

import type { GraphCanvasControls } from '../components/graph/explorer/GraphCanvas';
import { setExplorerHandoff } from '../components/graph/explorer/explorerHandoff';
import { nodeTypeLabel } from '../components/graph/explorer/explorerFilters';
import { isWebGLAvailable } from '../components/graph/explorer/webgl';
import { ClusterListView } from '../components/graph/overview/ClusterListView';
import { ClusterSidePanel } from '../components/graph/overview/ClusterSidePanel';
import { OverviewBanners } from '../components/graph/overview/OverviewBanners';
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
} from '../components/graph/overview/overviewModel';
import { useGraphOntology } from '../hooks/useGraphAttributeDefs';
import { useGraphOverview } from '../hooks/useGraphOverview';
import { usePermissions } from '../hooks/usePermissions';
import type { GraphOverview } from '../services/graph';
import { formatRelativeTime } from '../utils/relativeTime';

const GraphCanvas = lazy(() => import('../components/graph/explorer/GraphCanvas'));

export const OVERVIEW_TITLE = 'Overview';
export const BUILDING_TEXT = 'Building your overview…';
export const EMPTY_TITLE = 'Nothing to show yet';
export const OVERVIEW_NO_WEBGL_TEXT =
  "Your browser can't draw the graph (WebGL is unavailable), so it is shown as a list.";

type Layer = 'clusters' | 'nodes';

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** "Built 3 days ago · 120 entities · 340 connections". */
export function overviewCaption(overview: GraphOverview, now: Date = new Date()): string {
  const parts: string[] = [];
  if (overview.computedAt) {
    const relative = formatRelativeTime(overview.computedAt, now);
    parts.push(`Built ${relative.charAt(0).toLowerCase()}${relative.slice(1)}`);
  }
  parts.push(plural(overview.nodeCount, 'entity', 'entities'));
  parts.push(plural(overview.edgeCount, 'connection', 'connections'));
  return parts.join(' · ');
}

export default function GraphOverviewPage() {
  const theme = useTheme();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { hasPermission } = usePermissions();
  const canWrite = hasPermission('graph:write');

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
  const { ontology } = useGraphOntology();
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
    <Box sx={{ mb: 1.5 }}>
      <Typography variant="h5" component="h1">
        {OVERVIEW_TITLE}
      </Typography>
      {overview && overview.status === 'ready' ? (
        <Typography variant="body2" color="text.secondary">
          {overviewCaption(overview)}
        </Typography>
      ) : isLoading ? (
        <Skeleton width={260} aria-hidden />
      ) : null}
    </Box>
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
        <Typography variant="body2" color="text.secondary">
          This page updates by itself when it is ready.
        </Typography>
      </Paper>
    );
  } else if (!overview.tooLarge && (overview.status === 'none' || overview.clusters.length === 0)) {
    body = (
      <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
        <Typography variant="h6" component="h2" gutterBottom>
          {EMPTY_TITLE}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          The overview appears once your reviewed notes have added people, organizations or projects
          to your graph.
        </Typography>
        <Button component={RouterLink} to="/graph" variant="contained">
          Back to Knowledge
        </Button>
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
