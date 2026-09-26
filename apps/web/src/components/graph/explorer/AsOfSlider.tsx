/**
 * `AsOfSlider` — show the graph as it stood on a past date (#374; spec §5.4,
 * §22.2). Monthly steps from `minDate` to the current month; the rightmost
 * step is "now" (no `as_of` at all). A change is debounced 300 ms so dragging
 * across two years is one request, not twenty-four.
 *
 * A step maps to the FIRST DAY of its month, UTC (`2024-03-01`) — the API
 * reads a bare date as 00:00:00Z that day, so the value is stable wherever
 * the viewer is.
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Slider from '@mui/material/Slider';
import Typography from '@mui/material/Typography';
import { useEffect, useMemo, useRef, useState } from 'react';

import { monthLabel } from './explorerFilters';

export const AS_OF_DEBOUNCE_MS = 300;

export interface AsOfSliderProps {
  /** The earliest month offered: `YYYY-MM-DD` or any ISO instant. */
  minDate: string;
  /** `null` = now. */
  value: string | null;
  onChange: (value: string | null) => void;
  /** Injectable for tests; defaults to the real clock. */
  now?: Date;
  disabled?: boolean;
}

function monthStart(year: number, month: number): string {
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-01`;
}

/** Every month start from `min`'s month up to and including `now`'s month. */
export function monthSteps(min: string, now: Date): string[] {
  const start = new Date(min);
  let year = Number.isNaN(start.getTime()) ? now.getUTCFullYear() - 5 : start.getUTCFullYear();
  let month = Number.isNaN(start.getTime()) ? now.getUTCMonth() : start.getUTCMonth();
  const endYear = now.getUTCFullYear();
  const endMonth = now.getUTCMonth();
  const steps: string[] = [];
  while (year < endYear || (year === endYear && month <= endMonth)) {
    steps.push(monthStart(year, month));
    month += 1;
    if (month === 12) {
      month = 0;
      year += 1;
    }
    if (steps.length > 1200) break;
  }
  if (steps.length === 0) steps.push(monthStart(endYear, endMonth));
  return steps;
}

export function AsOfSlider({ minDate, value, onChange, now, disabled }: AsOfSliderProps) {
  const clock = useMemo(() => now ?? new Date(), [now]);
  const steps = useMemo(() => monthSteps(minDate, clock), [minDate, clock]);
  const last = steps.length - 1;

  const indexOf = (v: string | null) => {
    if (!v) return last;
    const key = `${v.slice(0, 7)}-01`;
    const found = steps.indexOf(key);
    if (found >= 0) return found;
    return key < steps[0] ? 0 : last;
  };

  const [index, setIndex] = useState(() => indexOf(value));
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // An outside change (URL, "Reset") moves the thumb.
  useEffect(() => {
    setIndex(indexOf(value));
  }, [value, steps]);

  useEffect(
    () => () => {
      if (pending.current) clearTimeout(pending.current);
    },
    [],
  );

  const emit = (next: number) => {
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => {
      pending.current = null;
      onChangeRef.current(next >= last ? null : steps[next]);
    }, AS_OF_DEBOUNCE_MS);
  };

  const label = (i: number) => (i >= last ? 'Now' : monthLabel(steps[i]));

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, minWidth: 0, flex: 1 }}>
      <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
        As of
      </Typography>
      <Slider
        size="small"
        min={0}
        max={last}
        step={1}
        value={index}
        disabled={disabled || last === 0}
        onChange={(_event, next) => {
          const n = Array.isArray(next) ? next[0] : next;
          setIndex(n);
          emit(n);
        }}
        valueLabelDisplay="auto"
        valueLabelFormat={label}
        getAriaValueText={label}
        aria-label="Show the graph as of"
        sx={{ minWidth: 120, flex: 1 }}
      />
      <Typography
        variant="body2"
        sx={{ whiteSpace: 'nowrap', minWidth: 64, fontVariantNumeric: 'tabular-nums' }}
        aria-hidden
      >
        {label(index)}
      </Typography>
      {index < last && (
        <Button
          size="small"
          variant="text"
          disabled={disabled}
          onClick={() => {
            if (pending.current) clearTimeout(pending.current);
            pending.current = null;
            setIndex(last);
            onChangeRef.current(null);
          }}
        >
          Now
        </Button>
      )}
    </Box>
  );
}
