/**
 * `ExplorerContextMenu` — the menu of a node: opened by a long-press on touch
 * and a right-click with a pointer (GIC-08, #669; epic #661).
 *
 * Today it carries what the explorer can already do (Open details, Expand,
 * Pin, Hide, Make seed). "Path to…" (GIC-13) and "Ask" (GIC-17) plug in
 * through `extraItems`; they are other stories' content and not drawn here.
 */

import Divider from '@mui/material/Divider';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import type { ReactNode } from 'react';

/**
 * The node a menu is open for, and where.
 *
 * @stability experimental
 */
export interface ExplorerContextTarget {
  id: string;
  label: string;
  /** Anchor in client coordinates. */
  clientX: number;
  clientY: number;
  isSeed: boolean;
  pinned: boolean;
}

/**
 * Props of {@link ExplorerContextMenu}.
 *
 * @stability experimental
 */
export interface ExplorerContextMenuProps {
  target: ExplorerContextTarget | null;
  atCap: boolean;
  onClose: () => void;
  onOpen: (id: string) => void;
  onExpand: (id: string) => void;
  onPin: (id: string) => void;
  onHide: (id: string) => void;
  onMakeSeed: (id: string) => void;
  /** More items from later stories (Path to…, Ask); each is a `MenuItem` that calls `onClose` itself. */
  extraItems?: ReactNode;
}

/**
 * The context menu of one node.
 *
 * @stability experimental
 */
export function ExplorerContextMenu(props: ExplorerContextMenuProps) {
  const { target, atCap, onClose, onOpen, onExpand, onPin, onHide, onMakeSeed, extraItems } = props;
  const run = (action: (id: string) => void) => () => {
    if (!target) return;
    action(target.id);
    onClose();
  };
  return (
    <Menu
      open={target !== null}
      onClose={onClose}
      anchorReference="anchorPosition"
      anchorPosition={target ? { top: target.clientY, left: target.clientX } : undefined}
      slotProps={{ list: { 'aria-label': target ? `Actions for ${target.label}` : 'Node actions' } }}
    >
      <MenuItem onClick={run(onOpen)}>
        <ListItemText>Open details</ListItemText>
      </MenuItem>
      <MenuItem onClick={run(onExpand)} disabled={atCap}>
        <ListItemText secondary={atCap ? 'Node limit reached' : undefined}>Expand</ListItemText>
      </MenuItem>
      <MenuItem onClick={run(onPin)}>
        <ListItemText>{target?.pinned ? 'Unpin' : 'Pin'}</ListItemText>
      </MenuItem>
      {target && !target.isSeed && <MenuItem onClick={run(onHide)}>Hide</MenuItem>}
      {target && !target.isSeed && <MenuItem onClick={run(onMakeSeed)}>Make seed</MenuItem>}
      {extraItems ? <Divider component="li" /> : null}
      {extraItems}
    </Menu>
  );
}
