/**
 * `AsOfSlider` — show the graph as it stood on a past date (#374; spec §5.4,
 * §22.2). Monthly steps from `minDate` to the current month; the rightmost
 * step is "now" (no `as_of` at all). A change is debounced 300 ms so dragging
 * across two years is one request, not twenty-four.
 *
 * A step maps to the FIRST DAY of its month (`2024-03-01`), a calendar date:
 * the API reads a bare `as_of` as that date's UTC midnight against calendar
 * ranges, so the value is stable wherever the viewer is. Which month is the
 * CURRENT one is the user's local calendar (the display zone): on 31 March at
 * 22:00 in Los Angeles it is still March, already April in UTC.
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Slider from '@mui/material/Slider';
import Typography from '@mui/material/Typography';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useDisplayTimeZone } from '@marinoscar/platform-web/timezone/headless';

import { monthLabel } from '../../../headless/utils/explorerFilters.js';
import { dayKeyOf, todayKey } from './timebar/timeAxis.js';

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

/**
 * Every month start from `min`'s month up to and including the current month,
 * both read on the local calendar of `timeZone` (default the display zone): a
 * bare `YYYY-MM-DD` `min` is its own month, an instant the month it falls in there.
 */
export function monthSteps(min: string, now: Date, timeZone?: string): string[] {
  const today = todayKey(now, timeZone);
  const endYear = Number(today.slice(0, 4));
  const endMonth = Number(today.slice(5, 7)) - 1;
  const minKey = dayKeyOf(min, timeZone);
  let year = minKey ? Number(minKey.slice(0, 4)) : endYear - 5;
  let month = minKey ? Number(minKey.slice(5, 7)) - 1 : endMonth;
  const steps: string[] = [];
  while (year < endYear || (year === endYear && month <= endMonth)) {
    steps.push(monthStart(year, month));
    month += 1;
    if (month === 12) {
      month = 0;
      year += 1;
    }
  }
  if (steps.length === 0) steps.push(monthStart(endYear, endMonth));
  return steps;
}

export function AsOfSlider({ minDate, value, onChange, now, disabled }: AsOfSliderProps) {
  const clock = useMemo(() => now ?? new Date(), [now]);
  const timeZone = useDisplayTimeZone();
  const steps = useMemo(() => monthSteps(minDate, clock, timeZone), [minDate, clock, timeZone]);
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
    <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1, minWidth: 0, flex: 1 }}>
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
        sx={{ minWidth: 100, flex: '1 1 100px' }}
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
