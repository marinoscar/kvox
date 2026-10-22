/**
 * The inspector's view of several marked nodes (GIC-11, #672): how many of each
 * type, the neighbours they share, and the actions that apply to all of them.
 * "Find connections" (GIC-14) and "Ask about selection" (GIC-17) plug in through
 * `extraActions`; this story draws neither.
 */

import CloseIcon from '@mui/icons-material/Close';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import type { ReactNode } from 'react';

import { CAP_TOOLTIP, type SelectionSummary } from './inspectorModel.js';
import { TypeGlyph } from './TypeGlyph.js';

/**
 * Props of {@link SelectionView}.
 *
 * @stability experimental
 */
export interface SelectionViewProps {
  /** The summary of the marked nodes. */
  summary: SelectionSummary;
  /** The type label function. */
  typeLabel: (type: string) => string;
  /** The node cap is reached: expanding is refused. */
  atCap: boolean;
  /** An expand is in flight. */
  busy: boolean;
  /** Expand every marked node, one after the other. */
  onExpandAll: (ids: string[]) => void;
  /** Hide every marked node that is not a seed. */
  onHideAll: (ids: string[]) => void;
  /** Select one of the shared neighbours. */
  onSelectNode: (id: string) => void;
  /** Unmark everything and close. */
  onClose: () => void;
  /** More actions from later stories (Find connections, Ask about selection). */
  extraActions?: ReactNode;
  /** A coarse pointer. */
  touch: boolean;
}

/**
 * The Selection view: counts by type, shared neighbours, Expand all and Hide.
 *
 * @stability experimental
 */
export function SelectionView(props: SelectionViewProps) {
  const { summary, typeLabel, atCap, busy, onExpandAll, onHideAll, onSelectNode, onClose, extraActions, touch } = props;
  const mode = useTheme().palette.mode;
  const height = touch ? 44 : undefined;
  const hideable = summary.ids.length - summary.seedCount;
  const expandAll = (
    <Button
      variant="contained"
      size="small"
      onClick={() => onExpandAll(summary.ids)}
      disabled={atCap || busy}
      sx={{ minHeight: height }}
    >
      {busy ? 'Expanding…' : 'Expand all'}
    </Button>
  );
  return (
    <Box role="group" aria-label="Selection" sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
        <Typography variant="h6" component="h2" sx={{ flex: 1, minWidth: 0 }}>
          {summary.ids.length} nodes selected
        </Typography>
        <IconButton size="small" aria-label="Close" onClick={onClose} edge="end" sx={{ minWidth: height, minHeight: height }}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
        {atCap ? (
          <Tooltip title={CAP_TOOLTIP}>
            <span>{expandAll}</span>
          </Tooltip>
        ) : (
          expandAll
        )}
        <Button
          size="small"
          onClick={() => onHideAll(summary.ids)}
          disabled={hideable <= 0}
          sx={{ minHeight: height }}
        >
          Hide
        </Button>
        {extraActions}
      </Box>
      <Box component="ul" aria-label="Selected by type" sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexWrap: 'wrap', gap: 1 }}>
        {summary.byType.map(({ type, count }) => (
          <li key={type}>
            <Chip
              icon={<TypeGlyph type={type} mode={mode} size={20} />}
              label={`${typeLabel(type)} ${count}`}
              variant="outlined"
            />
          </li>
        ))}
      </Box>
      {summary.shared.length > 0 && (
        <Box component="section" aria-label="Shared neighbours">
          <Typography variant="subtitle2" component="h3">
            Shared neighbours
          </Typography>
          <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
            {summary.shared.map((neighbour) => (
              <li key={neighbour.id}>
                <ButtonBase
                  onClick={() => onSelectNode(neighbour.id)}
                  sx={{
                    width: '100%',
                    justifyContent: 'space-between',
                    px: 0.5,
                    minHeight: touch ? 44 : 32,
                    borderRadius: 1,
                    '&:hover': { bgcolor: 'action.hover' },
                  }}
                  aria-label={`${neighbour.label}, next to ${neighbour.count} of the selected nodes`}
                >
                  <Typography variant="body2" noWrap>
                    {neighbour.label}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" aria-hidden>
                    {neighbour.count}
                  </Typography>
                </ButtonBase>
              </li>
            ))}
          </Box>
        </Box>
      )}
    </Box>
  );
}
