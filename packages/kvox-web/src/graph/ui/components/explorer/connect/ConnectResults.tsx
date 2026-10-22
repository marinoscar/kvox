/**
 * The answer to "what connects these" (GIC-14, #675): the summary sentence, the
 * shared entities and the bridges between the inputs. Drawn inside the inspector
 * (the Selection view, or on its own after a notes entry), so on a phone it sits
 * in the bottom sheet, on a tablet in the overlay and on a desktop in the pane.
 *
 * The bridges are a plain list. When the path strip of the path mode (GIC-13)
 * lands, `BridgeList` is the one place that swaps to it.
 */

import CloseIcon from '@mui/icons-material/Close';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import { Link as RouterLink } from 'react-router-dom';

import { TypeGlyph } from '../inspector/TypeGlyph.js';
import { bridgeRows, sharedRows, summarySentence } from './connectModel.js';
import type { GraphConnectResponse } from '../../../../headless/clients/graph.js';

/**
 * Props of {@link ConnectResults}.
 *
 * @stability experimental
 */
export interface ConnectResultsProps {
  /** The answer, or `null` while the first request runs or after it failed. */
  result: GraphConnectResponse | null;
  /** A request is in flight. */
  loading: boolean;
  /** A message when the request failed. */
  error: string | null;
  /** Asks again after a failure. */
  onRetry?: () => void;
  /** Turns a type key into its label. */
  typeLabel: (type: string) => string;
  /** A coarse pointer: rows get 44px targets. */
  touch: boolean;
  /** Select a shared entity on the canvas (when it is drawn). */
  onSelectNode: (id: string) => void;
  /** Ring a bridge's nodes on the canvas. */
  onShowBridge: (nodeIds: string[]) => void;
  /** Dismiss the results (clears the rings). */
  onClose: () => void;
}

/**
 * The summary, the shared list and the bridges.
 *
 * @stability experimental
 */
export function ConnectResults(props: ConnectResultsProps) {
  const { result, loading, error, onRetry, typeLabel, touch, onSelectNode, onShowBridge, onClose } = props;
  const mode = useTheme().palette.mode;
  const height = touch ? 44 : 32;
  const rows = result ? sharedRows(result) : [];
  const bridges = result ? bridgeRows(result) : [];

  return (
    <Box role="region" aria-label="What connects these" sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
        <Typography variant="h6" component="h2" sx={{ flex: 1, minWidth: 0 }}>
          {result ? summarySentence(result, typeLabel) : 'Finding what connects these'}
        </Typography>
        <IconButton
          size="small"
          aria-label="Close connections"
          onClick={onClose}
          edge="end"
          sx={{ minWidth: touch ? 44 : undefined, minHeight: touch ? 44 : undefined }}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>

      {loading && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }} role="status">
          <CircularProgress size={18} aria-label="Finding connections" />
          <Typography variant="body2" color="text.secondary">
            Looking across {result ? result.inputs.length : 'the'} inputs…
          </Typography>
        </Box>
      )}

      {error && (
        <Alert
          severity="error"
          action={
            onRetry ? (
              <Button color="inherit" size="small" onClick={onRetry}>
                Retry
              </Button>
            ) : undefined
          }
        >
          {error}
        </Alert>
      )}

      {result && result.inputs.length > 0 && (
        <Typography variant="caption" color="text.secondary">
          Across {result.inputs.map((input) => input.title || 'Untitled').join(', ')}
        </Typography>
      )}

      {result && rows.length > 0 && (
        <Box component="section" aria-label="Shared by these">
          <Typography variant="subtitle2" component="h3">
            In common
          </Typography>
          <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
            {rows.map((row) => (
              <li key={row.entityId}>
                <ButtonBase
                  onClick={() => onSelectNode(row.entityId)}
                  aria-label={`${row.label}, ${row.type ? typeLabel(row.type) : 'entity'}, in ${row.coverage} of ${result.inputs.length}`}
                  sx={{
                    width: '100%',
                    justifyContent: 'flex-start',
                    gap: 1,
                    px: 0.5,
                    minHeight: height,
                    borderRadius: 1,
                    textAlign: 'left',
                    '&:hover': { bgcolor: 'action.hover' },
                  }}
                >
                  {row.type && <TypeGlyph type={row.type} mode={mode} size={20} />}
                  <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>
                    {row.label}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" aria-hidden sx={{ whiteSpace: 'nowrap' }}>
                    {row.coverage} of {result.inputs.length} · {row.mentionCount}×
                  </Typography>
                </ButtonBase>
              </li>
            ))}
          </Box>
        </Box>
      )}

      {result && rows.length === 0 && !loading && (
        <Typography variant="body2" color="text.secondary">
          These have no entity in common
          {bridges.length > 0 ? ', but they are linked through other things.' : '.'}
        </Typography>
      )}

      {result && bridges.length > 0 && (
        <Box component="section" aria-label="Bridges between them">
          <Typography variant="subtitle2" component="h3">
            Bridges
          </Typography>
          <BridgeList bridges={bridges} onShowBridge={onShowBridge} height={height} />
        </Box>
      )}

      {result?.truncated && (
        <Typography variant="caption" color="text.secondary">
          Showing the strongest results; more exist.
        </Typography>
      )}
    </Box>
  );
}

/** The bridges, one row each: where it starts and ends, and the nodes it passes through. */
function BridgeList(props: {
  bridges: ReturnType<typeof bridgeRows>;
  onShowBridge: (nodeIds: string[]) => void;
  height: number;
}) {
  return (
    <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
      {props.bridges.map((bridge, index) => (
        <li key={`${bridge.path.fromInput}:${bridge.path.toInput}:${index}`}>
          <ButtonBase
            onClick={() => props.onShowBridge(bridge.path.nodeIds)}
            aria-label={`Show on canvas: ${bridge.labels.join(' to ')}, between ${bridge.fromTitle || 'one input'} and ${bridge.toTitle || 'another'}`}
            sx={{
              width: '100%',
              display: 'block',
              textAlign: 'left',
              px: 0.5,
              py: 0.5,
              minHeight: props.height,
              borderRadius: 1,
              '&:hover': { bgcolor: 'action.hover' },
            }}
          >
            <Typography variant="body2" component="span" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.5 }}>
              {bridge.labels.map((label, i) => (
                <Box key={`${label}:${i}`} component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                  {i > 0 && <ArrowForwardIcon sx={{ fontSize: 14 }} color="disabled" aria-hidden />}
                  {label}
                </Box>
              ))}
            </Typography>
            <Typography variant="caption" color="text.secondary" component="span" sx={{ display: 'block' }}>
              {bridge.fromTitle || 'Untitled'} and {bridge.toTitle || 'Untitled'}
            </Typography>
          </ButtonBase>
        </li>
      ))}
    </Box>
  );
}

/**
 * Props of {@link FindConnectionsButton}.
 *
 * @stability experimental
 */
export interface FindConnectionsButtonProps {
  /** The ids that would be sent: the entity nodes among the marked ones. */
  entityIds: readonly string[];
  /** The most entities one request accepts. */
  max: number;
  /** A request is in flight. */
  busy: boolean;
  /** Ask. */
  onFind: (entityIds: string[]) => void;
  /** A coarse pointer. */
  touch: boolean;
}

/**
 * "Find connections", the Selection view's extra action: enabled for two to {@link FindConnectionsButtonProps.max} entities.
 *
 * @stability experimental
 */
export function FindConnectionsButton({ entityIds, max, busy, onFind, touch }: FindConnectionsButtonProps) {
  const tooFew = entityIds.length < 2;
  const tooMany = entityIds.length > max;
  return (
    <Button
      variant="outlined"
      size="small"
      onClick={() => onFind([...entityIds])}
      disabled={busy || tooFew || tooMany}
      sx={{ minHeight: touch ? 44 : undefined }}
      title={
        tooFew
          ? 'Select at least two entities'
          : tooMany
            ? `Select at most ${max} entities`
            : 'Find what these have in common'
      }
    >
      {busy ? 'Finding…' : 'Find connections'}
    </Button>
  );
}

/**
 * Props of {@link ConnectNotesNotice}.
 *
 * @stability experimental
 */
export interface ConnectNotesNoticeProps {
  /** `empty`: the notes touch no reviewed entity yet. `error`: the request failed or a note is not readable. */
  kind: 'empty' | 'error';
  /** The failure message, for `error`. */
  message: string | null;
}

/**
 * What the explorer shows instead of a canvas when a notes entry has nothing to draw.
 *
 * @stability experimental
 */
export function ConnectNotesNotice({ kind, message }: ConnectNotesNoticeProps) {
  return (
    <Paper variant="outlined" sx={{ p: 3, textAlign: 'center' }}>
      <Typography variant="h6" component="h2" gutterBottom>
        {kind === 'empty' ? 'Nothing from these notes is in your graph yet' : "Couldn't connect these notes"}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {kind === 'empty'
          ? 'Review the connected knowledge extracted from them first; reviewed people, projects and topics show up here.'
          : (message ?? 'Try again in a moment.')}
      </Typography>
      <Button component={RouterLink} to="/notes" variant="contained">
        Back to notes
      </Button>
    </Paper>
  );
}
