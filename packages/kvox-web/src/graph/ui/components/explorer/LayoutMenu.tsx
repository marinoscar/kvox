/**
 * `LayoutMenu` — the explorer's layout control (GIC-07, #668): choose Force,
 * Concentric by hop or Static, re-lay out everything, or release the pins.
 *
 * Presentational: it holds only whether the menu is open. It imports no sigma
 * and no layout code, so the page can render it without the canvas chunk.
 */

import AccountTreeIcon from '@mui/icons-material/AccountTree';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import { useId, useState, type ReactElement } from 'react';

import type { CanvasLayout } from './layout/useCanvasLayout.js';

/** The layouts in menu order, with their labels. */
export const LAYOUT_OPTIONS: ReadonlyArray<{ value: CanvasLayout; label: string; hint: string }> = [
  { value: 'forceatlas', label: 'Force', hint: 'New nodes settle; the rest stay put' },
  { value: 'concentric', label: 'Concentric by hop', hint: 'Rings by distance from the seed' },
  { value: 'static', label: 'Static', hint: 'Keep every position as it is' },
];

/**
 * Props of `LayoutMenu`.
 *
 * @stability experimental
 */
export interface LayoutMenuProps {
  /** The layout in force. */
  layout: CanvasLayout;
  /** Called with the layout the person chose. */
  onLayoutChange: (layout: CanvasLayout) => void;
  /** Called by "Re-layout all". */
  onRelayoutAll: () => void;
  /** How many nodes are pinned. */
  pinnedCount: number;
  /** Called by "Unpin all". */
  onUnpinAll: () => void;
  /** Disables the whole control (list view). */
  disabled?: boolean;
}

/**
 * The menu entries of the layout control, for a host that has its own menu
 * (the toolbar's overflow menu on a phone). MUI's `Menu` takes an array, not a fragment.
 *
 * @param props - The layout, its change handler and the pin counters.
 * @param close - Closes the host menu; called before a choice is applied.
 * @returns The entries, with their keys.
 */
export function layoutMenuItems(
  props: Pick<LayoutMenuProps, 'layout' | 'onLayoutChange' | 'onRelayoutAll' | 'pinnedCount' | 'onUnpinAll'>,
  close: () => void,
): ReactElement[] {
  const { layout, onLayoutChange, onRelayoutAll, pinnedCount, onUnpinAll } = props;
  return [
    ...LAYOUT_OPTIONS.map((option) => (
      <MenuItem
        key={option.value}
        role="menuitemradio"
        aria-checked={layout === option.value}
        selected={layout === option.value}
        onClick={() => {
          close();
          if (option.value !== layout) onLayoutChange(option.value);
        }}
      >
        <ListItemText primary={option.label} secondary={option.hint} />
      </MenuItem>
    )),
    <Divider key="layout-divider" />,
    <MenuItem
      key="relayout"
      disabled={layout === 'static'}
      onClick={() => {
        close();
        onRelayoutAll();
      }}
    >
      <ListItemText primary="Re-layout all" secondary="Move every node that is not pinned" />
    </MenuItem>,
    <MenuItem
      key="unpin"
      disabled={pinnedCount === 0}
      onClick={() => {
        close();
        onUnpinAll();
      }}
    >
      <ListItemText
        primary={pinnedCount > 0 ? `Unpin all (${pinnedCount})` : 'Unpin all'}
        secondary="Select a node and press P to pin or unpin it"
      />
    </MenuItem>,
  ];
}

/**
 * A button that opens the layout menu.
 *
 * @param props - The layout, its change handler and the pin counters.
 * @returns The control.
 */
export function LayoutMenu(props: LayoutMenuProps) {
  const { layout, disabled } = props;
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const menuId = useId();
  const close = () => setAnchor(null);

  return (
    <>
      <Button
        size="small"
        variant="outlined"
        startIcon={<AccountTreeIcon />}
        aria-haspopup="menu"
        aria-expanded={anchor ? 'true' : undefined}
        aria-controls={anchor ? menuId : undefined}
        disabled={disabled}
        onClick={(event) => setAnchor(event.currentTarget)}
        sx={{ bgcolor: 'background.paper' }}
      >
        Layout
      </Button>
      <Menu id={menuId} anchorEl={anchor} open={Boolean(anchor)} onClose={close} aria-label="Layout">
        {layoutMenuItems(props, close)}
      </Menu>
    </>
  );
}
