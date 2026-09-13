import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// Notification centre wire types (issue #127, epic #109)
// =============================================================================
//
// The request and response shapes for the four REST endpoints that back the
// bell: list, unread count, mark one read, mark all read.
//
// NOTE WHAT IS NOT HERE: a `userId` field, on any schema, in either direction.
// Every one of these endpoints operates on the AUTHENTICATED caller's own
// rows, and the id comes from the JWT via `@CurrentUser('id')`. A user id in a
// query, a body or a path would be a value a caller could change, which is the
// definition of the IDOR this feature is built to be structurally incapable of
// — see `notification-store.service.ts`. There is nothing to omit here; the
// field never existed.
// =============================================================================

/**
 * One notification as the API sends it.
 *
 * DELIBERATELY IDENTICAL TO `NotificationStreamEvent`, plus `readAt`. A client
 * receives notifications two ways — fetched from this endpoint, or pushed over
 * SSE — and must be able to put both into the same list without a second
 * mapping. (The stream omits `readAt` only because a notification is unread by
 * definition at the instant it is published.)
 */
export const notificationSchema = z.object({
  id: z.uuid(),

  /**
   * The registry key that produced this (`security.role_changed`).
   *
   * Sent so a client can group, icon or filter by event. It is NOT what the
   * client renders — `title` and `body` are, and they were rendered server-side
   * at write time so that editing a template never rewrites what a user was
   * already told.
   */
  eventKey: z.string(),

  /** One short line. Already length-capped and rendered; render it as text. */
  title: z.string(),

  /** The detail. Plain text, never markup. */
  body: z.string(),

  /**
   * Root-relative path to open, or null.
   *
   * GUARANTEED INTERNAL: validated by `sanitizeLink` before the row was
   * written, so it is always a single leading `/` with no scheme and no
   * protocol-relative `//`. A client may navigate to it directly. That
   * guarantee is the server's to keep and it is kept on the WRITE side — see
   * that function for why sanitising on render would be the weaker place.
   */
  link: z.string().nullable(),

  /** When the user marked it read, or null while it is unread. */
  readAt: z.iso.datetime().nullable(),

  createdAt: z.iso.datetime(),
});

/** One notification, as sent. */
export type NotificationResponse = z.infer<typeof notificationSchema>;

export class NotificationDto extends createZodDto(notificationSchema) {}

/**
 * Query parameters for `GET /api/notifications`.
 *
 * Flat offset pagination, matching `GET /api/users` and `GET /api/allowlist`
 * rather than storage's nested shape — this API already has two list shapes
 * and adding a third would be worse than picking the more common one.
 */
export const notificationListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),

  /**
   * Capped at 100. The bell renders a handful; an uncapped page size on a
   * table that grows without bound is a way for any authenticated user to ask
   * the database for their entire history in one request.
   */
  pageSize: z.coerce.number().int().min(1).max(100).default(20),

  /**
   * Return only unread notifications.
   *
   * `z.coerce.boolean()` is NOT used here, and that is not a style choice:
   * it follows JavaScript truthiness, so the string `"false"` — which is
   * exactly what a client sends for `?unreadOnly=false` — coerces to `true`
   * and inverts the filter. The explicit enum accepts the two spellings a
   * query string can actually carry and rejects anything else with a 400
   * rather than guessing.
   */
  unreadOnly: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export class NotificationListQueryDto extends createZodDto(
  notificationListQuerySchema,
) {}

/** The shape `NotificationStoreService.list` returns. */
export interface NotificationListResponse {
  items: NotificationResponse[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * The badge, returned by the count endpoint AND by both mark-read endpoints.
 *
 * Returned from the writes rather than a bare `204` so that clicking a
 * notification does not cost two round trips — the client already holds the
 * row it marked, and the count is the only thing it cannot compute for itself.
 */
export const unreadCountSchema = z.object({
  unreadCount: z.number().int().min(0),
});

export type UnreadCountResponse = z.infer<typeof unreadCountSchema>;

export class UnreadCountDto extends createZodDto(unreadCountSchema) {}
