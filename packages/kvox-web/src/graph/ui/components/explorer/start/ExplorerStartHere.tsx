/**
 * `ExplorerStartHere` — where the explorer begins when there is nothing to open
 * (GIC-09, #670; epic #661): no `?seed=`, no overview hand-off and nothing
 * viewed yet, or the person pressed Home. It replaces the bare seed search and
 * gives a reason to explore. NEVER A HAIRBALL: nothing here draws the graph.
 *
 *   - Themes: the overview's clusters (label, size, top member types). A tap
 *     seeds the explorer with the cluster, through the existing overview
 *     hand-off. The overview's own states are kept: "Building your map…" while a
 *     layout is pending, the stale and too-large notices, and a note when no
 *     snapshot exists yet.
 *   - Who and what is active: the most-mentioned People, Projects, Products and
 *     Topics in the last 30 days (`GET /graph/entities?sort=mentions&since=`).
 *   - Recent: the entities the person viewed last.
 *
 * The cards sit in a grid of 1 column on a compact window, 2 on a medium one and
 * 3 on an expanded one (the window class comes from the page; this reads no
 * media query). Every card is a real button with a 44px target.
 *
 * "Connect two things" (path mode, GIC-13) is drawn only when the page
 * passes `onConnect`, which opens the path picker.
 */

import SearchIcon from '@mui/icons-material/Search';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import LinearProgress from '@mui/material/LinearProgress';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import { useEffect, useMemo, useState } from 'react';

import { useKvoxHost } from '../../../../../core/headless/index.js';
import {
  listGraphEntities,
  type GraphEntitySummary,
  type GraphOverview,
  type GraphOverviewCluster,
} from '../../../../headless/clients/graph.js';
import { useGraphOverview } from '../../../../headless/hooks/useGraphOverview.js';
import { EntityTypeIcon } from '../../entityTypeIcon.js';
import { PENDING_TEXT, STALE_TEXT, TOO_LARGE_TEXT } from '../../overview/OverviewBanners.js';
import type { WindowClass } from '../shell/useWindowClass.js';

/** Types shown under "Who and what is active", in this order. */
export const ACTIVE_TYPES = ['Person', 'Project', 'Product', 'Topic'] as const;
/** The window of "active", in days. */
export const ACTIVE_WINDOW_DAYS = 30;
/** Rows per type under "Who and what is active". */
export const ACTIVE_ROWS = 5;
/** Theme cards shown. */
export const THEME_LIMIT = 6;
/** Recent rows shown. */
export const RECENT_ROWS = 6;

/** Shown while no overview snapshot exists and a layout is running. */
export const BUILDING_TEXT = 'Building your map…';
/** Shown when no overview snapshot exists and none is running. */
export const NO_THEMES_TEXT = 'Themes appear once your graph has grown enough to be laid out.';
/** Shown when nothing was mentioned in the window. */
export const NO_ACTIVE_TEXT = `Nothing has been mentioned in the last ${ACTIVE_WINDOW_DAYS} days yet.`;
/** Shown when nothing was viewed yet. */
export const NO_RECENT_TEXT = "You haven't opened anything yet.";

/** Props of {@link ExplorerStartHere}. */
export interface ExplorerStartHereProps {
  /** Sets the card grid: 1 column compact, 2 medium, 3 expanded. */
  windowClass: WindowClass;
  /** Start from one entity (an Active or Recent row). */
  onChooseEntity: (id: string) => void;
  /** Start from a theme: the overview and the cluster's id. */
  onChooseTheme: (overview: GraphOverview, clusterId: number) => void;
  /** Open the command palette. */
  onOpenSearch: () => void;
  /** An extra line above the cards, such as the hint after a reload that lost its hand-off. */
  hint?: string;
  /** Open path mode ("Connect two things"). Omitted until that capability exists: the prompt is then not drawn. */
  onConnect?: () => void;
  /** Reads a type key as a label. */
  typeLabel: (key: string) => string;
}

/** The column count of the card grid for a window class. */
export function startColumns(windowClass: WindowClass): 1 | 2 | 3 {
  if (windowClass === 'expanded') return 3;
  return windowClass === 'medium' ? 2 : 1;
}

/** The ISO date `days` days before now, as `YYYY-MM-DD`. */
export function sinceDate(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

/** The themes to show: real clusters (not "Unconnected"), largest first. */
export function themeClusters(overview: GraphOverview | null): GraphOverviewCluster[] {
  if (!overview || overview.status !== 'ready' || overview.tooLarge) return [];
  return overview.clusters
    .filter((cluster) => cluster.id !== -1 && cluster.size > 0)
    .sort((a, b) => b.size - a.size || a.id - b.id)
    .slice(0, THEME_LIMIT);
}

interface ListState {
  items: GraphEntitySummary[];
  loading: boolean;
  error: boolean;
}

/** Runs one entity-list request and keeps its three states. */
function useEntityList(params: Parameters<typeof listGraphEntities>[1]): ListState {
  const host = useKvoxHost();
  const key = JSON.stringify(params);
  const [state, setState] = useState<ListState>({ items: [], loading: true, error: false });
  useEffect(() => {
    const controller = new AbortController();
    setState((previous) => ({ ...previous, loading: true }));
    listGraphEntities(host, JSON.parse(key) as typeof params, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted) setState({ items: page.items, loading: false, error: false });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ items: [], loading: false, error: true });
      });
    return () => controller.abort();
  }, [host, key]);
  return state;
}

/** The entry state of the explorer. */
export function ExplorerStartHere(props: ExplorerStartHereProps) {
  const { windowClass, onChooseEntity, onChooseTheme, onOpenSearch, hint, onConnect, typeLabel } = props;
  const columns = startColumns(windowClass);
  const gridSx = { display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: 1.5 } as const;
  const { overview, isLoading: overviewLoading, error: overviewError } = useGraphOverview();
  const themes = useMemo(() => themeClusters(overview), [overview]);

  const since = useMemo(() => sinceDate(ACTIVE_WINDOW_DAYS), []);
  const person = useEntityList({ type: ['Person'], sort: 'mentions', since, limit: ACTIVE_ROWS });
  const project = useEntityList({ type: ['Project'], sort: 'mentions', since, limit: ACTIVE_ROWS });
  const product = useEntityList({ type: ['Product'], sort: 'mentions', since, limit: ACTIVE_ROWS });
  const topic = useEntityList({ type: ['Topic'], sort: 'mentions', since, limit: ACTIVE_ROWS });
  const active = [person, project, product, topic];
  const activeLoading = active.some((list) => list.loading);
  const activeEmpty = !activeLoading && active.every((list) => list.items.length === 0);
  const recent = useEntityList({ sort: 'viewed', limit: RECENT_ROWS });

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, maxWidth: 1100, mx: 'auto', width: '100%' }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <Typography variant="h6" component="h2">
          Where do you want to start?
        </Typography>
        {hint && <Typography variant="body2" color="text.secondary">{hint}</Typography>}
        <Button
          variant="outlined"
          color="inherit"
          startIcon={<SearchIcon />}
          onClick={onOpenSearch}
          aria-keyshortcuts="Control+K Meta+K /"
          sx={{
            justifyContent: 'flex-start',
            textTransform: 'none',
            color: 'text.secondary',
            minHeight: 48,
            maxWidth: 560,
            width: '100%',
          }}
        >
          Search a person, project or topic
        </Button>
        {onConnect && (
          <Button variant="text" onClick={onConnect} sx={{ alignSelf: 'flex-start', minHeight: 44, textTransform: 'none' }}>
            Connect two things
          </Button>
        )}
      </Box>

      <Box component="section" aria-labelledby="start-themes">
        <Typography id="start-themes" variant="subtitle1" component="h3" sx={{ mb: 1 }}>
          Themes
        </Typography>
        {overview?.pending && (
          <Alert severity="info" sx={{ mb: 1.5, '& .MuiAlert-message': { flex: 1 } }}>
            {themes.length === 0 ? BUILDING_TEXT : PENDING_TEXT}
            <LinearProgress sx={{ mt: 1 }} aria-label={BUILDING_TEXT} />
          </Alert>
        )}
        {overview?.stale && !overview.pending && themes.length > 0 && (
          <Alert severity="info" sx={{ mb: 1.5 }}>
            {STALE_TEXT}
          </Alert>
        )}
        {overview?.tooLarge && (
          <Alert severity="warning" sx={{ mb: 1.5 }}>
            {TOO_LARGE_TEXT}
          </Alert>
        )}
        {overviewError && !overview && <Alert severity="error">{overviewError}</Alert>}
        {overviewLoading && !overview ? (
          <Box sx={gridSx} aria-hidden>
            {[0, 1, 2].slice(0, columns).map((i) => (
              <Skeleton key={i} variant="rounded" height={112} />
            ))}
          </Box>
        ) : themes.length > 0 ? (
          <Box component="ul" sx={{ ...gridSx, listStyle: 'none', m: 0, p: 0 }}>
            {themes.map((cluster) => (
              <Box component="li" key={cluster.id} sx={{ display: 'flex' }}>
                <Card variant="outlined" sx={{ width: '100%' }}>
                  <CardActionArea
                    onClick={() => overview && onChooseTheme(overview, cluster.id)}
                    sx={{ minHeight: 112, height: '100%' }}
                  >
                    <CardContent>
                      <Typography variant="subtitle2" component="div" noWrap>
                        {cluster.label}
                      </Typography>
                      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                        {cluster.size === 1 ? '1 thing' : `${cluster.size.toLocaleString('en-US')} things`}
                      </Typography>
                      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                        {Object.entries(cluster.typeCounts)
                          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                          .slice(0, 3)
                          .map(([type, count]) => (
                            <Chip
                              key={type}
                              size="small"
                              variant="outlined"
                              icon={<EntityTypeIcon type={type} fontSize="small" />}
                              label={`${typeLabel(type)} ${count}`}
                            />
                          ))}
                      </Box>
                    </CardContent>
                  </CardActionArea>
                </Card>
              </Box>
            ))}
          </Box>
        ) : (
          !overview?.pending &&
          !overview?.tooLarge &&
          !overviewError && (
            <Typography variant="body2" color="text.secondary">
              {NO_THEMES_TEXT}
            </Typography>
          )
        )}
      </Box>

      <Box component="section" aria-labelledby="start-active">
        <Typography id="start-active" variant="subtitle1" component="h3" sx={{ mb: 1 }}>
          Who and what is active
        </Typography>
        {activeLoading && (
          <Box sx={gridSx} aria-hidden>
            {[0, 1, 2].slice(0, columns).map((i) => (
              <Skeleton key={i} variant="rounded" height={112} />
            ))}
          </Box>
        )}
        {activeEmpty && (
          <Typography variant="body2" color="text.secondary">
            {NO_ACTIVE_TEXT}
          </Typography>
        )}
        {!activeLoading && !activeEmpty && (
          <Box sx={gridSx}>
            {ACTIVE_TYPES.map((type, index) =>
              active[index].items.length === 0 ? null : (
                <EntityCard
                  key={type}
                  title={typeLabel(type)}
                  items={active[index].items}
                  onChoose={onChooseEntity}
                />
              ),
            )}
          </Box>
        )}
      </Box>

      <Box component="section" aria-labelledby="start-recent">
        <Typography id="start-recent" variant="subtitle1" component="h3" sx={{ mb: 1 }}>
          Recent
        </Typography>
        {recent.loading ? (
          <Skeleton variant="rounded" height={64} aria-hidden />
        ) : recent.items.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {NO_RECENT_TEXT}
          </Typography>
        ) : (
          <Box sx={gridSx}>
            <EntityCard title="Last opened" items={recent.items} onChoose={onChooseEntity} />
          </Box>
        )}
      </Box>
    </Box>
  );
}

function EntityCard({
  title,
  items,
  onChoose,
}: {
  title: string;
  items: GraphEntitySummary[];
  onChoose: (id: string) => void;
}) {
  return (
    <Card variant="outlined" component="section" aria-label={title}>
      <CardContent sx={{ pb: 1 }}>
        <Typography variant="subtitle2" component="h4">
          {title}
        </Typography>
      </CardContent>
      <List dense disablePadding sx={{ pb: 0.5 }}>
        {items.map((entity) => (
          <ListItem key={entity.id} disablePadding>
            <ListItemButton onClick={() => onChoose(entity.id)} sx={{ minHeight: 44 }}>
              <ListItemIcon sx={{ minWidth: 36 }}>
                <EntityTypeIcon type={entity.type} fontSize="small" />
              </ListItemIcon>
              <ListItemText primary={entity.label} slotProps={{ primary: { noWrap: true } }} />
            </ListItemButton>
          </ListItem>
        ))}
      </List>
    </Card>
  );
}
