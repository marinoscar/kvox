/**
 * `OverviewBanners` — what the overview says about its own snapshot (#375;
 * spec §22.3): building, out of date, too large, or trimmed.
 *
 * ⚠ A STALE SNAPSHOT IS REPORTED, NEVER REFRESHED ON READ. The server never
 * re-lays-out a graph because somebody looked at it; only a writer pressing
 * Refresh queues one. A reader (no `graph:write`) sees the sentence and no
 * button — there is nothing they could press that the server would accept.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import LinearProgress from '@mui/material/LinearProgress';
import Typography from '@mui/material/Typography';
import { Link as RouterLink } from 'react-router-dom';

import { OVERVIEW_MAX_NODES, type GraphOverview } from '../../../services/graph';

export const STALE_TEXT = 'Your graph has changed since this overview was built.';
export const PENDING_TEXT = 'Updating the overview…';
export const TOO_LARGE_TEXT =
  'Your graph is too large for an overview. Use the explorer to look around a person or organization.';
export const POLLING_STOPPED_TEXT =
  'This is taking longer than usual. Reload the page later to see the new overview.';

export function truncatedText(nodeCount: number): string {
  return `Showing the ${OVERVIEW_MAX_NODES.toLocaleString('en-US')} most connected of ${nodeCount.toLocaleString('en-US')} entities`;
}

export interface OverviewBannersProps {
  overview: GraphOverview;
  layer: 'clusters' | 'nodes';
  canWrite: boolean;
  isRequesting: boolean;
  requestError: string | null;
  pollingStopped: boolean;
  onRefresh: () => void;
}

export function OverviewBanners({
  overview,
  layer,
  canWrite,
  isRequesting,
  requestError,
  pollingStopped,
  onRefresh,
}: OverviewBannersProps) {
  const { pending, stale, tooLarge, nodesTruncated, nodeCount } = overview;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mb: 1.5, '&:empty': { display: 'none' } }}>
      {requestError && <Alert severity="error">{requestError}</Alert>}
      {pending && (
        <Alert severity="info" sx={{ '& .MuiAlert-message': { flex: 1 } }}>
          {PENDING_TEXT}
          <LinearProgress sx={{ mt: 1 }} aria-label={PENDING_TEXT} />
        </Alert>
      )}
      {pending && pollingStopped && <Alert severity="warning">{POLLING_STOPPED_TEXT}</Alert>}
      {stale && !pending && (
        <Alert
          severity="info"
          action={
            canWrite ? (
              <Button color="inherit" size="small" onClick={onRefresh} disabled={isRequesting}>
                Refresh
              </Button>
            ) : undefined
          }
        >
          {STALE_TEXT}
        </Alert>
      )}
      {tooLarge && (
        <Alert
          severity="warning"
          action={
            <Button color="inherit" size="small" component={RouterLink} to="/graph/explore">
              Open the explorer
            </Button>
          }
        >
          {TOO_LARGE_TEXT}
        </Alert>
      )}
      {nodesTruncated && layer === 'nodes' && !tooLarge && (
        <Typography variant="caption" color="text.secondary" component="p">
          {truncatedText(nodeCount)}
        </Typography>
      )}
    </Box>
  );
}
