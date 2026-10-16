import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// Push subscription wire types (issue #229, epic #215)
// =============================================================================
//
// The request/response shapes for `POST /api/notifications/push/subscriptions`
// and `DELETE /api/notifications/push/subscriptions`. Storage only — #230 is
// what actually sends anything to these endpoints' subscriptions.
//
// NOTE WHAT IS NOT HERE: a `userId` field, on any schema, in either direction —
// same rule as `notification.dto.ts` and for the same reason. The owner of a
// subscription is always `@CurrentUser('id')`, never a client-supplied value.
// =============================================================================

/**
 * Body of `POST /api/notifications/push/subscriptions`.
 *
 * Matches the browser's `PushSubscription.toJSON()` shape exactly —
 * `{ endpoint, expirationTime, keys: { p256dh, auth } }` — so the client can
 * pass the object straight through with no reshaping.
 */
export const pushSubscribeSchema = z.object({
  /** The push service URL assigned by the browser (FCM, autopush, ...). */
  endpoint: z.string().min(1),

  keys: z.object({
    /** Base64url-encoded P-256 public key, from `getKey('p256dh')`. */
    p256dh: z.string().min(1),
    /** Base64url-encoded auth secret, from `getKey('auth')`. */
    auth: z.string().min(1),
  }),

  /**
   * Unix milliseconds from `PushSubscription.expirationTime`, or `null`/absent
   * — most push services never set one. Converted to a `Date` (or `null`) by
   * the controller before it reaches the service, since Prisma's column is
   * `timestamptz`, not a raw number.
   */
  expirationTime: z.number().nullable().optional(),
});

export type PushSubscribeRequest = z.infer<typeof pushSubscribeSchema>;

export class PushSubscribeDto extends createZodDto(pushSubscribeSchema) {}

/** A small confirmation of what was stored — not the full row. */
export const pushSubscriptionResponseSchema = z.object({
  id: z.uuid(),
  endpoint: z.string(),
  createdAt: z.iso.datetime(),
});

export type PushSubscriptionResponse = z.infer<
  typeof pushSubscriptionResponseSchema
>;

export class PushSubscriptionResponseDto extends createZodDto(
  pushSubscriptionResponseSchema,
) {}

/**
 * Body of `DELETE /api/notifications/push/subscriptions`.
 *
 * A body on a `DELETE` rather than `endpoint` as a path/query parameter: the
 * endpoint URL is long, contains `/` and other characters that would need
 * encoding to survive as a path segment, and is exactly the value the browser
 * already hands the client as part of the `PushSubscription` object being torn
 * down — passing it as JSON avoids re-encoding it into a URL at all. Fastify
 * and Nest both support a body on `DELETE`; nothing here relies on a body-less
 * `DELETE` invariant.
 */
export const pushUnsubscribeSchema = z.object({
  endpoint: z.string().min(1),
});

export type PushUnsubscribeRequest = z.infer<typeof pushUnsubscribeSchema>;

export class PushUnsubscribeDto extends createZodDto(pushUnsubscribeSchema) {}
