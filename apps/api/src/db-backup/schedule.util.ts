// =============================================================================
// Backup schedules: settings in, cron out, and the two boundary questions
// =============================================================================
// (issue #280, epic #254)
//
// Pure functions, no clock of their own, no dependencies. Three jobs:
//
//   1. TRANSLATE the `databaseBackup` settings an operator edits
//      (`frequency` + `dayOfWeek` + `dayOfMonth` + `timeOfDay`) into a 5-field
//      cron expression.
//   2. Answer "when should the most recent run have happened?"
//      ({@link previousFireBoundary}) - which is how #282 decides whether
//      tonight's backup already ran without needing a second scheduler.
//   3. Answer "when is the next one?" ({@link nextFireAt}) - which is what
//      #283 shows an administrator.
//
// -----------------------------------------------------------------------------
// WHY THE IRRELEVANT FIELD IS ALWAYS `*`
// -----------------------------------------------------------------------------
//
// daily   → `M H * * *`
// weekly  → `M H * * <dow>`
// monthly → `M H <dom> * *`
//
// NEVER both `<dom>` and `<dow>` in one expression. When both are restricted,
// implementations DISAGREE about what it means: Vixie cron (and therefore
// crontab(5), and therefore most operators' intuition) ORs them - the job runs
// on the 1st AND on every Sunday - while Quartz-descended and several
// JavaScript parsers AND them, running only on a 1st that is also a Sunday,
// which for many months is never. Emitting only one restricted field makes the
// expression mean the same thing everywhere, so the schedule an operator reads
// back is the schedule that runs.
//
// The settings schema stores `dayOfWeek` and `dayOfMonth` unconditionally, so
// that switching frequency back and forth does not lose the operator's choice
// (see `systemDatabaseBackupSchema`); this is the layer that decides which of
// the two is inert today.
//
// -----------------------------------------------------------------------------
// EVERYTHING IS CLAMPED, NOTHING IS REJECTED
// -----------------------------------------------------------------------------
//
// The write path already validates: `systemDatabaseBackupSchema` bounds every
// one of these fields and refuses a bad PATCH. So an out-of-range value
// reaching this function means something upstream is ALREADY broken - a
// hand-edited row, a restored older settings blob, a future field with a
// different range. In that situation a translator that throws takes the
// scheduler's tick down with it and no backup happens again until a human
// notices; a translator that clamps produces a VALID expression that fires at
// a slightly different time than intended, and the backup happens. The second
// failure is recoverable, the first is not.
//
// `dayOfMonth` clamps at 28 for a different reason, and it is the same one the
// schema uses: a monthly backup pinned to the 29th, 30th or 31st SKIPS
// February - eleven backups a year from a setting that reads like twelve.
// =============================================================================

/** Cron's own day-of-month ceiling for this feature. See the header. */
export const MAX_BACKUP_DAY_OF_MONTH = 28;

/**
 * Used when `timeOfDay` cannot be parsed at all.
 *
 * The same 02:00 that `DEFAULT_SYSTEM_SETTINGS.databaseBackup.timeOfDay`
 * ships: whatever went wrong upstream, the fallback should be the time a fresh
 * deployment would have used, not a value invented here.
 */
export const DEFAULT_BACKUP_TIME_OF_DAY = '02:00';

/**
 * How far {@link nextFireAt} and {@link previousFireBoundary} will walk.
 *
 * A BOUNDED walk, always. Every expression this module emits fires at least
 * once a month, so 400 days is roughly thirteen times the longest real gap -
 * generous enough that no legitimate schedule is ever reported as "never", and
 * finite enough that a nonsense expression (a day-of-month that no month has,
 * a hand-written one that got past the parser) returns `null` in microseconds
 * instead of spinning forever inside a cron tick.
 */
export const SCHEDULE_SEARCH_LIMIT_DAYS = 400;

export type BackupFrequency = 'daily' | 'weekly' | 'monthly';

export interface BackupScheduleInput {
  frequency: BackupFrequency;
  /** 0 (Sunday) - 6 (Saturday). Used by `weekly` only. */
  dayOfWeek?: number;
  /** 1 - 28. Used by `monthly` only. */
  dayOfMonth?: number;
  /** 24-hour `HH:MM`. */
  timeOfDay?: string;
}

/**
 * Thrown when a timezone is not one this runtime knows.
 *
 * A THROW RATHER THAN A `null`, deliberately, and the distinction is the whole
 * reason this class exists: `null` from {@link nextFireAt} already means "this
 * schedule does not fire within the search window", which is a legitimate
 * answer about a legitimate expression. If a bad timezone produced `null` too,
 * #282 could not tell "stand down and log once, an operator has to fix the
 * setting" from "nothing due", and #283 could not tell a 400 from a 200 with
 * an empty field. Callers that must not throw wrap one call in one try/catch;
 * callers that want the 400 let it propagate.
 */
export class InvalidTimezoneError extends Error {
  constructor(readonly timezone: string) {
    super(
      `Unknown time zone '${timezone}'. Expected an IANA name such as 'UTC' or ` +
        "'America/New_York'."
    );
    this.name = 'InvalidTimezoneError';
  }
}

/**
 * Thrown when an expression is outside the subset this module understands.
 *
 * That subset is exactly what {@link backupScheduleToCron} emits: a numeric
 * minute and hour, and `*` or a single number for day-of-month and
 * day-of-week, with at most one of those two restricted. Lists (`1,15`),
 * ranges (`1-5`), step values and named days are REJECTED rather than
 * approximated - a scheduler that silently mis-reads an expression fires at
 * the wrong time forever, and nobody looks at a backup's schedule again after
 * the day they set it.
 */
export class InvalidCronExpressionError extends Error {
  constructor(readonly expression: string) {
    super(
      `Unsupported cron expression '${expression}'. This scheduler understands ` +
        '`<minute> <hour> <day-of-month|*> * <day-of-week|*>` with at most one of the two ' +
        'day fields restricted.'
    );
    this.name = 'InvalidCronExpressionError';
  }
}

/** A parsed expression. `null` in a day field means `*`. */
export interface ParsedCronExpression {
  minute: number;
  hour: number;
  dayOfMonth: number | null;
  dayOfWeek: number | null;
}

/**
 * Translates the stored backup schedule into a 5-field cron expression.
 *
 * Total: every input, however broken, produces a valid expression. See the
 * header for why that is the right trade here.
 */
export function backupScheduleToCron(schedule: BackupScheduleInput): string {
  const { hour, minute } = parseTimeOfDay(schedule.timeOfDay);

  // An unrecognised frequency becomes `daily` rather than an error, for the
  // same reason the numbers clamp - and daily specifically because it is the
  // frequency that loses the least: a schedule that should have been weekly
  // taking a backup every night is wasteful, the reverse is a gap.
  switch (schedule.frequency) {
    case 'weekly':
      return `${minute} ${hour} * * ${clampDayOfWeek(schedule.dayOfWeek)}`;
    case 'monthly':
      return `${minute} ${hour} ${clampDayOfMonth(schedule.dayOfMonth)} * *`;
    default:
      return `${minute} ${hour} * * *`;
  }
}

/** Clamps to cron's 0-6 (Sunday-Saturday); anything unusable becomes Sunday. */
export function clampDayOfWeek(dayOfWeek: number | undefined): number {
  if (dayOfWeek === undefined || !Number.isFinite(dayOfWeek)) return 0;
  return Math.min(6, Math.max(0, Math.trunc(dayOfWeek)));
}

/** Clamps to 1-{@link MAX_BACKUP_DAY_OF_MONTH}; 31 becomes 28, so February is never skipped. */
export function clampDayOfMonth(dayOfMonth: number | undefined): number {
  if (dayOfMonth === undefined || !Number.isFinite(dayOfMonth)) return 1;
  return Math.min(MAX_BACKUP_DAY_OF_MONTH, Math.max(1, Math.trunc(dayOfMonth)));
}

/**
 * Parses `HH:MM` into clamped numbers.
 *
 * TWO DIFFERENT FAILURES, TWO DIFFERENT ANSWERS:
 *  - `'25:70'` is the right SHAPE with wrong numbers, so it clamps to 23:59.
 *    Somebody meant a time, and the nearest real one is a better guess than
 *    ignoring them.
 *  - `'tuesday'`, `''` or `undefined` carry no time at all, so they fall back
 *    to {@link DEFAULT_BACKUP_TIME_OF_DAY} rather than to an arbitrary
 *    midnight that would move every backup on the deployment.
 */
export function parseTimeOfDay(timeOfDay: string | undefined): { hour: number; minute: number } {
  const match = /^\s*(\d{1,2})\s*:\s*(\d{1,2})\s*$/.exec(timeOfDay ?? '');

  if (match === null) {
    const fallback = /^(\d{2}):(\d{2})$/.exec(DEFAULT_BACKUP_TIME_OF_DAY);
    return {
      hour: fallback === null ? 2 : Number.parseInt(fallback[1], 10),
      minute: fallback === null ? 0 : Number.parseInt(fallback[2], 10),
    };
  }

  return {
    hour: Math.min(23, Math.max(0, Number.parseInt(match[1], 10))),
    minute: Math.min(59, Math.max(0, Number.parseInt(match[2], 10))),
  };
}

/**
 * Parses the cron subset this module emits.
 *
 * @throws {InvalidCronExpressionError} for anything outside that subset.
 */
export function parseCronExpression(expression: string): ParsedCronExpression {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new InvalidCronExpressionError(expression);

  const [minuteField, hourField, domField, monthField, dowField] = fields;

  // The month field is `*` in every expression this feature produces. Accepting
  // a restricted one would mean claiming to support a schedule the settings UI
  // cannot express and the walk below does not filter on.
  if (monthField !== '*') throw new InvalidCronExpressionError(expression);

  const minute = parseNumericField(minuteField, 0, 59);
  const hour = parseNumericField(hourField, 0, 23);
  if (minute === null || hour === null) throw new InvalidCronExpressionError(expression);

  const dayOfMonth = domField === '*' ? null : parseNumericField(domField, 1, 31);
  const dayOfWeek = dowField === '*' ? null : parseNumericField(dowField, 0, 6);
  if (domField !== '*' && dayOfMonth === null) throw new InvalidCronExpressionError(expression);
  if (dowField !== '*' && dayOfWeek === null) throw new InvalidCronExpressionError(expression);

  // Both day fields restricted is the AND/OR ambiguity described in the
  // header. Rejecting it is what keeps this parser from having to pick a side.
  if (dayOfMonth !== null && dayOfWeek !== null) throw new InvalidCronExpressionError(expression);

  return { minute, hour, dayOfMonth, dayOfWeek };
}

/**
 * The most recent instant at or before `now` at which `expression` was due.
 *
 * This is the "boundary" a run is recorded against: #282 compares the last
 * successful run's boundary with this value, and takes a backup only when they
 * differ. That is what makes the scheduler idempotent across restarts, missed
 * ticks and multiple API replicas without any of them holding a lock - two
 * processes computing the same boundary from the same settings agree by
 * construction.
 *
 * @returns `null` when nothing was due within {@link SCHEDULE_SEARCH_LIMIT_DAYS}.
 * @throws {InvalidTimezoneError} for a timezone this runtime does not know.
 * @throws {InvalidCronExpressionError} for an unsupported expression.
 */
export function previousFireBoundary(
  expression: string,
  now: Date,
  timezone: string
): Date | null {
  return walk(expression, now, timezone, 'backward');
}

/**
 * The next instant strictly after `from` at which `expression` is due.
 *
 * @returns `null` when nothing is due within {@link SCHEDULE_SEARCH_LIMIT_DAYS}.
 * @throws {InvalidTimezoneError} for a timezone this runtime does not know.
 * @throws {InvalidCronExpressionError} for an unsupported expression.
 */
export function nextFireAt(expression: string, from: Date, timezone: string): Date | null {
  return walk(expression, from, timezone, 'forward');
}

// -----------------------------------------------------------------------------
// The walk
// -----------------------------------------------------------------------------
//
// WHY CIVIL DATES ARE WALKED, RATHER THAN MILLISECONDS ADDED. "The same local
// time tomorrow" is NOT a fixed number of milliseconds away: across a DST
// boundary it is 23 or 25 hours, and a schedule advanced by 86_400_000ms drifts
// by an hour twice a year and stays drifted. So the walk moves over CALENDAR
// DAYS in the configured zone and converts each candidate day's local time to
// UTC independently, which is correct on both sides of every transition.
//
// WHY `Intl.DateTimeFormat` AND NOT A LIBRARY. The IANA rules needed here are
// already in the runtime, kept current by the platform. A dependency would add
// a second copy of the timezone database to keep updated, and this needs one
// operation from it (what is the local civil time at this instant in this
// zone) rather than a date library's whole surface.

function walk(
  expression: string,
  reference: Date,
  timezone: string,
  direction: 'forward' | 'backward'
): Date | null {
  const cron = parseCronExpression(expression);

  // An Invalid Date would make every comparison below false and the walk
  // return `null` after 400 useless iterations; saying so immediately is both
  // faster and honest.
  const referenceMs = reference.getTime();
  if (!Number.isFinite(referenceMs)) return null;

  // Also the timezone validation: this throws InvalidTimezoneError before any
  // iteration, so a bad zone never costs a walk.
  const start = civilInZone(referenceMs, timezone);
  const step = direction === 'forward' ? 1 : -1;

  for (let offset = 0; offset <= SCHEDULE_SEARCH_LIMIT_DAYS; offset += 1) {
    const day = addCivilDays(start, offset * step);
    if (!matchesDay(cron, day)) continue;

    const candidate = zonedCivilToUtc(day.year, day.month, day.day, cron.hour, cron.minute, timezone);
    const candidateMs = candidate.getTime();

    // Strictly after for `next`, at-or-before for `previous`. The asymmetry is
    // deliberate: a boundary computed exactly at its own fire time is that
    // boundary (so a run triggered on time records the right one), while "the
    // next fire" must never return the instant you are standing on.
    if (direction === 'forward' ? candidateMs > referenceMs : candidateMs <= referenceMs) {
      return candidate;
    }
  }

  return null;
}

/** A day in the configured zone: the calendar date plus its weekday. */
interface CivilDay {
  year: number;
  month: number;
  day: number;
  weekday: number;
}

function matchesDay(cron: ParsedCronExpression, day: CivilDay): boolean {
  // An AND is safe here only because {@link parseCronExpression} guarantees at
  // most one of the two is restricted - see the header's note on OR-vs-AND.
  if (cron.dayOfMonth !== null && day.day !== cron.dayOfMonth) return false;
  if (cron.dayOfWeek !== null && day.weekday !== cron.dayOfWeek) return false;

  return true;
}

/**
 * Adds days to a calendar date.
 *
 * `Date.UTC` is used as PURE CALENDAR ARITHMETIC - no timezone is involved and
 * none is implied. UTC has no DST, so "the 31st of January plus one day" is
 * exactly the 1st of February here, with the month and year rollover handled
 * by the platform instead of by hand.
 */
function addCivilDays(day: CivilDay, days: number): CivilDay {
  const shifted = new Date(Date.UTC(day.year, day.month - 1, day.day + days));

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
  };
}

interface CivilTime extends CivilDay {
  hour: number;
  minute: number;
  second: number;
}

/**
 * Formatters are cached per zone.
 *
 * Constructing an `Intl.DateTimeFormat` is one of the more expensive things in
 * the runtime (it loads and configures ICU data), and a single 400-day walk
 * asks for the local time hundreds of times. Without the cache the boundary
 * computation would be slow enough to be noticeable inside a cron tick.
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timezone);
  if (cached !== undefined) return cached;

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      // `hourCycle: 'h23'` rather than `hour12: false`, which in several ICU
      // versions renders midnight as hour 24 and would put every midnight
      // schedule one day out.
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    throw new InvalidTimezoneError(timezone);
  }

  formatterCache.set(timezone, formatter);

  return formatter;
}

/** The civil (wall-clock) time at `utcMs`, in `timezone`. */
function civilInZone(utcMs: number, timezone: string): CivilTime {
  const parts = formatterFor(timezone).formatToParts(new Date(utcMs));
  const values: Record<string, number> = {};

  for (const part of parts) {
    if (part.type !== 'literal') values[part.type] = Number.parseInt(part.value, 10);
  }

  const date = new Date(Date.UTC(values.year, values.month - 1, values.day));

  return {
    year: values.year,
    month: values.month,
    day: values.day,
    // Derived from the civil date rather than asked for as a `weekday` part,
    // which would come back as a localised name that then has to be mapped.
    weekday: date.getUTCDay(),
    // `h23` still emits `24` on some older ICU builds; normalise rather than
    // trust it.
    hour: values.hour === 24 ? 0 : values.hour,
    minute: values.minute,
    second: values.second,
  };
}

/** The offset of `timezone` at `utcMs`, in milliseconds (`-4h` for EDT). */
function offsetMsInZone(utcMs: number, timezone: string): number {
  const civil = civilInZone(utcMs, timezone);

  return (
    Date.UTC(civil.year, civil.month - 1, civil.day, civil.hour, civil.minute, civil.second) - utcMs
  );
}

/**
 * Converts a local civil time in `timezone` to the UTC instant it names.
 *
 * The offset depends on the instant, and the instant is what is being solved
 * for, so this guesses and then checks. TWO candidates are produced (the
 * offset before and after the correction), and the DST edges are decided
 * explicitly rather than left to whichever the arithmetic happened to land on:
 *
 *  - AMBIGUOUS (autumn: 01:30 happens twice) - both candidates round-trip to
 *    the requested local time and the EARLIER one is returned, so a backup
 *    scheduled at 01:30 runs once, on the first pass of the clock. The second
 *    pass is a boundary that has already been recorded, so #282's
 *    "did this boundary already run" check absorbs it.
 *  - NON-EXISTENT (spring: 02:30 never happens) - NEITHER candidate round-
 *    trips, and the LATER one is returned, which is the instant the clock
 *    jumped to. That is what makes a 02:30 daily backup run at 03:30 on the
 *    one night a year its time does not exist, instead of silently skipping
 *    the day.
 */
function zonedCivilToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string
): Date {
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const first = asIfUtc - offsetMsInZone(asIfUtc, timezone);
  const second = asIfUtc - offsetMsInZone(first, timezone);

  const matches = (candidate: number): boolean => {
    const civil = civilInZone(candidate, timezone);

    return (
      civil.year === year &&
      civil.month === month &&
      civil.day === day &&
      civil.hour === hour &&
      civil.minute === minute
    );
  };

  const valid = [first, second].filter(matches);

  return new Date(valid.length > 0 ? Math.min(...valid) : Math.max(first, second));
}

/** Parses one numeric cron field, or `null` when it is not a plain number in range. */
function parseNumericField(field: string, min: number, max: number): number | null {
  if (!/^\d{1,2}$/.test(field)) return null;

  const value = Number.parseInt(field, 10);

  return value >= min && value <= max ? value : null;
}
