import { DEFAULT_SERVER_TIME_ZONE, TIME_ZONE_HEADER, zonedDateKey, zonedDayStart } from '@marinoscar/platform-contract/timezone';

// =============================================================================
// The user's time zone, for the domain (issue: all date operations follow the profile zone)
// =============================================================================
//
// Every calendar day the domain DERIVES from an instant or from "now" is cut in the
// requester's (or the owner's) zone. Values that are calendar-only by nature (a
// valid range, an item's `occurred_at` / `due_at`, a date attribute, a bare
// `YYYY-MM-DD` `as_of`) are floating dates stored at UTC midnight and are never
// converted: they must not shift with anybody's zone.
//
// The zone itself is the settings port's (`KvoxSettingsPort.readUserTimeZone`: the
// profile zone; KVox Desktop answers the device zone). A request that has no
// stored zone falls back to the `X-Time-Zone` header the web client sends, then
// to UTC. The arithmetic is the platform contract's pure `timezone` entry, the one
// platform import a kvox-api file may make.
// =============================================================================

/**
 * The fallback zone when nothing is stored and no usable header arrived.
 *
 * @stability experimental
 */
export const KVOX_DEFAULT_TIME_ZONE: string = DEFAULT_SERVER_TIME_ZONE;

/**
 * The request header a client sends with the device zone (`x-time-zone`).
 *
 * @stability experimental
 */
export const KVOX_TIME_ZONE_HEADER: string = TIME_ZONE_HEADER;

const validCache = new Map<string, boolean>();

/**
 * Whether `value` is an IANA zone id the runtime knows.
 *
 * @param value - candidate zone id.
 * @returns true for a usable zone id.
 * @stability experimental
 */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return false;
  const cached = validCache.get(value);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    ok = true;
  } catch {
    ok = false;
  }
  if (validCache.size < 512) validCache.set(value, ok);
  return ok;
}

/**
 * The first usable zone of the candidates, else UTC. Total; never throws.
 *
 * @param candidates - zone ids in order of preference (profile, request header, ...).
 * @returns a valid IANA zone id.
 * @stability experimental
 */
export function pickTimeZone(...candidates: ReadonlyArray<string | null | undefined>): string {
  for (const candidate of candidates) {
    if (isValidTimeZone(candidate)) return candidate;
  }
  return KVOX_DEFAULT_TIME_ZONE;
}

/**
 * The calendar day (`YYYY-MM-DD`) an instant falls on in `timeZone`.
 *
 * @param instant - the instant.
 * @param timeZone - an IANA zone id; an invalid one is read as UTC.
 * @returns the day key.
 * @stability experimental
 */
export function localDateKey(instant: Date | string | number, timeZone: string): string {
  return zonedDateKey(new Date(instant), pickTimeZone(timeZone));
}

/**
 * The instant of local midnight at the start of a `YYYY-MM-DD` day in `timeZone`.
 *
 * @param day - the day key.
 * @param timeZone - an IANA zone id; an invalid one is read as UTC.
 * @returns the instant.
 * @stability experimental
 */
export function localDayStart(day: string, timeZone: string): Date {
  return zonedDayStart(day, pickTimeZone(timeZone));
}

/**
 * A calendar day key as a floating date: UTC midnight of that day. This is how a
 * day derived in the user's zone is stored in a calendar-only column.
 *
 * @param day - the `YYYY-MM-DD` key.
 * @returns the Date at `00:00:00.000Z` of that day.
 * @stability experimental
 */
export function dayKeyToFloatingDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/**
 * The weekday name (`Monday`) of a `YYYY-MM-DD` day key. A calendar fact, so the
 * zone plays no part.
 *
 * @param day - the day key.
 * @returns the English weekday name.
 * @stability experimental
 */
export function weekdayOfDayKey(day: string): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(dayKeyToFloatingDate(day));
}

/**
 * A short wall-clock `HH:mm` of an instant in `timeZone` (24-hour).
 *
 * @param instant - the instant.
 * @param timeZone - an IANA zone id; an invalid one is read as UTC.
 * @returns `21:42`.
 * @stability experimental
 */
export function localTimeOfDay(instant: Date | string | number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: pickTimeZone(timeZone),
  }).formatToParts(new Date(instant));
  const hh = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const mm = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${hh}:${mm}`;
}

/**
 * A bare `YYYY-MM-DD` or a full ISO instant, read against INSTANTS in the
 * requester's zone: a bare day is local midnight in `timeZone`, a full instant is
 * itself. The rule for every `since`, `from` and `to` filter over a timestamp
 * column; a calendar predicate (`as_of`, validity) keeps UTC midnight instead.
 *
 * @param value - a day key or an ISO instant.
 * @param timeZone - the requester's zone.
 * @returns the instant, or null when `value` is neither.
 * @stability experimental
 */
export function instantFromDayOrIso(value: string, timeZone: string): Date | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const start = localDayStart(value, timeZone);
    return Number.isNaN(start.getTime()) ? null : start;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
