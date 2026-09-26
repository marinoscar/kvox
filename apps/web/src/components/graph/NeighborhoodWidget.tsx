/**
 * `NeighborhoodWidget` — the entity page's interactive neighbourhood (#374;
 * spec §13), mounted ABOVE the Connections list, which stays the accessible
 * text form of the same one-hop slice.
 *
 * `getEntityNeighborhood(id, { hops: 1, limit: 60 })`, drawn by the explorer's
 * own `GraphCanvas` (lazy — sigma and graphology never enter the entity page's
 * chunk): the model's deterministic ring placement first, then a short
 * ForceAtlas2 settle (none under `prefers-reduced-motion` or `?layout=static`).
 * Clicking a node selects it and shows a small card with "Open page".
 *
 * ON A PHONE THE CANVAS IS NOT INTERACTIVE: a pannable canvas in a scrolling
 * column traps the page's scroll under the user's thumb. A tap anywhere on it
 * opens the explorer instead. (A page-level `down('sm')` read, like
 * `LibraryPageFrame`'s — not an app-chrome breakpoint gate.)
 *
 * NO WEBGL, NO WIDGET: it renders nothing, and the Connections list below
 * already carries the content. Nor does it show an error or an empty card —
 * the list below reports both.
 */

import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';

import { isAbortError } from '../../hooks/graphHookUtils';
import { getEntityNeighborhood } from '../../services/graph';
import type { GraphSlice } from '../../services/graph';
import { isWebGLAvailable } from './explorer/webgl';
import { entityPath } from './EntityListRow';

const NeighborhoodCanvas = lazy(() => import('./explorer/NeighborhoodCanvas'));

export const NEIGHBORHOOD_WIDGET_LIMIT = 60;

export interface NeighborhoodWidgetProps {
  entityId: string;
  entityLabel: string;
}

interface Picked {
  id: string;
  label: string;
  type: string;
  nodeKind: 'entity' | 'item';
}

export function explorerPathFor(entityId: string): string {
  return `/graph/explore?seed=${encodeURIComponent(entityId)}`;
}

export function NeighborhoodWidget({ entityId, entityLabel }: NeighborhoodWidgetProps) {
  const theme = useTheme();
  const isCompactWindow = useMediaQuery(theme.breakpoints.down('sm'));
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [searchParams] = useSearchParams();
  const layout = reducedMotion || searchParams.get('layout') === 'static' ? 'static' : 'forceatlas';
  const webgl = useMemo(() => isWebGLAvailable(), []);

  const [slice, setSlice] = useState<GraphSlice | null>(null);
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState<Picked | null>(null);

  useEffect(() => {
    if (!webgl) return undefined;
    const controller = new AbortController();
    setSlice(null);
    setFailed(false);
    setPicked(null);
    getEntityNeighborhood(entityId, { hops: 1, limit: NEIGHBORHOOD_WIDGET_LIMIT }, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setSlice(result);
      })
      .catch((err) => {
        if (!controller.signal.aborted && !isAbortError(err)) setFailed(true);
      });
    return () => controller.abort();
  }, [entityId, webgl]);

  if (!webgl || failed) return null;
  if (slice && slice.nodes.length <= 1) return null;

  const height = isCompactWindow ? 260 : 320;
  const explorerPath = explorerPathFor(entityId);

  return (
    <Paper component="section" variant="outlined" aria-labelledby="neighborhood-heading" sx={{ mb: 3, overflow: 'hidden' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2, py: 1.25 }}>
        <Typography id="neighborhood-heading" variant="h6" component="h2" sx={{ flex: 1 }}>
          Neighbourhood
        </Typography>
        <Button size="small" component={RouterLink} to={explorerPath} endIcon={<OpenInNewIcon fontSize="small" />}>
          Open in explorer
        </Button>
      </Box>
      <Box sx={{ position: 'relative', height, borderTop: 1, borderColor: 'divider' }}>
        {slice ? (
          <Suspense fallback={<Skeleton variant="rectangular" height={height} />}>
            <NeighborhoodCanvas
              slice={slice}
              selectedId={picked?.id ?? null}
              layout={layout}
              interactive={!isCompactWindow}
              height={height}
              ariaLabel={`${entityLabel}'s connections, drawn as a graph. The same connections are listed below.`}
              onNodeClick={(id, label, type, nodeKind) => setPicked({ id, label, type, nodeKind })}
              onStageClick={() => setPicked(null)}
            />
          </Suspense>
        ) : (
          <Skeleton variant="rectangular" height={height} aria-label="Loading the neighbourhood" role="status" />
        )}
        {isCompactWindow && slice && (
          // The whole phone canvas is one tap target into the explorer. It
          // duplicates the header link, so it is hidden from assistive tech
          // and the tab order rather than announced twice.
          <Box
            component={RouterLink}
            to={explorerPath}
            tabIndex={-1}
            aria-hidden
            data-testid="neighborhood-tap-target"
            sx={{ position: 'absolute', inset: 0, zIndex: 1 }}
          />
        )}
        {picked && !isCompactWindow && (
          <Paper
            elevation={3}
            role="status"
            sx={{
              position: 'absolute',
              left: 12,
              bottom: 12,
              zIndex: 2,
              px: 1.5,
              py: 1,
              display: 'flex',
              alignItems: 'center',
              gap: 1.5,
              maxWidth: 'calc(100% - 24px)',
            }}
          >
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="body2" noWrap sx={{ fontWeight: 600 }}>
                {picked.label}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {picked.type}
              </Typography>
            </Box>
            {picked.nodeKind === 'entity' && picked.id !== entityId && (
              <Button size="small" component={RouterLink} to={entityPath(picked.id)}>
                Open page
              </Button>
            )}
          </Paper>
        )}
      </Box>
    </Paper>
  );
}

export default NeighborhoodWidget;
