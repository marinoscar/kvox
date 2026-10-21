/**
 * `ExplorerFilters` — the explorer's facets: domains, types, relations and the
 * `as of` date (#374; spec §22.2). Rendered into the Insight Canvas shell's
 * `facets` slot (GIC-08, #669): a pane on a laptop, a popover on a tablet, a
 * drawer on a phone. The view controls (Fit, Reset, List view) stay in the top
 * bar, in `ExplorerToolbar`.
 *
 * Every filter here is SERVER-SIDE: toggling one prunes what no longer
 * qualifies and narrows every later expand, so a hidden type is never fetched.
 * Chips are toggle buttons (`aria-pressed`) rather than checkboxes because
 * they read as a row of on/off filters, which is what they are.
 */

import CheckIcon from '@mui/icons-material/Check';
import FilterListIcon from '@mui/icons-material/FilterList';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import { useState } from 'react';

import { AsOfSlider } from './AsOfSlider.js';
import type { DomainOption, FilterOption } from '../../../headless/utils/explorerFilters.js';

/**
 * Props of {@link ExplorerFilters}.
 *
 * @stability experimental
 */
export interface ExplorerFiltersProps {
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
  disabled?: boolean;
}

/**
 * How many facets narrow the graph right now: hidden types, hidden relations and a set `as of` date. The badge on the Filters chip and button.
 *
 * @stability experimental
 */
export function activeFilterCount(input: {
  hiddenTypes: ReadonlySet<string>;
  hiddenRelationTypes: ReadonlySet<string>;
  asOf: string | null;
}): number {
  return input.hiddenTypes.size + input.hiddenRelationTypes.size + (input.asOf ? 1 : 0);
}

function SectionHeading({ children }: { children: string }) {
  return (
    <Typography variant="overline" component="h2" color="text.secondary" sx={{ display: 'block', lineHeight: 2 }}>
      {children}
    </Typography>
  );
}

/**
 * The filter facets of the explorer: domain and type chips, a relation menu and the `as of` slider.
 *
 * @stability experimental
 */
export function ExplorerFilters(props: ExplorerFiltersProps) {
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
    disabled,
  } = props;
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);

  const domainShown = (domain: DomainOption) =>
    domain.nodeTypes.every((key) => !hiddenTypes.has(key)) &&
    domain.relationTypes.every((key) => !hiddenRelationTypes.has(key));

  const hiddenRelationCount = relationTypes.filter((r) => hiddenRelationTypes.has(r.key)).length;

  return (
    <Box role="group" aria-label="Filter the graph" sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, minWidth: 0 }}>
      {domains.length > 0 && (
        <>
          <SectionHeading>Domains</SectionHeading>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
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
          </Box>
        </>
      )}
      <SectionHeading>Types</SectionHeading>
      <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
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
      </Box>
      {relationTypes.length > 0 && (
        <>
          <SectionHeading>Relations</SectionHeading>
          <Box>
            <Button
              size="small"
              startIcon={<FilterListIcon />}
              onClick={(event) => setMenuAnchor(event.currentTarget)}
              aria-haspopup="menu"
              aria-expanded={Boolean(menuAnchor)}
              disabled={disabled}
              sx={{ whiteSpace: 'nowrap' }}
            >
              {hiddenRelationCount > 0 ? `Relations (${hiddenRelationCount} hidden)` : 'Relations'}
            </Button>
          </Box>
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
      <SectionHeading>Time</SectionHeading>
      <AsOfSlider minDate={asOfMin} value={asOf} onChange={onAsOfChange} disabled={disabled} />
    </Box>
  );
}

/** The facets' shape while the ontology and first slice load. */
export function ExplorerFiltersSkeleton() {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }} aria-hidden>
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        {[72, 88, 64, 80, 76].map((width, index) => (
          <Skeleton key={index} variant="rounded" width={width} height={24} />
        ))}
      </Box>
      <Skeleton variant="rounded" height={32} />
    </Box>
  );
}
