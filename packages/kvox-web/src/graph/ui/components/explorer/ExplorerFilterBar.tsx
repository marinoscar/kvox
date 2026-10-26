/**
 * `ExplorerFilterBar` — the explorer's filters in ONE row under the toolbar
 * (#768): search, the type chips and the time control.
 *
 *   - Search opens the command palette (GIC-09).
 *   - Type chips SELECT what shows (#764): none selected = every type. In the
 *     full view each chip carries its live count from the overview's
 *     `typeCounts` and an empty type is DISABLED ("Products (0)"), unless it is
 *     selected, so it can still be deselected. An item kind has no count (the
 *     overview counts entities only) and is never disabled for one.
 *   - Time: {@link ExplorerTimeControl}, All time by default.
 *
 * The chips scroll sideways when they do not fit, so the row never wraps into
 * a wall on a phone; search and time stay put at either end.
 */

import CheckIcon from '@mui/icons-material/Check';
import SearchIcon from '@mui/icons-material/Search';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';

import type { FilterOption } from '../../../headless/utils/explorerFilters.js';
import { chipCount } from './fullGraphModel.js';
import { ExplorerTimeControl } from './timebar/ExplorerTimeControl.js';
import type { TimeRange } from './timebar/timeAxis.js';
import type { InputModality } from './shell/useInputModality.js';
import type { WindowClass } from './shell/useWindowClass.js';

/**
 * Props of {@link ExplorerFilterBar}.
 *
 * @stability experimental
 */
export interface ExplorerFilterBarProps {
  nodeTypes: readonly FilterOption[];
  /** The SELECTED node types; empty means every type shows. */
  selectedTypes: ReadonlySet<string>;
  onToggleType: (key: string) => void;
  /** Live entity counts per type (the overview's `typeCounts`), or `null` when unknown: no counts, nothing disabled. */
  counts: Readonly<Record<string, number>> | null;
  /** The time range from the URL, or `null` for All time. */
  range: TimeRange | null;
  onRangeChange: (range: TimeRange | null) => void;
  /** Opens the command palette. Omitted: no search control. */
  onOpenSearch?: () => void;
  windowClass: WindowClass;
  inputModality: InputModality;
  disabled?: boolean;
}

/**
 * The one-row filter bar of the explorer: search, type chips with counts, and time.
 *
 * @stability experimental
 */
export function ExplorerFilterBar(props: ExplorerFilterBarProps) {
  const { nodeTypes, selectedTypes, onToggleType, counts, range, onRangeChange, onOpenSearch, windowClass, inputModality, disabled } =
    props;
  const touch = inputModality === 'touch';
  const compact = windowClass === 'compact';

  const search =
    onOpenSearch &&
    (compact ? (
      <IconButton
        aria-label="Search the graph"
        aria-keyshortcuts="Control+K Meta+K /"
        onClick={onOpenSearch}
        sx={{ width: 44, height: 44, flexShrink: 0 }}
      >
        <SearchIcon />
      </IconButton>
    ) : (
      <Button
        variant="outlined"
        color="inherit"
        size="small"
        startIcon={<SearchIcon />}
        onClick={onOpenSearch}
        aria-label="Search the graph"
        aria-keyshortcuts="Control+K Meta+K /"
        sx={{
          textTransform: 'none',
          color: 'text.secondary',
          justifyContent: 'flex-start',
          flexShrink: 0,
          minWidth: { sm: 140, md: 200 },
          minHeight: touch ? 44 : undefined,
        }}
      >
        Search
      </Button>
    ));

  return (
    <Box
      role="group"
      aria-label="Filters"
      sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}
    >
      {search}
      <Box
        role="group"
        aria-label="Show only these types"
        sx={{
          display: 'flex',
          gap: 0.75,
          flex: '1 1 auto',
          minWidth: 0,
          overflowX: 'auto',
          py: 0.5,
          scrollbarWidth: 'thin',
        }}
      >
        {nodeTypes.map((type) => {
          const selected = selectedTypes.has(type.key);
          const count = chipCount(type.key, counts);
          const empty = count === 0 && !selected;
          return (
            <Chip
              key={type.key}
              label={count === null ? type.label : `${type.label} (${count.toLocaleString('en-US')})`}
              size="small"
              icon={selected ? <CheckIcon fontSize="small" /> : undefined}
              color={selected ? 'primary' : 'default'}
              variant={selected ? 'filled' : 'outlined'}
              onClick={() => onToggleType(type.key)}
              aria-pressed={selected}
              disabled={disabled || empty}
              sx={{ flexShrink: 0, minHeight: touch ? 32 : undefined }}
            />
          );
        })}
      </Box>
      <ExplorerTimeControl range={range} onChange={onRangeChange} touch={touch} disabled={disabled} />
    </Box>
  );
}
