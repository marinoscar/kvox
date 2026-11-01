/**
 * `ExplorerTimeControl` — the explorer's ONE time control (#768), replacing the
 * TimeBar strip and the as-of slider on the page: All time (the default), Last
 * 30 days, Last 90 days, Last year, or a custom range. It only reports a range
 * (`null` = All time); the page writes `from`/`to` and decides what the range
 * does (the full view filters the request; the focused view filters the canvas).
 */

import CheckIcon from '@mui/icons-material/Check';
import ScheduleIcon from '@mui/icons-material/Schedule';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import { useDisplayTimeZone } from '@marinoscar/platform-web/timezone/headless';

import { DAY_MS, formatDay, parseDay, todayDay, type TimeRange } from './timeAxis.js';
import {
  TIME_PRESET_LABELS,
  customRange,
  presetOf,
  presetRange,
  timeControlLabel,
  type TimePresetKey,
} from './timePresets.js';

/**
 * Props of {@link ExplorerTimeControl}.
 *
 * @stability experimental
 */
export interface ExplorerTimeControlProps {
  /** The range from the URL, or `null` for All time. */
  range: TimeRange | null;
  /** Called with the new range, or `null` for All time. */
  onChange: (range: TimeRange | null) => void;
  /** A coarse pointer: 44px targets. */
  touch?: boolean;
  disabled?: boolean;
  /** The clock, for tests. */
  now?: number;
}

const MENU_ORDER: TimePresetKey[] = ['all', '30d', '90d', '1y', 'custom'];

/**
 * The time menu of the explorer's filter row.
 *
 * @stability experimental
 */
export function ExplorerTimeControl({ range, onChange, touch, disabled, now }: ExplorerTimeControlProps) {
  const clock = now ?? Date.now();
  // The presets are calendar days of the display zone; a zone change re-renders.
  const timeZone = useDisplayTimeZone();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const current = presetOf(range, clock, timeZone);
  const label = timeControlLabel(range, clock, timeZone);

  const choose = (key: TimePresetKey) => {
    setAnchor(null);
    if (key === 'custom') {
      setCustomOpen(true);
      return;
    }
    onChange(presetRange(key, clock, timeZone));
  };

  return (
    <>
      <Button
        size="small"
        variant={range ? 'contained' : 'outlined'}
        color={range ? 'primary' : 'inherit'}
        startIcon={<ScheduleIcon fontSize="small" />}
        onClick={(event) => setAnchor(event.currentTarget)}
        aria-haspopup="menu"
        aria-expanded={Boolean(anchor)}
        aria-label={`Time: ${label}`}
        disabled={disabled}
        sx={{ textTransform: 'none', whiteSpace: 'nowrap', flexShrink: 0, minHeight: touch ? 44 : undefined }}
      >
        {label}
      </Button>
      <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)}>
        {MENU_ORDER.map((key) => (
          <MenuItem
            key={key}
            role="menuitemradio"
            aria-checked={current === key}
            selected={current === key}
            onClick={() => choose(key)}
            sx={{ minHeight: touch ? 44 : undefined }}
          >
            <ListItemIcon>{current === key ? <CheckIcon fontSize="small" /> : null}</ListItemIcon>
            <ListItemText>{key === 'custom' ? `${TIME_PRESET_LABELS.custom}…` : TIME_PRESET_LABELS[key]}</ListItemText>
          </MenuItem>
        ))}
      </Menu>
      {customOpen && (
        <CustomRangeDialog
          range={range}
          today={todayDay(clock, timeZone)}
          onClose={() => setCustomOpen(false)}
          onApply={(next) => {
            setCustomOpen(false);
            onChange(next);
          }}
        />
      )}
    </>
  );
}

function CustomRangeDialog({
  range,
  today,
  onClose,
  onApply,
}: {
  range: TimeRange | null;
  /** The user's local today, as a day number. */
  today: number;
  onClose: () => void;
  onApply: (range: TimeRange) => void;
}) {
  const initialTo = range ? parseDay(range.to) : null;
  const [from, setFrom] = useState(range?.from ?? formatDay(today - 30 * DAY_MS));
  const [to, setTo] = useState(initialTo !== null ? formatDay(initialTo - DAY_MS) : formatDay(today));
  const next = customRange(from, to);
  return (
    <Dialog open onClose={onClose} aria-labelledby="explorer-time-custom-title" maxWidth="xs" fullWidth>
      <DialogTitle id="explorer-time-custom-title">Custom range</DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', pt: 1 }}>
          <TextField
            label="From"
            type="date"
            size="small"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            slotProps={{ inputLabel: { shrink: true } }}
            sx={{ flex: '1 1 140px' }}
          />
          <TextField
            label="To"
            type="date"
            size="small"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            slotProps={{ inputLabel: { shrink: true } }}
            sx={{ flex: '1 1 140px' }}
          />
        </Box>
        {!next && (
          <Typography variant="body2" color="error" sx={{ mt: 1 }} role="alert">
            Pick two dates, the second on or after the first.
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!next} onClick={() => next && onApply(next)}>
          Apply
        </Button>
      </DialogActions>
    </Dialog>
  );
}
