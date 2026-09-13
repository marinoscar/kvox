// =============================================================================
// The job list's filters (issue #264, epic #254)
// =============================================================================
//
// Seven query parameters, every one of which exists because an operator with a
// misbehaving queue asks a specific question. The three that are more than a
// plain column match are documented individually below; the rest (`type`,
// `subjectType`, `subjectId`, `page`, `pageSize`) are exactly what they look
// like, and `page`/`pageSize` are copied field-for-field from
// `users/dto/user-list-query.dto.ts` so that every paginated list in this API
// takes the same names and enforces the same 100-row ceiling.
//
// -----------------------------------------------------------------------------
// `scheduled` IS A BOOLEAN THAT OVERRIDES `status`, NOT A FIFTH STATUS
// -----------------------------------------------------------------------------
//
// "In backoff" is not a status — it is a `pending` row whose `scheduled_for`
// is still in the future, which is how `job-terminal.service.ts` records a
// retry and how `provider-throttle.service.ts` records a rate-limit deferral.
// There was a real temptation to publish it as `status=scheduled`, and it was
// rejected: `status` is a database enum with four values, a filter value that
// is not one of them cannot round-trip against a row, and a client would then
// have a `status` field whose vocabulary differs from the `status` field on
// every row it receives.
//
// So it is a separate boolean, and `scheduled=true` FORCES `status=pending`
// rather than intersecting with whatever `status` was also sent. The
// alternative — honouring both, so `?scheduled=true&status=failed` returns
// nothing — is technically defensible and practically useless: the request is
// a contradiction, and answering a contradiction with an empty page tells the
// operator that no such job exists, when what is true is that no such job CAN
// exist. Overriding answers the question they meant. `JobAdminService.list`
// is where that precedence is applied, so it is one rule in one place.
//
// -----------------------------------------------------------------------------
// `processedWithin` IS AN ACTIVITY WINDOW, NOT A `createdAt` WINDOW
// -----------------------------------------------------------------------------
//
// It filters on `COALESCE(finished_at, created_at)`: when a job last did
// something, falling back to when it appeared if it has not finished. A plain
// `createdAt >= …` window would hide the single most interesting row on the
// dashboard — a job enqueued two days ago that failed ninety seconds ago —
// from the "last 4 hours" view, which is the view an operator opens while the
// incident is happening.
//
// Prisma has no `COALESCE` in a `where`, so it is expressed as the two
// disjoint cases, `{ finishedAt: { gte } }` OR `{ finishedAt: null, createdAt:
// { gte } }`. They are disjoint because the second pins `finishedAt` to null,
// so no row can match both and no row is double-counted by a `count`.
//
// `all` is the DEFAULT and is a real value rather than an absent parameter:
// an operator hunting a rare historical failure needs a way to say "no window"
// that is visible in the URL, and a dashboard needs a value to put in its
// dropdown. Making a window the default would mean the unfiltered list
// silently hides rows.
// =============================================================================

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { JOB_STATUSES } from './job-response.dto';

/** The activity windows the list offers, longest-lived value last. */
export const PROCESSED_WITHIN_VALUES = ['4h', '24h', '7d', '30d', 'all'] as const;

export type ProcessedWithin = (typeof PROCESSED_WITHIN_VALUES)[number];

/**
 * How far back each window reaches, in milliseconds.
 *
 * `all` is absent rather than mapped to `Infinity` or to `0`: the service
 * branches on "is there a window at all", and a sentinel number would invite a
 * `new Date(now - Infinity)` — an Invalid Date that Prisma sends as `NULL`,
 * which silently matches nothing.
 */
export const PROCESSED_WITHIN_MS: Readonly<Record<Exclude<ProcessedWithin, 'all'>, number>> = {
  '4h': 4 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

export const jobListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),

  status: z.enum(JOB_STATUSES).optional(),
  type: z.string().min(1).max(200).optional(),
  subjectType: z.string().min(1).max(200).optional(),
  subjectId: z.string().min(1).max(200).optional(),

  /**
   * `z.enum(['true','false']).transform(...)` and NOT `z.coerce.boolean()`.
   *
   * Every query parameter arrives as a string, and `Boolean('false')` is
   * `true` — so a coercing schema would turn the explicit opt-OUT
   * `?scheduled=false` into the opt-IN, which is the worst possible direction
   * for a filter that overrides `status`. The same reasoning, and the same
   * shape, as `notifications/dto/notification.dto.ts` and
   * `users/dto/user-list-query.dto.ts`.
   */
  scheduled: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),

  processedWithin: z.enum(PROCESSED_WITHIN_VALUES).default('all'),
});

export class JobListQueryDto extends createZodDto(jobListQuerySchema) {}

/** The parsed, defaulted shape `JobAdminService.list` consumes. */
export type JobListQuery = z.output<typeof jobListQuerySchema>;
