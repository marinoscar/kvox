/**
 * `FacetsRail` — the medium window's facets: a 56px rail of icon chips; a chip
 * opens a popover holding the facets (GIC-08, #669; epic #661).
 *
 * Today the rail has the one "Filters" chip; the legend, relations, sources
 * and insights stories add theirs through `chips`. The popover holds the same
 * `facets` content the expanded pane and the compact drawer hold.
 */

import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import FilterListIcon from '@mui/icons-material/FilterList';
import Badge from '@mui/material/Badge';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Popover from '@mui/material/Popover';
import Tooltip from '@mui/material/Tooltip';
import { useRef, useState, type ReactNode } from 'react';

/** Width of the chip rail in px. */
export const FACETS_RAIL_WIDTH = 56;

/**
 * Props of {@link FacetsRail}.
 *
 * @stability experimental
 */
export interface FacetsRailProps {
  /** The facets, shown in the popover. */
  children: ReactNode;
  /** How many facets are narrowing the graph; shown as a badge on the chip. */
  activeCount?: number;
  /** The chip's and popover's accessible name. */
  label?: string;
  /** More chips (icon buttons), below the "Filters" one. */
  chips?: ReactNode;
  /** Called to collapse the rail. */
  onCollapse?: () => void;
}

/**
 * The tablet-portrait facets: an icon-chip rail whose chips open popovers.
 *
 * @stability experimental
 */
export function FacetsRail({ children, activeCount = 0, label = 'Filters', chips, onCollapse }: FacetsRailProps) {
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <Box
      component="section"
      aria-label={`${label} rail`}
      sx={{
        flex: `0 0 ${FACETS_RAIL_WIDTH}px`,
        width: FACETS_RAIL_WIDTH,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 0.5,
        py: 1,
        borderRight: 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
      }}
    >
      <Tooltip title={label} placement="right">
        <IconButton
          ref={anchor}
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
          sx={{ width: 44, height: 44 }}
        >
          <Badge color="primary" badgeContent={activeCount} invisible={activeCount === 0}>
            <FilterListIcon />
          </Badge>
        </IconButton>
      </Tooltip>
      {chips}
      {onCollapse && (
        <Tooltip title="Hide the filter rail" placement="right">
          <IconButton
            aria-label="Hide the filter rail"
            size="small"
            onClick={onCollapse}
            sx={{ mt: 'auto', width: 44, height: 44 }}
          >
            <ChevronLeftIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}
      <Popover
        open={open}
        anchorEl={anchor.current}
        onClose={() => setOpen(false)}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{
          paper: {
            role: 'dialog',
            'aria-label': label,
            sx: { width: 340, maxWidth: 'calc(100vw - 80px)', maxHeight: 'min(560px, 80dvh)', p: 2, ml: 0.5 },
          },
        }}
      >
        {children}
      </Popover>
    </Box>
  );
}
