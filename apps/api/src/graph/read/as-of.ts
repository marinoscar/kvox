// =============================================================================
// `as_of` for the graph read layer (#370; docs/specs/ontology.md §5.4, §9.1)
// =============================================================================
//
// Two halves that must say the same thing:
//
//   - `parseAsOf()` turns the `as_of` query parameter into an instant. A bare
//     date (`2024-01-15`) means `00:00:00Z` that day; a datetime must carry an
//     offset; absent means the `now` the caller passes (this file never reads
//     the clock, so a test can pin it).
//   - `relationValidAtSql()` / `itemValidAtSql()` are the SQL predicates every
//     read query embeds. They are the SQL spelling of #353's `isValidAt()`:
//     half-open `[from, to)`, a NULL range valid at every instant.
//
// `relationValidAt()` / `itemValidAt()` are the same predicates in TypeScript,
// built ON `isValidAt()` rather than beside it. `as-of.spec.ts` pins them to
// the engine, and `graph-neighborhood.db.spec.ts` runs the SQL fragments
// against real `tstzrange` values over the same fixture table — so the three
// (engine, TS mirror, SQL) cannot drift apart silently.
// =============================================================================

import { Prisma } from '@prisma/client';

import { isValidAt, type ValidRange } from '../temporal';

/** A `as_of` value that is neither `YYYY-MM-DD` nor an ISO datetime with offset. */
export class AsOfParseError extends Error {
  constructor(raw: string) {
    super(`as_of '${raw}' is not a date (YYYY-MM-DD) or an ISO 8601 datetime with an offset.`);
    this.name = 'AsOfParseError';
  }
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * The instant an `as_of` parameter names. `undefined` → `now`.
 *
 * Zod has already checked the shape at the controller; this is the backstop
 * for non-HTTP callers (#372, #377), and it rejects calendar-impossible dates
 * (`2024-02-30`) that a pattern alone would let through.
 */
export function parseAsOf(raw: string | undefined | null, now: Date): Date {
  if (raw === undefined || raw === null || raw === '') return new Date(now.getTime());

  const dateOnly = DATE_ONLY.exec(raw);
  if (dateOnly) {
    const [, y, m, d] = dateOnly.map(Number) as [number, number, number, number];
    const at = new Date(0);
    at.setUTCFullYear(y, m - 1, d);
    at.setUTCHours(0, 0, 0, 0);
    if (at.getUTCFullYear() !== y || at.getUTCMonth() !== m - 1 || at.getUTCDate() !== d) {
      throw new AsOfParseError(raw);
    }
    return at;
  }

  if (DATETIME_WITH_OFFSET.test(raw)) {
    const at = new Date(raw);
    if (!Number.isNaN(at.getTime())) return at;
  }

  throw new AsOfParseError(raw);
}

// ---------------------------------------------------------------------------
// TypeScript mirrors (for callers holding rows, and for the parity tests)
// ---------------------------------------------------------------------------

/** `(valid IS NULL OR valid @> at)` — exactly `isValidAt`. */
export function relationValidAt(valid: ValidRange | null, at: Date): boolean {
  return isValidAt(valid, at);
}

/** The relation predicate, plus `occurred_at <= at` (a fact not yet stated is not yet known). */
export function itemValidAt(item: { valid: ValidRange | null; occurredAt: Date | null }, at: Date): boolean {
  if (!isValidAt(item.valid, at)) return false;
  return item.occurredAt === null || item.occurredAt.getTime() <= at.getTime();
}

// ---------------------------------------------------------------------------
// SQL fragments
// ---------------------------------------------------------------------------

const ALIAS = /^[a-z][a-z0-9_]*$/;

function alias(name: string): Prisma.Sql {
  // Aliases are this module's callers' own literals, never request data; the
  // pattern check keeps `Prisma.raw` from ever becoming an injection point.
  if (!ALIAS.test(name)) throw new Error(`invalid SQL alias '${name}'`);
  return Prisma.raw(name);
}

/** `(r.valid IS NULL OR r.valid @> $asOf::timestamptz)` */
export function relationValidAtSql(tableAlias: string, asOf: Date): Prisma.Sql {
  const t = alias(tableAlias);
  return Prisma.sql`(${t}.valid IS NULL OR ${t}.valid @> ${asOf}::timestamptz)`;
}

/** `(i.valid IS NULL OR i.valid @> $asOf) AND (i.occurred_at IS NULL OR i.occurred_at <= $asOf)` */
export function itemValidAtSql(tableAlias: string, asOf: Date): Prisma.Sql {
  const t = alias(tableAlias);
  return Prisma.sql`((${t}.valid IS NULL OR ${t}.valid @> ${asOf}::timestamptz) AND (${t}.occurred_at IS NULL OR ${t}.occurred_at <= ${asOf}::timestamptz))`;
}
