/**
 * `SetRangeSheet` — the accessible alternative to dragging the brush
 * (GIC-15, #676): two date fields in a sheet from the bottom. Works with a
 * keyboard, a screen reader and a thumb, on every window class.
 *
 * The user thinks in days: "from 3 Mar to 20 May" includes 20 May. The sheet
 * widens that to whole buckets, as the brush does, and hands back the
 * half-open range the URL carries.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Drawer from '@mui/material/Drawer';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useEffect, useState } from 'react';

import type { GraphActivityBucket } from '../../../../headless/clients/graph.js';
import { DAY_MS, formatDay, parseDay, snapRange, type TimeRange } from './timeAxis.js';

/**
 * Props of {@link SetRangeSheet}.
 *
 * @stability experimental
 */
export interface SetRangeSheetProps {
  /** Whether the sheet is open. */
  open: boolean;
  /** Called to close it without a change. */
  onClose: () => void;
  /** The current range, or `null` for all time. */
  range: TimeRange | null;
  /** The earliest and latest day offered, `YYYY-MM-DD`. */
  min: string;
  /** The latest day offered, `YYYY-MM-DD`. */
  max: string;
  /** The bucket width the range is widened to. */
  bucket: GraphActivityBucket;
  /** Called with the chosen range, widened to whole buckets. */
  onApply: (range: TimeRange) => void;
  /** Called to clear the range. */
  onClear: () => void;
  /** Touch: 44px fields and buttons. */
  touch?: boolean;
}

/** The last included day of a half-open range. */
function lastDay(range: TimeRange): string {
  const to = parseDay(range.to);
  return to === null ? range.to : formatDay(to - DAY_MS);
}

/**
 * The sheet.
 *
 * @stability experimental
 */
export function SetRangeSheet({ open, onClose, range, min, max, bucket, onApply, onClear, touch }: SetRangeSheetProps) {
  const [from, setFrom] = useState(range?.from ?? min);
  const [to, setTo] = useState(range ? lastDay(range) : max);
  const [error, setError] = useState<string | null>(null);

  // Opening it shows the current range.
  useEffect(() => {
    if (!open) return;
    setFrom(range?.from ?? min);
    setTo(range ? lastDay(range) : max);
    setError(null);
  }, [open, range, min, max]);

  const apply = () => {
    const a = parseDay(from);
    const b = parseDay(to);
    if (a === null || b === null) {
      setError('Enter both dates.');
      return;
    }
    if (a > b) {
      setError('The start date must not be after the end date.');
      return;
    }
    setError(null);
    onApply(snapRange(a, b + DAY_MS, bucket));
  };

  const field = { slotProps: { htmlInput: { min, max }, inputLabel: { shrink: true } }, sx: { flex: '1 1 150px', minWidth: 0 } } as const;
  const size = touch ? { minHeight: 44 } : {};

  return (
    <Drawer
      anchor="bottom"
      open={open}
      onClose={onClose}
      slotProps={{ paper: { role: 'dialog', 'aria-modal': true, 'aria-label': 'Set the time range' } }}
    >
      <Box
        component="form"
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
        sx={{ p: 2, pb: 'calc(16px + env(safe-area-inset-bottom, 0px))', display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 560, mx: 'auto', width: '100%' }}
      >
        <Typography variant="h6" component="h2">
          Set the time range
        </Typography>
        <Typography variant="body2" color="text.secondary">
          The graph is shown as it stood at the end of the range, and nodes with no evidence in it are dimmed.
        </Typography>
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          <TextField {...field} label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <TextField {...field} label="To (included)" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Box>
        {error && <Alert severity="error">{error}</Alert>}
        <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <Button onClick={onClose} sx={size}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              onClear();
            }}
            disabled={!range}
            sx={size}
          >
            Clear range
          </Button>
          <Button type="submit" variant="contained" sx={size}>
            Apply
          </Button>
        </Box>
      </Box>
    </Drawer>
  );
}
