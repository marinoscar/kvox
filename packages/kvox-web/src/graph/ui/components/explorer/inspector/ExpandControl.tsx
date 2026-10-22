/**
 * `ExpandControl` — the inspector's Expand action and its "by type" menu
 * (GIC-11, #672; the Bloom "selective expand" pattern).
 *
 * A split button: "Expand" adds every neighbour (as before); the chevron opens
 * a menu of the node's relation types and of the entity types at the other end,
 * each with the count the API reports (`counts.relationsByType`,
 * `counts.relationsByNeighborType`). Choosing one asks the API for ONLY that
 * relation's or type's neighbours (`expandGraph({ relationTypes | types })`).
 * Without the counts (an older API, an item) there is no chevron.
 */

import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import Button from '@mui/material/Button';
import ButtonGroup from '@mui/material/ButtonGroup';
import ListSubheader from '@mui/material/ListSubheader';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Tooltip from '@mui/material/Tooltip';
import { useId, useRef, useState } from 'react';

import type { ExpandOnly } from '../../../hooks/useGraphExplorer.js';
import { CAP_TOOLTIP, type ExpandChoice, type ExpandMenuModel } from './inspectorModel.js';

/**
 * Props of {@link ExpandControl}.
 *
 * @stability experimental
 */
export interface ExpandControlProps {
  /** The node to expand. */
  nodeId: string;
  /** The node's label, for the menu's accessible name. */
  label: string;
  /** The menu's choices; empty lists mean no menu. */
  model: ExpandMenuModel;
  /** The node cap is reached: expanding is refused. */
  atCap: boolean;
  /** An expand of this node is in flight. */
  expanding: boolean;
  /** An expand has already run from this node. */
  expanded: boolean;
  /** Asks the explorer to expand, optionally narrowed. */
  onExpand: (id: string, only?: ExpandOnly) => void;
  /** A coarse pointer: controls are at least 44px tall. */
  touch: boolean;
}

function ChoiceItem({ choice, onPick }: { choice: ExpandChoice; onPick: () => void }) {
  return (
    <MenuItem
      onClick={onPick}
      disabled={choice.disabled}
      aria-label={choice.count === null ? choice.label : `${choice.label} (${choice.count})`}
      sx={{ gap: 2, justifyContent: 'space-between' }}
    >
      <span>{choice.label}</span>
      {choice.count !== null && <span aria-hidden>{choice.count}</span>}
    </MenuItem>
  );
}

/**
 * The Expand split button of the inspector.
 *
 * @stability experimental
 */
export function ExpandControl(props: ExpandControlProps) {
  const { nodeId, label, model, atCap, expanding, expanded, onExpand, touch } = props;
  const anchor = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const hasMenu = model.byRelation.length > 0 || model.byType.length > 0;
  const disabled = atCap || expanding;
  const height = touch ? 44 : undefined;

  const pick = (only?: ExpandOnly) => {
    setOpen(false);
    onExpand(nodeId, only);
  };

  const main = (
    <Button variant="contained" size="small" onClick={() => onExpand(nodeId)} disabled={disabled} sx={{ minHeight: height }}>
      {expanding ? 'Expanding…' : expanded ? 'Expand again' : 'Expand'}
    </Button>
  );
  const group = (
    <ButtonGroup ref={anchor} variant="contained" size="small" disabled={disabled} aria-label={`Expand ${label}`}>
      {main}
      {hasMenu && (
        <Button
          aria-label="Expand by type"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => setOpen(true)}
          sx={{ minHeight: height, px: 0.5 }}
        >
          <ArrowDropDownIcon fontSize="small" />
        </Button>
      )}
    </ButtonGroup>
  );
  return (
    <>
      {atCap ? (
        <Tooltip title={CAP_TOOLTIP}>
          {/* A disabled button fires no events; the span carries the tooltip. */}
          <span>{group}</span>
        </Tooltip>
      ) : (
        group
      )}
      {hasMenu && (
        <Menu id={menuId} open={open} anchorEl={anchor.current} onClose={() => setOpen(false)}>
          {model.byRelation.length > 0 && <ListSubheader>By relation</ListSubheader>}
          {model.byRelation.map((choice) => (
            <ChoiceItem key={`r:${choice.key}`} choice={choice} onPick={() => pick({ relationTypes: [choice.key] })} />
          ))}
          {model.byType.length > 0 && <ListSubheader>By entity type</ListSubheader>}
          {model.byType.map((choice) => (
            <ChoiceItem key={`t:${choice.key}`} choice={choice} onPick={() => pick({ types: [choice.key] })} />
          ))}
        </Menu>
      )}
    </>
  );
}
