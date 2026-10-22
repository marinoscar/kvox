/**
 * `PathPanel` — the body of path mode wherever it lives (GIC-13, #674): a
 * header (the two ends, "Change", close), the actions ("Show on canvas"), and
 * one of the states of a search: loading, a timeout or other error with retry,
 * "No connection within N hops" with the buttons that widen the search, or the
 * {@link PathStrip}.
 *
 * "Explain this path" is deliberately absent. The host's Ask slot takes an
 * entity (`GraphEntityAskPanelProps`), not a set of evidence, and the contract
 * has no scoped context for it yet; a button that asked about only one end
 * would answer from the wrong evidence.
 */

import CloseIcon from '@mui/icons-material/Close';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';

import { MAX_PATH_HOPS, type PathView } from './pathModel.js';
import { PathStrip, type PathStripProps } from './PathStrip.js';
import type { GraphPathsFailure } from './useGraphPaths.js';

/**
 * Props of {@link PathPanel}.
 *
 * @stability experimental
 */
export interface PathPanelProps {
  /** The two ends, e.g. "Joe Rivera and Copilot rollout". */
  title: string;
  /** The state of the search. */
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** Why the search failed, once `error`. */
  failure: GraphPathsFailure | null;
  /** The ranked paths, once `ready`. */
  paths: readonly PathView[];
  /** A cap on a per-hop fan-out was hit, so a stronger path may exist. */
  truncated: boolean;
  /** The longest path the search allowed. */
  maxHops: number;
  /** The search was limited to some relation types. */
  hasRelationFilter: boolean;
  /** What the strip needs besides the paths. */
  strip: Omit<PathStripProps, 'paths'>;
  /** The path is drawn on the canvas. */
  shown: boolean;
  /** A sentence about nodes the cap kept off the canvas, or `null`. */
  capNotice: string | null;
  /** A coarse pointer. */
  touch: boolean;
  /** Merge the path into the graph, highlight it and fit the camera. */
  onShowOnCanvas: () => void;
  /** Open the picker. */
  onChange: () => void;
  /** Leave path mode. */
  onClose: () => void;
  /** Search again with one more hop. */
  onRaiseHops: () => void;
  /** Search again without the relation filter. */
  onClearRelations: () => void;
  /** Repeat a failed search. */
  onRetry: () => void;
  /** Present on a window that can fold the panel: its state and toggle. */
  collapse?: { collapsed: boolean; onToggle: () => void };
}

/**
 * The panel of path mode.
 *
 * @stability experimental
 */
export function PathPanel(props: PathPanelProps) {
  const { title, status, failure, paths, truncated, maxHops, hasRelationFilter, strip, shown, capNotice, touch, collapse } = props;
  const size = touch ? 44 : undefined;
  const folded = collapse?.collapsed === true;

  let body = null;
  if (status === 'loading' || status === 'idle') {
    body = (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 1 }} role="status">
        <CircularProgress size={18} aria-hidden />
        <Typography variant="body2">Looking for connections</Typography>
      </Box>
    );
  } else if (status === 'error') {
    body = (
      <Alert
        severity={failure?.kind === 'timeout' ? 'warning' : 'error'}
        action={
          failure?.kind === 'not-found' ? undefined : (
            <Button color="inherit" size="small" onClick={props.onRetry} sx={{ minHeight: size }}>
              Retry
            </Button>
          )
        }
      >
        {failure?.message ?? 'Failed to look for a connection'}
        {failure?.kind === 'timeout' && maxHops > 2 && (
          <Box sx={{ mt: 0.5 }}>
            <Button size="small" color="inherit" onClick={props.onChange} sx={{ minHeight: size }}>
              Change the search
            </Button>
          </Box>
        )}
      </Alert>
    );
  } else if (paths.length === 0) {
    body = (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, alignItems: 'flex-start' }}>
        <Typography variant="body1" component="p" sx={{ fontWeight: 600 }}>
          No connection within {maxHops} {maxHops === 1 ? 'hop' : 'hops'}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Nothing in your notes links these two that closely.
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          {maxHops < MAX_PATH_HOPS && (
            <Button variant="outlined" size="small" onClick={props.onRaiseHops} sx={{ minHeight: size }}>
              Look {maxHops + 1} hops out
            </Button>
          )}
          {hasRelationFilter && (
            <Button variant="outlined" size="small" onClick={props.onClearRelations} sx={{ minHeight: size }}>
              Remove relation filters
            </Button>
          )}
        </Box>
      </Box>
    );
  } else {
    body = (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
          <Button variant={shown ? 'outlined' : 'contained'} size="small" onClick={props.onShowOnCanvas} sx={{ minHeight: size }}>
            {shown ? 'Show on canvas again' : 'Show on canvas'}
          </Button>
          {truncated && (
            <Typography variant="caption" color="text.secondary">
              More paths may exist than the ones shown.
            </Typography>
          )}
        </Box>
        {capNotice && (
          <Alert severity="info" sx={{ py: 0 }}>
            {capNotice}
          </Alert>
        )}
        <PathStrip {...strip} paths={paths} />
      </Box>
    );
  }

  return (
    <Box component="section" aria-label={`Connection: ${title}`} sx={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
        <Typography variant="subtitle1" component="h2" noWrap sx={{ fontWeight: 700, flex: 1, minWidth: 0 }} title={title}>
          {title}
        </Typography>
        <Button size="small" startIcon={<EditOutlinedIcon />} onClick={props.onChange} sx={{ minHeight: size, textTransform: 'none' }}>
          Change
        </Button>
        {collapse && (
          <IconButton
            aria-label={collapse.collapsed ? 'Expand the connection panel' : 'Collapse the connection panel'}
            aria-expanded={!collapse.collapsed}
            onClick={collapse.onToggle}
            sx={{ width: 44, height: 44 }}
          >
            {collapse.collapsed ? <ExpandLessIcon /> : <ExpandMoreIcon />}
          </IconButton>
        )}
        <IconButton aria-label="Close the connection" onClick={props.onClose} sx={{ width: 44, height: 44 }}>
          <CloseIcon />
        </IconButton>
      </Box>
      {!folded && body}
    </Box>
  );
}
