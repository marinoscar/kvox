// =============================================================================
// The broadcast list's filters (issue #324, epic #319)
// =============================================================================
//
// Three parameters, and deliberately only three. `page` and `pageSize` are
// copied field-for-field from `jobs/dto/job-list-query.dto.ts` — which took
// them from `users/dto/user-list-query.dto.ts` — so that every paginated list
// in this API takes the same names and enforces the same 100-row ceiling; a
// list whose page parameter is spelled differently from its neighbours is a
// client bug waiting to be written.
//
// NO FREE-TEXT SEARCH, NO DATE RANGE, NO `createdBy` FILTER. A deployment
// accumulates broadcasts at the rate an administrator writes them — a handful
// a month, not thousands a day — so "newest first, twenty at a time" is the
// whole navigation problem, and `status` is the one axis an operator actually
// asks about ("is anything still scheduled?"). Filters exist because somebody
// cannot find a row without them; adding them ahead of that is surface to
// document, test and keep working for nobody.
// =============================================================================

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { BROADCAST_STATUSES } from './broadcast-response.dto';

export const broadcastListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),

  /**
   * Restrict to one lifecycle status.
   *
   * The enum is the FULL `NotificationBroadcastStatus`, including `draft`,
   * which no route in #319 can produce. Publishing a filter vocabulary
   * narrower than the column's would mean a row that exists cannot be selected
   * — and `draft` is a real enum member that a later issue, or a direct
   * database write, can put on a row.
   */
  status: z.enum(BROADCAST_STATUSES).optional(),
});

export class BroadcastListQueryDto extends createZodDto(broadcastListQuerySchema) {}

/** The parsed, defaulted shape `BroadcastsService.list` consumes. */
export type BroadcastListQuery = z.output<typeof broadcastListQuerySchema>;
