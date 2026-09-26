/**
 * `ExplorerToolbar` — filters, time and view controls above the canvas (#374;
 * spec §22.2).
 *
 * Every filter here is SERVER-SIDE: toggling one prunes what no longer
 * qualifies and narrows every later expand, so a hidden type is never fetched.
 * Chips are toggle buttons (`aria-pressed`) rather than checkboxes because
 * they read as a row of on/off filters, which is what they are.
 *
 * Two rows: filters (domains, types, the relation menu) scroll horizontally on
 * a phone rather than wrapping into a wall of chips; time and view controls sit
 * below.
 */

import CheckIcon from '@mui/icons-material/Check';
import CenterFocusStrongIcon from '@mui/icons-material/CenterFocusStrong';
import FilterListIcon from '@mui/icons-material/FilterList';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import ViewListIcon from '@mui/icons-material/ViewList';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Skeleton from '@mui/material/Skeleton';
import ToggleButton from '@mui/material/ToggleButton';
import Typography from '@mui/material/Typography';
import { useState } from 'react';

import { AsOfSlider } from './AsOfSlider';
import type { DomainOption, FilterOption } from './explorerFilters';
import { EXPLORER_NODE_CAP } from './explorerModel';

export interface ExplorerToolbarProps {
  domains: DomainOption[];
  nodeTypes: FilterOption[];
  relationTypes: FilterOption[];
  hiddenTypes: ReadonlySet<string>;
  hiddenRelationTypes: ReadonlySet<string>;
  onToggleType: (key: string) => void;
  onToggleDomain: (domain: DomainOption) => void;
  onToggleRelationType: (key: string) => void;
  asOf: string | null;
  asOfMin: string;
  onAsOfChange: (value: string | null) => void;
  onFit: () => void;
  onReset: () => void;
  listView: boolean;
  /** Without WebGL the list is the only view: the toggle is disabled on. */
  listViewForced: boolean;
  onToggleListView: () => void;
  nodeCount: number;
  disabled?: boolean;
}

export function ExplorerToolbar(props: ExplorerToolbarProps) {
  const {
    domains,
    nodeTypes,
    relationTypes,
    hiddenTypes,
    hiddenRelationTypes,
    onToggleType,
    onToggleDomain,
    onToggleRelationType,
    asOf,
    asOfMin,
    onAsOfChange,
    onFit,
    onReset,
    listView,
    listViewForced,
    onToggleListView,
    nodeCount,
    disabled,
  } = props;
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);

  const domainShown = (domain: DomainOption) =>
    domain.nodeTypes.every((key) => !hiddenTypes.has(key)) &&
    domain.relationTypes.every((key) => !hiddenRelationTypes.has(key));

  const hiddenRelationCount = relationTypes.filter((r) => hiddenRelationTypes.has(r.key)).length;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mb: 1.5, minWidth: 0 }}>
      <Box
        role="group"
        aria-label="Filter the graph"
        sx={{
          display: 'flex',
          gap: 1,
          alignItems: 'center',
          overflowX: 'auto',
          flexWrap: { xs: 'nowrap', md: 'wrap' },
          pb: 0.5,
          minWidth: 0,
        }}
      >
        {domains.map((domain) => {
          const shown = domainShown(domain);
          return (
            <Chip
              key={`domain-${domain.key}`}
              label={domain.label}
              icon={shown ? <CheckIcon fontSize="small" /> : undefined}
              color={shown ? 'primary' : 'default'}
              variant="outlined"
              onClick={() => onToggleDomain(domain)}
              aria-pressed={shown}
              aria-label={`${domain.label} domain`}
              disabled={disabled}
            />
          );
        })}
        {domains.length > 0 && <Divider orientation="vertical" flexItem />}
        {nodeTypes.map((type) => {
          const shown = !hiddenTypes.has(type.key);
          return (
            <Chip
              key={type.key}
              label={type.label}
              size="small"
              icon={shown ? <CheckIcon fontSize="small" /> : undefined}
              color={shown ? 'primary' : 'default'}
              variant="outlined"
              onClick={() => onToggleType(type.key)}
              aria-pressed={shown}
              disabled={disabled}
            />
          );
        })}
        {relationTypes.length > 0 && (
          <>
            <Button
              size="small"
              startIcon={<FilterListIcon />}
              onClick={(event) => setMenuAnchor(event.currentTarget)}
              aria-haspopup="menu"
              aria-expanded={Boolean(menuAnchor)}
              disabled={disabled}
              sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}
            >
              {hiddenRelationCount > 0 ? `Relations (${hiddenRelationCount} hidden)` : 'Relations'}
            </Button>
            <Menu
              anchorEl={menuAnchor}
              open={Boolean(menuAnchor)}
              onClose={() => setMenuAnchor(null)}
              slotProps={{ paper: { sx: { maxHeight: 360 } } }}
            >
              {relationTypes.map((rel) => {
                const shown = !hiddenRelationTypes.has(rel.key);
                return (
                  <MenuItem
                    key={rel.key}
                    role="menuitemcheckbox"
                    aria-checked={shown}
                    onClick={() => onToggleRelationType(rel.key)}
                    dense
                  >
                    <ListItemIcon>
                      <Checkbox edge="start" size="small" checked={shown} tabIndex={-1} disableRipple />
                    </ListItemIcon>
                    <ListItemText>{rel.label}</ListItemText>
                  </MenuItem>
                );
              })}
            </Menu>
          </>
        )}
      </Box>

      <Box
        sx={{
          display: 'flex',
          gap: 1,
          alignItems: 'center',
          flexWrap: { xs: 'wrap', sm: 'nowrap' },
          minWidth: 0,
        }}
      >
        <Box sx={{ flex: '1 1 260px', minWidth: 0, display: 'flex' }}>
          <AsOfSlider minDate={asOfMin} value={asOf} onChange={onAsOfChange} disabled={disabled} />
        </Box>
        <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center', ml: 'auto' }}>
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
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', ml: 0.5 }}
            aria-label={`${nodeCount} of ${EXPLORER_NODE_CAP} nodes`}
          >
            {nodeCount} / {EXPLORER_NODE_CAP}
          </Typography>
        </Box>
      </Box>
    </Box>
  );
}

/** The toolbar's shape while the ontology and first slice load. */
export function ExplorerToolbarSkeleton() {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mb: 1.5 }} aria-hidden>
      <Box sx={{ display: 'flex', gap: 1 }}>
        {[72, 88, 64, 80, 76].map((width, index) => (
          <Skeleton key={index} variant="rounded" width={width} height={24} />
        ))}
      </Box>
      <Skeleton variant="rounded" height={32} />
    </Box>
  );
}
