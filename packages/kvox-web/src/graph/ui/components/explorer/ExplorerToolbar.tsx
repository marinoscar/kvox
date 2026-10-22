/**
 * `ExplorerToolbar` — the top bar of the Insight Canvas: title, the view
 * controls and the node count (#374; spec §22.2; reshaped by GIC-08, #669).
 *
 * The FILTERS moved to `ExplorerFilters` (the shell's `facets` slot). What is
 * left here is how the graph is viewed:
 *
 *   - expanded and medium: Layout (GIC-07), Fit, Reset, List view and the count, inline;
 *   - compact (phone): the title, the "Select" toggle (touch), the count and one
 *     overflow menu (Fit, Reset, List view, and the layout choices), so the bar never wraps.
 *
 * "Select" is the touch replacement for shift-click and lasso: with it on, a
 * tap marks a node instead of previewing or opening it.
 */

import CenterFocusStrongIcon from '@mui/icons-material/CenterFocusStrong';
import CheckBoxOutlinedIcon from '@mui/icons-material/CheckBoxOutlined';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import ViewListIcon from '@mui/icons-material/ViewList';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Divider from '@mui/material/Divider';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Skeleton from '@mui/material/Skeleton';
import ToggleButton from '@mui/material/ToggleButton';
import Typography from '@mui/material/Typography';
import { useState, type ReactNode } from 'react';

import { EXPLORER_NODE_CAP } from './explorerModel.js';
import { LayoutMenu, layoutMenuItems, type LayoutMenuProps } from './LayoutMenu.js';
import type { InputModality } from './shell/useInputModality.js';
import type { WindowClass } from './shell/useWindowClass.js';

/**
 * Props of {@link ExplorerToolbar}.
 *
 * @stability experimental
 */
export interface ExplorerToolbarProps {
  /** The heading and anything that belongs beside it. */
  title: ReactNode;
  windowClass: WindowClass;
  inputModality: InputModality;
  onFit: () => void;
  onReset: () => void;
  listView: boolean;
  /** Without WebGL the list is the only view: the toggle is disabled on. */
  listViewForced: boolean;
  onToggleListView: () => void;
  nodeCount: number;
  /** The cap in force (the budget's); defaults to `EXPLORER_NODE_CAP`. */
  nodeCap?: number;
  /** "Select" mode (touch): a tap marks nodes. */
  selectMode: boolean;
  onToggleSelectMode: () => void;
  /** Nodes marked in Select mode. */
  markedCount: number;
  onClearMarked: () => void;
  /** The path-mode button, "Connect A and B" (GIC-13). */
  connectAction?: ReactNode;
  /** The layout control (GIC-07): inline when roomy, inside the overflow menu on a phone. Omitted: none. */
  layoutControl?: Omit<LayoutMenuProps, 'disabled'>;
  disabled?: boolean;
}

/**
 * The explorer's top bar: title, view controls, Select mode and the node count; collapses its controls into one menu on a phone.
 *
 * @stability experimental
 */
export function ExplorerToolbar(props: ExplorerToolbarProps) {
  const {
    title,
    windowClass,
    inputModality,
    onFit,
    onReset,
    listView,
    listViewForced,
    onToggleListView,
    nodeCount,
    nodeCap = EXPLORER_NODE_CAP,
    selectMode,
    onToggleSelectMode,
    markedCount,
    onClearMarked,
    connectAction,
    layoutControl,
    disabled,
  } = props;
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const compact = windowClass === 'compact';
  const touch = inputModality === 'touch';

  const count = (
    <Typography
      variant="body2"
      color="text.secondary"
      sx={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}
      aria-label={`${nodeCount} of ${nodeCap} nodes`}
    >
      {nodeCount} / {nodeCap}
    </Typography>
  );

  const selectToggle = touch && !listView && (
    <ToggleButton
      value="select"
      size="small"
      selected={selectMode}
      aria-pressed={selectMode}
      onChange={onToggleSelectMode}
      disabled={disabled}
      sx={{ textTransform: 'none', px: 1.25, minHeight: 44, whiteSpace: 'nowrap' }}
    >
      <CheckBoxOutlinedIcon fontSize="small" sx={{ mr: 0.5 }} />
      Select
    </ToggleButton>
  );

  const marked = markedCount > 0 && (
    <Chip
      size="small"
      color="primary"
      label={`${markedCount} selected`}
      onDelete={onClearMarked}
      aria-label={`${markedCount} selected. Press delete to clear the selection.`}
    />
  );

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0, flexWrap: 'wrap' }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, minWidth: 0, flex: '1 1 auto' }}>{title}</Box>
      {marked}
      {selectToggle}
      {connectAction}
      {compact ? (
        <>
          {count}
          <IconButton
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={Boolean(menuAnchor)}
            onClick={(event) => setMenuAnchor(event.currentTarget)}
            sx={{ width: 44, height: 44 }}
          >
            <MoreVertIcon />
          </IconButton>
          <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}>
            <MenuItem
              disabled={listView}
              onClick={() => {
                setMenuAnchor(null);
                onFit();
              }}
            >
              <ListItemIcon>
                <CenterFocusStrongIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>Fit</ListItemText>
            </MenuItem>
            <MenuItem
              disabled={disabled}
              onClick={() => {
                setMenuAnchor(null);
                onReset();
              }}
            >
              <ListItemIcon>
                <RestartAltIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>Reset</ListItemText>
            </MenuItem>
            <MenuItem
              disabled={listViewForced}
              selected={listView}
              onClick={() => {
                setMenuAnchor(null);
                onToggleListView();
              }}
            >
              <ListItemIcon>
                <ViewListIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>{listView ? 'Graph view' : 'List view'}</ListItemText>
            </MenuItem>
            {layoutControl && !listView && [
              <Divider key="layout-top" />,
              ...layoutMenuItems(layoutControl, () => setMenuAnchor(null)),
            ]}
          </Menu>
        </>
      ) : (
        <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
          {layoutControl && <LayoutMenu {...layoutControl} disabled={listView} />}
          <Button size="small" startIcon={<CenterFocusStrongIcon />} onClick={onFit} disabled={listView}>
            Fit
          </Button>
          <Button size="small" startIcon={<RestartAltIcon />} onClick={onReset} disabled={disabled}>
            Reset
          </Button>
          <ToggleButton
            value="list"
            size="small"
            selected={listView}
            aria-pressed={listView}
            onChange={onToggleListView}
            disabled={listViewForced}
            sx={{ textTransform: 'none', px: 1, py: 0.25, whiteSpace: 'nowrap' }}
          >
            <ViewListIcon fontSize="small" sx={{ mr: 0.5 }} />
            List view
          </ToggleButton>
          <Box sx={{ ml: 0.5 }}>{count}</Box>
        </Box>
      )}
    </Box>
  );
}

/** The bar's shape while the ontology and first slice load. */
export function ExplorerToolbarSkeleton() {
  return (
    <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }} aria-hidden>
      <Skeleton variant="rounded" width={72} height={32} />
      <Box sx={{ flex: 1 }} />
      <Skeleton variant="rounded" width={180} height={32} />
    </Box>
  );
}
