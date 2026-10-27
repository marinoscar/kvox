/**
 * The explorer's ONE time control (#768): presets over the URL's `from`/`to`
 * range. Pure, the clock and the zone parameters.
 *
 * A preset is a half-open `[from, to)` range of whole CALENDAR days of the
 * display time zone ending TOMORROW there (the user's local tomorrow), so their
 * today is inside it and the range end is never in the past: in the focused
 * view the graph is then evaluated "now" (no `as_of`), exactly like All time.
 * The API reads each bare day as that day's local midnight. "All time" is no
 * range at all (`from`/`to` absent from the URL).
 */

import { DAY_MS, formatDay, parseDay, todayDay, type TimeRange } from './timeAxis.js';

/**
 * The time control's choices.
 *
 * @stability experimental
 */
export type TimePresetKey = 'all' | '30d' | '90d' | '1y' | 'custom';

/** Each preset with a window: its length in days and its label. */
export const TIME_PRESETS: readonly { key: Exclude<TimePresetKey, 'all' | 'custom'>; days: number; label: string }[] = [
  { key: '30d', days: 30, label: 'Last 30 days' },
  { key: '90d', days: 90, label: 'Last 90 days' },
  { key: '1y', days: 365, label: 'Last year' },
];

/** The labels of every choice, in menu order. */
export const TIME_PRESET_LABELS: Readonly<Record<TimePresetKey, string>> = {
  all: 'All time',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  '1y': 'Last year',
  custom: 'Custom range',
};

/** The day number of the user's local tomorrow at `now` in `timeZone` (default the display zone). */
function tomorrow(now: number, timeZone?: string): number {
  return todayDay(now, timeZone) + DAY_MS;
}

/**
 * The range a preset stands for at `now`; `null` for All time (and for Custom, which has no range of its own).
 *
 * @param key - The preset.
 * @param now - The clock (epoch ms); default now.
 * @param timeZone - The zone whose calendar the range is cut in; default the display zone.
 */
export function presetRange(key: TimePresetKey, now: number = Date.now(), timeZone?: string): TimeRange | null {
  const preset = TIME_PRESETS.find((p) => p.key === key);
  if (!preset) return null;
  const end = tomorrow(now, timeZone);
  return { from: formatDay(end - preset.days * DAY_MS), to: formatDay(end) };
}

/** Which choice a range reads as: `all` without one, a preset when it matches exactly at `now` (in `timeZone`), else `custom`. */
export function presetOf(range: TimeRange | null, now: number = Date.now(), timeZone?: string): TimePresetKey {
  if (!range) return 'all';
  for (const preset of TIME_PRESETS) {
    const r = presetRange(preset.key, now, timeZone);
    if (r && r.from === range.from && r.to === range.to) return preset.key;
  }
  return 'custom';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "9 Mar 2026" for a day number: its UTC fields are the calendar date. */
function dayLabel(ms: number): string {
  const date = new Date(ms);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** "1 Mar 2026 – 31 Mar 2026" for a custom range: the last INCLUDED day, not the exclusive end. */
export function customRangeLabel(range: TimeRange): string {
  const from = parseDay(range.from);
  const to = parseDay(range.to);
  if (from === null || to === null) return TIME_PRESET_LABELS.custom;
  return `${dayLabel(from)} – ${dayLabel(to - DAY_MS)}`;
}

/** What the control's button says for a range. */
export function timeControlLabel(range: TimeRange | null, now: number = Date.now(), timeZone?: string): string {
  const key = presetOf(range, now, timeZone);
  return key === 'custom' && range ? customRangeLabel(range) : TIME_PRESET_LABELS[key];
}

/**
 * A custom range from two INCLUSIVE dates (`YYYY-MM-DD`, as a date input gives
 * them): `to` becomes the exclusive day after. `null` when either is not a date
 * or the end is before the start.
 */
export function customRange(fromDay: string, toDayInclusive: string): TimeRange | null {
  const from = parseDay(fromDay);
  const to = parseDay(toDayInclusive);
  if (from === null || to === null || to < from) return null;
  return { from: formatDay(from), to: formatDay(to + DAY_MS) };
}
