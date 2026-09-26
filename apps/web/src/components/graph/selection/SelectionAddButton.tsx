/**
 * "Add to graph" for the current text selection (#368; ontology.md §19).
 *
 *   sm and up  a small button in a `Popper` anchored to the selection's box;
 *   phone      a fixed bottom bar, 48 px, above the bottom navigation — the
 *              native selection handles and the OS's own copy/paste menu
 *              would cover a popper next to the text.
 *
 * `compact` is the caller's page-level `down('sm')` read. A refusal is drawn
 * as the same control, disabled, with its reason: in a tooltip on desktop
 * and as visible text on a phone (a disabled control cannot be hovered and a
 * phone has no hover anyway).
 *
 * Every pointer-down on the control is `preventDefault`ed so pressing it does
 * not collapse the very selection it is about to act on.
 */

import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutlineOutlined';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Popper from '@mui/material/Popper';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useMemo } from 'react';

import type { GraphSelection, SelectionRefusal } from '../../../hooks/useTextSelection';

export interface SelectionAddButtonProps {
  selection: GraphSelection | null;
  refusal: SelectionRefusal | null;
  compact: boolean;
  onAdd: (selection: GraphSelection) => void;
}

/** The fixed bottom navigation's height; the phone bar sits on top of it. */
const BOTTOM_NAV_HEIGHT = 56;

export function SelectionAddButton({ selection, refusal, compact, onAdd }: SelectionAddButtonProps) {
  const rect = selection?.rect ?? refusal?.rect ?? null;
  const anchor = useMemo(
    () => (rect ? { getBoundingClientRect: () => rect, nodeType: 1 } : null),
    [rect],
  );
  if (!selection && !refusal) return null;

  const reason = refusal?.refused ?? null;
  const button = (
    <Button
      size="small"
      variant="contained"
      startIcon={<AddCircleOutlineIcon />}
      disabled={!selection}
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => selection && onAdd(selection)}
      aria-describedby={reason ? 'graph-selection-reason' : undefined}
      sx={{ minHeight: compact ? 40 : 32, whiteSpace: 'nowrap' }}
    >
      Add to graph
    </Button>
  );

  if (compact) {
    return (
      <Paper
        elevation={6}
        data-testid="graph-selection-bar"
        sx={(theme) => ({
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: `calc(${BOTTOM_NAV_HEIGHT}px + env(safe-area-inset-bottom, 0px))`,
          height: 48,
          zIndex: theme.zIndex.appBar + 1,
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          px: 2,
          borderRadius: 0,
        })}
      >
        {button}
        <Typography
          id="graph-selection-reason"
          variant="caption"
          color="text.secondary"
          noWrap
          sx={{ minWidth: 0 }}
        >
          {reason ?? 'Turn the selected text into a row of your draft'}
        </Typography>
      </Paper>
    );
  }

  return (
    <Popper
      open={anchor !== null}
      anchorEl={anchor}
      placement="top"
      sx={(theme) => ({ zIndex: theme.zIndex.appBar - 1 })}
      modifiers={[{ name: 'offset', options: { offset: [0, 8] } }]}
    >
      <Paper elevation={4} sx={{ p: 0.5 }} data-testid="graph-selection-popper">
        {reason ? (
          <Tooltip title={reason} open placement="bottom">
            <Box component="span" sx={{ display: 'inline-flex' }}>
              {button}
              <Box component="span" id="graph-selection-reason" sx={{ display: 'none' }}>
                {reason}
              </Box>
            </Box>
          </Tooltip>
        ) : (
          button
        )}
      </Paper>
    </Popper>
  );
}

export default SelectionAddButton;
