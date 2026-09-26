/**
 * `EntityTypeFilter` — multi-select type chips for the `/graph` index (#373).
 *
 * THE CHIPS ARE GENERATED FROM THE EFFECTIVE SCHEMA, never a hard-coded list:
 * a type added to the ontology (or a domain the user switches on) appears here
 * with no web change (§13, §17.4). On a phone the row scrolls horizontally —
 * a `scroll` prop the page passes from its own page-level `down('sm')` read,
 * not a media query in here.
 */

import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';

import { EntityTypeIcon } from './entityTypeIcon';

export interface EntityTypeOption {
  key: string;
  pluralLabel: string;
}

export interface EntityTypeFilterProps {
  options: readonly EntityTypeOption[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  /** Scroll horizontally instead of wrapping (phone). */
  scroll?: boolean;
}

export function EntityTypeFilter({ options, selected, onChange, scroll = false }: EntityTypeFilterProps) {
  const toggle = (key: string) => {
    const set = new Set(selected);
    if (set.has(key)) set.delete(key);
    else set.add(key);
    // Keep registry order, whatever order the user clicked in, so the URL is stable.
    onChange(options.map((option) => option.key).filter((optionKey) => set.has(optionKey)));
  };

  return (
    <Box
      role="group"
      aria-label="Filter by type"
      sx={{
        display: 'flex',
        gap: 1,
        flexWrap: scroll ? 'nowrap' : 'wrap',
        overflowX: scroll ? 'auto' : 'visible',
        pb: scroll ? 0.5 : 0,
        minWidth: 0,
      }}
    >
      {options.map((option) => {
        const isSelected = selected.includes(option.key);
        return (
          <Chip
            key={option.key}
            icon={<EntityTypeIcon type={option.key} fontSize="small" />}
            label={option.pluralLabel}
            clickable
            color={isSelected ? 'primary' : 'default'}
            variant={isSelected ? 'filled' : 'outlined'}
            aria-pressed={isSelected}
            onClick={() => toggle(option.key)}
            sx={{ flexShrink: 0 }}
          />
        );
      })}
    </Box>
  );
}

export default EntityTypeFilter;
