/**
 * `ExplorerSidePanel` — what the selected node or edge is, and what can be
 * done with it (#374; spec §22.2).
 *
 * A right-hand `Paper` from `sm` up; a bottom `Drawer` on a phone. That
 * `down('sm')` is a PAGE-LEVEL read deciding where one page puts one panel —
 * not a sixth app-chrome breakpoint gate (CLAUDE.md, Settings UI Pattern rule
 * 5: the `LibraryPageFrame` precedent).
 *
 * The edge view shows the relation's validity to the precision it is known
 * to ("2019 – Mar 2026") and its confidence, and points at the entity page's
 * timeline for its evidence rather than rendering citations on the canvas.
 */

import CloseIcon from '@mui/icons-material/Close';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import { Link as RouterLink } from 'react-router-dom';

import type { GraphValidRange } from '../../../services/graph';
import { formatPrecisionDate } from '../../../utils/graphDisplay';

export const CAP_TOOLTIP = 'Node limit reached — hide some nodes first';

export interface NodeSelection {
  kind: 'node';
  id: string;
  label: string;
  typeLabel: string;
  nodeKind: 'entity' | 'item';
  degree: number;
  status: string | null;
  occurredAt: string | null;
  isSeed: boolean;
  expanded: boolean;
}

export interface EdgeSelection {
  kind: 'edge';
  id: string;
  relationLabel: string;
  fromLabel: string;
  /** The entity end whose page carries this relation's evidence; null if neither end is an entity. */
  pageId: string | null;
  pageLabel: string | null;
  toLabel: string;
  valid: GraphValidRange | null;
  confidence: number | null;
  virtual: boolean;
}

export type ExplorerSelection = NodeSelection | EdgeSelection;

export interface ExplorerSidePanelProps {
  selection: ExplorerSelection | null;
  atCap: boolean;
  expanding: boolean;
  onExpand: (id: string) => void;
  onHide: (id: string) => void;
  onMakeSeed: (id: string) => void;
  onClose: () => void;
}

/** "2019 – Mar 2026", "Since Sep 2026", "Until 2021", or null when undated. */
export function formatValidity(valid: GraphValidRange | null): string | null {
  if (!valid || (!valid.from && !valid.to)) return null;
  const from = valid.from ? formatPrecisionDate(valid.from, valid.precision) : null;
  const to = valid.to ? formatPrecisionDate(valid.to, valid.precision) : null;
  if (from && to) return `${from} – ${to}`;
  if (from) return `Since ${from}`;
  return `Until ${to}`;
}

export function ExplorerSidePanel(props: ExplorerSidePanelProps) {
  const { selection, onClose } = props;
  const theme = useTheme();
  const isCompactWindow = useMediaQuery(theme.breakpoints.down('sm'));

  if (isCompactWindow) {
    return (
      <Drawer
        anchor="bottom"
        open={selection !== null}
        onClose={onClose}
        slotProps={{
          paper: {
            sx: { borderTopLeftRadius: 12, borderTopRightRadius: 12, maxHeight: '60vh' },
            'aria-label': selection ? panelTitle(selection) : 'Selection',
          },
        }}
      >
        {selection && <PanelBody {...props} selection={selection} />}
      </Drawer>
    );
  }

  if (!selection) return null;
  return (
    <Paper
      variant="outlined"
      component="aside"
      aria-label={panelTitle(selection)}
      sx={{
        position: 'absolute',
        top: 12,
        right: 12,
        width: 300,
        maxWidth: 'calc(100% - 24px)',
        maxHeight: 'calc(100% - 24px)',
        overflowY: 'auto',
        zIndex: 2,
      }}
    >
      <PanelBody {...props} selection={selection} />
    </Paper>
  );
}

function panelTitle(selection: ExplorerSelection): string {
  return selection.kind === 'node' ? selection.label : selection.relationLabel;
}

function PanelBody({
  selection,
  atCap,
  expanding,
  onExpand,
  onHide,
  onMakeSeed,
  onClose,
}: ExplorerSidePanelProps & { selection: ExplorerSelection }) {
  return (
    <Box sx={{ p: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, mb: 1 }}>
        <Typography variant="h6" component="h2" sx={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>
          {panelTitle(selection)}
        </Typography>
        <IconButton size="small" aria-label="Close" onClick={onClose} edge="end">
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>
      {selection.kind === 'node' ? (
        <NodeBody
          selection={selection}
          atCap={atCap}
          expanding={expanding}
          onExpand={onExpand}
          onHide={onHide}
          onMakeSeed={onMakeSeed}
        />
      ) : (
        <EdgeBody selection={selection} />
      )}
    </Box>
  );
}

function NodeBody({
  selection,
  atCap,
  expanding,
  onExpand,
  onHide,
  onMakeSeed,
}: {
  selection: NodeSelection;
  atCap: boolean;
  expanding: boolean;
  onExpand: (id: string) => void;
  onHide: (id: string) => void;
  onMakeSeed: (id: string) => void;
}) {
  const expandDisabled = atCap || expanding;
  const expandButton = (
    <Button
      variant="contained"
      size="small"
      onClick={() => onExpand(selection.id)}
      disabled={expandDisabled}
    >
      {expanding ? 'Expanding…' : selection.expanded ? 'Expand again' : 'Expand'}
    </Button>
  );
  return (
    <>
      <Stack direction="row" spacing={1} sx={{ mb: 1.5, flexWrap: 'wrap', rowGap: 1 }}>
        <Chip size="small" label={selection.typeLabel} />
        {selection.isSeed && <Chip size="small" variant="outlined" label="Starting point" />}
        {selection.status && <Chip size="small" variant="outlined" label={selection.status} />}
      </Stack>
      <Typography variant="body2" color="text.secondary">
        {selection.degree === 1 ? '1 connection' : `${selection.degree} connections`}
      </Typography>
      {selection.nodeKind === 'item' && selection.occurredAt && (
        <Typography variant="body2" color="text.secondary">
          {formatPrecisionDate(selection.occurredAt, 'day')}
        </Typography>
      )}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 2 }}>
        {atCap ? (
          <Tooltip title={CAP_TOOLTIP}>
            {/* A disabled button fires no events; the span carries the tooltip. */}
            <span>{expandButton}</span>
          </Tooltip>
        ) : (
          expandButton
        )}
        {selection.nodeKind === 'entity' && (
          <Button
            size="small"
            variant="outlined"
            component={RouterLink}
            to={`/graph/entities/${encodeURIComponent(selection.id)}`}
          >
            Open page
          </Button>
        )}
        {!selection.isSeed && (
          <>
            <Button size="small" onClick={() => onHide(selection.id)}>
              Hide
            </Button>
            <Button size="small" onClick={() => onMakeSeed(selection.id)}>
              Make seed
            </Button>
          </>
        )}
      </Box>
    </>
  );
}

function EdgeBody({ selection }: { selection: EdgeSelection }) {
  const validity = formatValidity(selection.valid);
  return (
    <>
      <Typography variant="body2" sx={{ mb: 1 }}>
        {selection.fromLabel} → {selection.toLabel}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {validity ?? 'No dates recorded'}
      </Typography>
      {selection.confidence !== null && (
        <Typography variant="body2" color="text.secondary">
          Confidence {Math.round(selection.confidence * 100)}%
        </Typography>
      )}
      {selection.virtual && (
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
          Derived from the item itself.
        </Typography>
      )}
      {selection.pageId && (
        <Button
          size="small"
          sx={{ mt: 2 }}
          component={RouterLink}
          to={`/graph/entities/${encodeURIComponent(selection.pageId)}`}
        >
          Evidence on {selection.pageLabel}'s page
        </Button>
      )}
    </>
  );
}
