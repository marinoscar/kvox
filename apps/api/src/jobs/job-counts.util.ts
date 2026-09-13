// =============================================================================
// Folding a Prisma `groupBy` into a status breakdown (issues #264, #265)
// =============================================================================
//
// Three tiny functions, extracted for one reason: TWO services now fold the
// same `groupBy(['type', 'status'])` result into the same zero-filled shape.
// `JobAdminService.stats()` (#264) wrote them first; `JobInsightsService`
// (#265) needs byte-identical arithmetic, because its `live` block and the
// dashboard's `stats` block are rendered on the same screen and an operator
// comparing the two numbers is entitled to find them equal.
//
// A second copy would not stay identical. The interesting one is `countOf`:
// Prisma types `_count` as possibly absent, so the obvious `row._count._all`
// is a type error that a hurried second implementation "fixes" with a `!` or a
// `?? 0` in the wrong place — and `NaN` propagating through a `total` renders
// as "NaN jobs" on a dashboard, which is worse than any number it could have
// shown. Written once, it is wrong once or not at all.
//
// Not a service: none of the three touches the database, injects anything, or
// has state. They are arithmetic over a value a caller already has.
// =============================================================================

import { JOB_STATUSES, JobStatusName } from './dto/job-response.dto';
import { JobStatusCounts } from './dto/job-stats.dto';

/**
 * A fresh, fully zero-filled status breakdown.
 *
 * EVERY KEY PRESENT, including the zeroes — see `dto/job-stats.dto.ts` for
 * why: a `GROUP BY` returns no row for a status nothing is in, so the natural
 * shape of a folded result is one where `failed` is simply absent on a healthy
 * queue, and a client rendering `byStatus.failed` then shows `undefined`
 * exactly when everything is fine.
 */
export function zeroCounts(): JobStatusCounts {
  return { pending: 0, running: 0, succeeded: 0, failed: 0 };
}

/** The four counts added up. */
export function sumCounts(counts: JobStatusCounts): number {
  return JOB_STATUSES.reduce((sum, status) => sum + counts[status], 0);
}

/**
 * The `_count._all` of a `groupBy` row, defensively.
 *
 * Prisma types `_count` as possibly absent because the shape depends on the
 * argument object, which it cannot always narrow through a service boundary.
 * A missing count must read as 0 rather than propagate `NaN` through a total.
 */
export function countOf(row: { _count?: { _all?: number } | null }): number {
  const count = row._count?._all;

  return typeof count === 'number' && Number.isFinite(count) ? count : 0;
}

/**
 * Folds `groupBy({ by: ['type', 'status'] })` rows into one zero-filled
 * breakdown per type.
 *
 * Returns a `Map` rather than an array so a caller can also LOOK A TYPE UP —
 * which is what `JobInsightsService` needs for its ETA (`pending + running`
 * for one type) and what an array would turn into a linear scan per type. The
 * ordering decision (busiest first, alphabetical tie-break) is deliberately
 * left to the caller, because `stats` and `insights` publish different rows
 * from the same fold.
 */
export function foldTypeCounts(
  rows: Array<{ type: string; status: string; _count?: { _all?: number } | null }>
): Map<string, JobStatusCounts> {
  const perType = new Map<string, JobStatusCounts>();

  for (const row of rows) {
    const counts = perType.get(row.type) ?? zeroCounts();

    counts[row.status as JobStatusName] = countOf(row);
    perType.set(row.type, counts);
  }

  return perType;
}
